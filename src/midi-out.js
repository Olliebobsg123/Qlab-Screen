import { WebSocketServer } from "ws";
import { timingSafeEqual } from "node:crypto";
import { hasAdminAuth } from "./auth.js";
import { controlSettings, updateControlSettings } from "./settings.js";

// MIDI pass-through: browsers send raw MIDI from a keyboard on any device, and this server plays it
// out of a MIDI port so QLab's own MIDI triggers fire. By default that is a virtual port named
// "QLab Connect" that QLab sees when this server runs on the QLab Mac. Any other output, such as a
// macOS Network MIDI session, can be picked instead.
export const VIRTUAL_PORT = "virtual";
const VIRTUAL_PORT_NAME = "QLab Connect";
const WS_PATH = "/midi-ws";

let midi = null;
let loadError = "";
let output = null;
let openName = "";
let openError = "";
let messagesSent = 0;
let lastSentAt = null;

export async function initMidiOutput() {
  try {
    const module = await import("@julusian/midi");
    midi = module.default || module;
  } catch (error) {
    loadError = `MIDI output library not available: ${error.message}`;
    return;
  }
  openSelectedOutput();
}

export function midiOutputStatus() {
  return {
    available: Boolean(midi) && !loadError,
    error: loadError || openError,
    ports: listPorts(),
    selected: controlSettings().midiOutput,
    virtualName: VIRTUAL_PORT_NAME,
    virtualSupported: process.platform !== "win32",
    open: Boolean(output),
    openName,
    messagesSent,
    lastSentAt
  };
}

export async function selectMidiOutput(port) {
  await updateControlSettings({ midiOutput: String(port || VIRTUAL_PORT) });
  openSelectedOutput();
  return midiOutputStatus();
}

export function sendMidiBytes(bytes) {
  if (!controlSettings().enabled) throw httpError(403, "QLab control is turned off. Enable it on the admin page.");
  if (!output) throw httpError(503, openError || loadError || "No MIDI output is open.");
  const message = validateMessage(bytes);
  output.sendMessage(message);
  messagesSent += 1;
  lastSentAt = new Date().toISOString();
}

export function attachMidiSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== WS_PATH) {
      // /comms is handled by src/comms.js on the same server.
      if (url.pathname !== "/comms") socket.destroy();
      return;
    }
    if (!hasSocketAuth(request, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleSocket(ws));
  });
}

function handleSocket(ws) {
  ws.send(JSON.stringify({ type: "status", ...socketStatus() }));
  ws.on("message", (data) => {
    let payload;
    try {
      payload = JSON.parse(String(data));
    } catch {
      return;
    }
    const messages = Array.isArray(payload.batch) ? payload.batch.slice(0, 64) : [payload.m];
    for (const message of messages) {
      try {
        sendMidiBytes(message);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: error.message }));
        return;
      }
    }
  });
}

function socketStatus() {
  return {
    controlEnabled: controlSettings().enabled,
    open: Boolean(output),
    openName,
    error: loadError || openError
  };
}

function openSelectedOutput() {
  if (!midi) return;
  closeOutput();
  openError = "";
  const selected = controlSettings().midiOutput || VIRTUAL_PORT;

  try {
    const next = new midi.Output();
    if (selected === VIRTUAL_PORT) {
      if (process.platform === "win32") {
        next.closePort?.();
        openError = "Windows can't create virtual MIDI ports. Install loopMIDI, create a port, and select it here.";
        return;
      }
      next.openVirtualPort(VIRTUAL_PORT_NAME);
      openName = `${VIRTUAL_PORT_NAME} (virtual port)`;
    } else {
      const index = portNames(next).indexOf(selected);
      if (index === -1) {
        next.closePort?.();
        openError = `MIDI output "${selected}" is not connected.`;
        return;
      }
      next.openPort(index);
      openName = selected;
    }
    output = next;
    console.log(`MIDI pass-through output: ${openName}`);
  } catch (error) {
    openError = `Could not open MIDI output: ${error.message}`;
  }
}

function closeOutput() {
  if (!output) return;
  try {
    output.closePort();
  } catch {
    // Already closed.
  }
  output = null;
  openName = "";
}

function listPorts() {
  if (!midi) return [];
  try {
    const probe = new midi.Output();
    const names = portNames(probe);
    probe.closePort?.();
    return names;
  } catch {
    return [];
  }
}

function portNames(port) {
  const names = [];
  for (let index = 0; index < port.getPortCount(); index += 1) names.push(port.getPortName(index));
  // Our own virtual port shows up in the list on macOS; sending to it would loop back.
  return names.filter((name) => !name.includes(VIRTUAL_PORT_NAME));
}

// Channel voice messages only (notes, aftertouch, CC, program change, pitch bend) plus
// start/continue/stop. SysEx and anything malformed are refused.
function validateMessage(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 1 || bytes.length > 3) throw httpError(400, "Invalid MIDI message.");
  const message = bytes.map((byte) => Number(byte));
  if (message.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw httpError(400, "Invalid MIDI bytes.");
  const [status] = message;
  const kind = status & 0xf0;
  const lengths = { 0x80: 3, 0x90: 3, 0xa0: 3, 0xb0: 3, 0xc0: 2, 0xd0: 2, 0xe0: 3 };
  if (status >= 0x80 && status < 0xf0) {
    if (message.length !== lengths[kind] || message.slice(1).some((byte) => byte > 127)) {
      throw httpError(400, "Invalid MIDI message length.");
    }
    return message;
  }
  if ([0xfa, 0xfb, 0xfc].includes(status) && message.length === 1) return message;
  throw httpError(400, "Only note, controller, program change, pitch bend and transport messages are passed through.");
}

function hasSocketAuth(request, url) {
  if (hasAdminAuth(request)) return true;
  const token = controlSettings().token;
  const supplied = String(url.searchParams.get("token") || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
