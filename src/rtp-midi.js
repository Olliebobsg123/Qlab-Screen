import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { RTP_MIDI_PORT } from "./config.js";
import { sendMidiBytes } from "./midi-out.js";
import { controlSettings, updateControlSettings } from "./settings.js";

// A network MIDI (RTP-MIDI / AppleMIDI) session named "QLab Connect". iPhone apps such as midimittr,
// Macs and rtpMIDI on Windows can connect to it; the MIDI they send is played out of the same MIDI
// output as the browser pass-through, so QLab's MIDI triggers fire. The session is announced over
// Bonjour so devices find it without typing an address.
//
// It also works the other way round: other network MIDI sessions (such as the one midimittr starts
// on an iPhone) are discovered, and this server can connect to them, like the "Connect" button in
// Audio MIDI Setup. Connecting outwards avoids the Mac's firewall blocking incoming invitations.
const SESSION_NAME = "QLab Connect";
const PARTICIPANT_TIMEOUT_MS = 90_000;

const ssrc = randomBytes(4).readUInt32BE(0);
const participants = new Map();
let controlSocket = null;
let dataSocket = null;
let advertiser = null;
let status = { running: false, error: "", advertised: false, port: RTP_MIDI_PORT };
let lastMessage = null;
let messagesReceived = 0;
let sweepTimer = null;
let browser = null;
const discovered = new Map();
const outgoing = new Map();
const pendingInvites = new Map();
const INVITE_ATTEMPTS = 3;
const INVITE_TIMEOUT_MS = 1500;
const SYNC_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 5000;

export async function startRtpMidi() {
  if (!RTP_MIDI_PORT) return;
  // A Mac's own Audio MIDI Setup session usually holds 5004/5005, so step up to the next free pair.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = RTP_MIDI_PORT + attempt * 2;
    const results = await Promise.allSettled([bindSocket(port, false), bindSocket(port + 1, true)]);
    if (results.every((result) => result.status === "fulfilled")) {
      [controlSocket, dataSocket] = results.map((result) => result.value);
      status = { ...status, running: true, error: "", port };
      console.log(`Network MIDI session "${SESSION_NAME}" on UDP ${port}/${port + 1}`);
      advertise(port);
      startDiscovery();
      // Devices saved by address reconnect now; ones saved by name reconnect when Bonjour finds them.
      for (const name of autoNames().filter(isAddress)) connectNetworkMidi(name, { remember: false });
      sweepTimer = setInterval(sweepParticipants, 15_000);
      sweepTimer.unref();
      process.once("exit", stopAdvertising);
      return;
    }
    // Release whichever half did bind before trying the next pair.
    for (const result of results) if (result.status === "fulfilled") result.value.close();
  }
  status = { ...status, running: false, error: `Network MIDI unavailable: UDP ports ${RTP_MIDI_PORT}-${RTP_MIDI_PORT + 11} are in use.` };
  console.warn(status.error);
}

function bindSocket(port, isData) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => {
      try {
        socket.close();
      } catch {
        // Never bound.
      }
      reject(error);
    });
    socket.bind(port, () => {
      socket.removeAllListeners("error");
      socket.on("error", (error) => console.warn(`Network MIDI socket error: ${error.message}`));
      socket.on("message", (message, remote) => handlePacket(message, remote, socket, isData));
      resolve(socket);
    });
  });
}

export function rtpMidiStatus() {
  const names = new Set([...discovered.keys(), ...outgoing.keys()]);
  return {
    ...status,
    sessionName: SESSION_NAME,
    discoverySupported: process.platform === "darwin",
    discovered: Array.from(names).sort().map((name) => ({
      name,
      visible: discovered.has(name),
      state: outgoing.get(name)?.state || "idle",
      error: outgoing.get(name)?.error || "",
      auto: autoNames().includes(name)
    })),
    participants: Array.from(participants.values()).map((participant) => ({
      name: participant.name,
      address: participant.address,
      connectedAt: participant.connectedAt,
      lastSeenAt: new Date(participant.lastSeen).toISOString()
    })),
    messagesReceived,
    lastMessage
  };
}

function handlePacket(message, remote, socket, isData) {
  if (message.length >= 4 && message.readUInt16BE(0) === 0xffff) {
    handleCommand(message, remote, socket, isData);
    return;
  }
  if (isData && message.length > 12 && (message[0] & 0xc0) === 0x80) {
    handleRtpMidi(message, remote);
  }
}

// AppleMIDI session commands: IN (invite), BY (bye), CK (clock sync), RS (receiver feedback).
function handleCommand(message, remote, socket, isData) {
  const command = message.toString("ascii", 2, 4);

  if (command === "IN" && message.length >= 16) {
    const token = message.readUInt32BE(8);
    const remoteSsrc = message.readUInt32BE(12);
    const name = readName(message, 16) || remote.address;
    const reply = Buffer.concat([
      header("OK"),
      uint32(2),
      uint32(token),
      uint32(ssrc),
      Buffer.from(`${SESSION_NAME}\0`, "utf8")
    ]);
    socket.send(reply, remote.port, remote.address);
    const existing = participants.get(remoteSsrc);
    participants.set(remoteSsrc, {
      name,
      address: remote.address,
      connectedAt: existing?.connectedAt || new Date().toISOString(),
      lastSeen: Date.now(),
      dataPort: isData ? remote.port : existing?.dataPort
    });
    if (isData) console.log(`Network MIDI: "${name}" connected from ${remote.address}`);
    return;
  }

  if ((command === "OK" || command === "NO") && message.length >= 16) {
    const token = message.readUInt32BE(8);
    const waiter = pendingInvites.get(token);
    if (!waiter || waiter.socket !== socket) return;
    pendingInvites.delete(token);
    clearTimeout(waiter.timer);
    if (command === "OK") {
      waiter.resolve({ ssrc: message.readUInt32BE(12), name: readName(message, 16) });
    } else {
      waiter.reject(Object.assign(new Error("The device declined the connection."), { declined: true }));
    }
    return;
  }

  if (command === "BY" && message.length >= 16) {
    const remoteSsrc = message.readUInt32BE(12);
    const participant = participants.get(remoteSsrc);
    if (participant) console.log(`Network MIDI: "${participant.name}" disconnected`);
    participants.delete(remoteSsrc);
    handleOutgoingLost(remoteSsrc);
    return;
  }

  if (command === "CK" && message.length >= 36) {
    const remoteSsrc = message.readUInt32BE(4);
    touch(remoteSsrc);
    const count = message[8];
    if (count === 0) {
      // Answer the initiator's first timestamp with ours; it sends the third and final one.
      const reply = Buffer.alloc(36);
      reply.writeUInt16BE(0xffff, 0);
      reply.write("CK", 2, "ascii");
      reply.writeUInt32BE(ssrc, 4);
      reply[8] = 1;
      message.copy(reply, 12, 12, 20);
      reply.writeBigUInt64BE(now100us(), 20);
      socket.send(reply, remote.port, remote.address);
    } else if (count === 1) {
      // We started this sync (outgoing connection): finish it with the third timestamp.
      const reply = Buffer.from(message);
      reply.writeUInt32BE(ssrc, 4);
      reply[8] = 2;
      reply.writeBigUInt64BE(now100us(), 28);
      socket.send(reply, remote.port, remote.address);
    }
    return;
  }

  if (command === "RS" && message.length >= 8) {
    touch(message.readUInt32BE(4));
  }
}

// RTP header, then the MIDI command section (RFC 6295). The recovery journal is ignored.
function handleRtpMidi(packet, remote) {
  const remoteSsrc = packet.readUInt32BE(8);
  if (!participants.has(remoteSsrc)) return;
  touch(remoteSsrc);

  let offset = 12;
  const flags = packet[offset];
  const longHeader = Boolean(flags & 0x80);
  const firstHasDelta = Boolean(flags & 0x20);
  let length = flags & 0x0f;
  if (longHeader) {
    length = (length << 8) | packet[offset + 1];
    offset += 2;
  } else {
    offset += 1;
  }
  const end = Math.min(packet.length, offset + length);
  let runningStatus = 0;
  let first = true;

  while (offset < end) {
    if (!first || firstHasDelta) {
      // Delta time: up to 4 bytes, high bit means another byte follows.
      for (let index = 0; index < 4 && offset < end; index += 1) {
        const byte = packet[offset];
        offset += 1;
        if (!(byte & 0x80)) break;
      }
    }
    first = false;
    if (offset >= end) break;

    let status = packet[offset];
    if (status & 0x80) {
      offset += 1;
    } else if (runningStatus) {
      status = runningStatus;
    } else {
      break;
    }

    if (status === 0xf0 || status === 0xf7) {
      // Skip SysEx (and its segments) up to the terminating F0/F7.
      while (offset < end && packet[offset] !== 0xf7 && packet[offset] !== 0xf0) offset += 1;
      offset += 1;
      continue;
    }

    const size = dataLength(status);
    const message = [status, ...packet.subarray(offset, offset + size)];
    offset += size;
    if (status < 0xf0) runningStatus = status;
    forward(message, remoteSsrc);
  }
}

function forward(message, remoteSsrc) {
  if (message[0] === 0xf8 || message[0] === 0xfe) return;
  messagesReceived += 1;
  lastMessage = {
    from: participants.get(remoteSsrc)?.name || "",
    bytes: message,
    at: new Date().toISOString(),
    error: ""
  };
  try {
    sendMidiBytes(message);
  } catch (error) {
    lastMessage.error = error.message;
  }
}

function dataLength(status) {
  const kind = status & 0xf0;
  if (kind === 0xc0 || kind === 0xd0) return 1;
  if (kind >= 0x80 && kind <= 0xe0) return 2;
  if (status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf2) return 2;
  return 0;
}

function touch(remoteSsrc) {
  const participant = participants.get(remoteSsrc);
  if (participant) participant.lastSeen = Date.now();
}

function sweepParticipants() {
  const cutoff = Date.now() - PARTICIPANT_TIMEOUT_MS;
  for (const [key, participant] of participants) {
    if (participant.lastSeen < cutoff) {
      participants.delete(key);
      handleOutgoingLost(key);
    }
  }
}

// --- Outgoing connections to other sessions (e.g. midimittr on an iPhone) ---

export async function connectNetworkMidi(name, { remember = true } = {}) {
  const target = String(name || "").trim();
  if (!target) throw httpError(400, "Choose a device to connect to.");
  if (!controlSocket || !dataSocket) throw httpError(503, status.error || "The network MIDI session isn't running.");
  if (remember && !autoNames().includes(target)) await setAutoNames([...autoNames(), target]);

  const current = outgoing.get(target);
  if (current?.state === "connecting" || current?.state === "connected") return rtpMidiStatus();
  const entry = { state: "connecting", error: "", ssrc: null, syncTimer: null, retryTimer: null };
  outgoing.set(target, entry);

  try {
    const { address, port } = await resolveTarget(target);
    const token = randomBytes(4).readUInt32BE(0);
    await invite(controlSocket, address, port, token);
    const accepted = await invite(dataSocket, address, port + 1, token);
    if (outgoing.get(target) !== entry) return rtpMidiStatus();
    entry.state = "connected";
    entry.ssrc = accepted.ssrc;
    entry.address = address;
    entry.port = port;
    participants.set(accepted.ssrc, {
      name: target,
      address,
      connectedAt: new Date().toISOString(),
      lastSeen: Date.now(),
      dataPort: port + 1,
      controlPort: port,
      outgoing: true
    });
    console.log(`Network MIDI: connected to "${target}" at ${address}:${port}`);
    const sync = () => sendClockSync(address, port + 1);
    sync();
    setTimeout(sync, 1000).unref();
    entry.syncTimer = setInterval(sync, SYNC_INTERVAL_MS);
    entry.syncTimer.unref();
  } catch (error) {
    entry.state = "failed";
    entry.error = error.message;
    scheduleReconnect(target, entry);
  }
  return rtpMidiStatus();
}

export async function disconnectNetworkMidi(name) {
  const target = String(name || "");
  await setAutoNames(autoNames().filter((entry) => entry !== target));
  const entry = outgoing.get(target);
  outgoing.delete(target);
  if (entry) {
    clearInterval(entry.syncTimer);
    clearTimeout(entry.retryTimer);
    if (entry.ssrc != null) {
      participants.delete(entry.ssrc);
      const bye = Buffer.concat([header("BY"), uint32(2), uint32(0), uint32(ssrc)]);
      controlSocket?.send(bye, entry.port, entry.address);
    }
  }
  return rtpMidiStatus();
}

function handleOutgoingLost(remoteSsrc) {
  for (const [name, entry] of outgoing) {
    if (entry.ssrc !== remoteSsrc) continue;
    clearInterval(entry.syncTimer);
    entry.state = "disconnected";
    entry.ssrc = null;
    scheduleReconnect(name, entry);
  }
}

function scheduleReconnect(name, entry) {
  if (!autoNames().includes(name)) return;
  clearTimeout(entry.retryTimer);
  entry.retryTimer = setTimeout(() => {
    if (outgoing.get(name) !== entry) return;
    outgoing.delete(name);
    if (discovered.has(name) || isAddress(name)) connectNetworkMidi(name, { remember: false });
  }, RECONNECT_DELAY_MS);
  entry.retryTimer.unref();
}

function invite(socket, address, port, token) {
  const packet = Buffer.concat([header("IN"), uint32(2), uint32(token), uint32(ssrc), Buffer.from(`${SESSION_NAME}\0`, "utf8")]);
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      if (attempts > INVITE_ATTEMPTS) {
        pendingInvites.delete(token);
        reject(new Error(`No answer from ${address}:${port}. Is the app open on the device, and on the same Wi-Fi?`));
        return;
      }
      socket.send(packet, port, address);
      const timer = setTimeout(attempt, INVITE_TIMEOUT_MS);
      pendingInvites.set(token, { socket, resolve, reject, timer });
    };
    attempt();
  });
}

function sendClockSync(address, port) {
  const packet = Buffer.alloc(36);
  packet.writeUInt16BE(0xffff, 0);
  packet.write("CK", 2, "ascii");
  packet.writeUInt32BE(ssrc, 4);
  packet[8] = 0;
  packet.writeBigUInt64BE(now100us(), 12);
  dataSocket?.send(packet, port, address);
}

// "name" is either a Bonjour session name or "address:port" typed by hand.
async function resolveTarget(name) {
  if (isAddress(name)) {
    const [host, port] = name.split(/:(?=\d+$)/);
    const { address } = await lookup(host, { family: 4 });
    return { address, port: Number(port) || 5004 };
  }
  const { host, port } = await resolveService(name);
  const { address } = await lookup(host, { family: 4 });
  return { address, port };
}

function isAddress(name) {
  return /^[\w.-]+(:\d+)?$/.test(name) && /\d+\.\d+\.\d+\.\d+|\.local\b|:\d+$/.test(name);
}

function resolveService(name) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("Finding devices by name needs macOS. Enter the device's address instead."));
      return;
    }
    const child = spawn("dns-sd", ["-L", name, "_apple-midi._udp", "local"]);
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Couldn't find "${name}" on the network.`));
    }, 4000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/can be reached at (\S+?)\.?:(\d+)\s/);
      if (!match) return;
      clearTimeout(timer);
      child.kill();
      resolve({ host: match[1], port: Number(match[2]) });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Watch Bonjour for other network MIDI sessions (macOS only).
function startDiscovery() {
  if (process.platform !== "darwin") return;
  try {
    browser = spawn("dns-sd", ["-B", "_apple-midi._udp", "local"]);
  } catch {
    return;
  }
  let buffer = "";
  browser.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) handleBrowseLine(line);
  });
  browser.on("error", () => {
    browser = null;
  });
  browser.on("exit", () => {
    browser = null;
  });
}

function handleBrowseLine(line) {
  // "20:20:52.803  Add        3  11 local.   _apple-midi._udp.    iPhone"
  const match = line.match(/^\S+\s+(Add|Rmv)\s+\d+\s+(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/);
  if (!match) return;
  const [, action, iface, name] = match;
  if (name === SESSION_NAME) return;
  const interfaces = discovered.get(name) || new Set();
  if (action === "Add") {
    interfaces.add(iface);
    discovered.set(name, interfaces);
    if (autoNames().includes(name) && !["connecting", "connected"].includes(outgoing.get(name)?.state)) {
      outgoing.delete(name);
      connectNetworkMidi(name, { remember: false });
    }
  } else {
    interfaces.delete(iface);
    if (!interfaces.size) discovered.delete(name);
  }
}

function autoNames() {
  return controlSettings().networkMidiAuto || [];
}

function setAutoNames(names) {
  return updateControlSettings({ networkMidiAuto: Array.from(new Set(names)).slice(0, 20) });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.status = statusCode;
  return error;
}

// Bonjour: macOS has dns-sd built in; Linux uses Avahi when installed.
function advertise(port) {
  const [command, args] = process.platform === "darwin"
    ? ["dns-sd", ["-R", SESSION_NAME, "_apple-midi._udp", "local", String(port)]]
    : process.platform === "linux"
      ? ["avahi-publish-service", [SESSION_NAME, "_apple-midi._udp", String(port)]]
      : [null, []];
  if (!command) return;

  try {
    advertiser = spawn(command, args, { stdio: "ignore" });
    advertiser.on("spawn", () => {
      status = { ...status, advertised: true };
    });
    advertiser.on("error", () => {
      status = { ...status, advertised: false };
      advertiser = null;
    });
    advertiser.on("exit", () => {
      status = { ...status, advertised: false };
      advertiser = null;
    });
  } catch {
    advertiser = null;
  }
}

function stopAdvertising() {
  advertiser?.kill();
  browser?.kill();
}

function header(command) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(0xffff, 0);
  buffer.write(command, 2, "ascii");
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function readName(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString("utf8", offset, end === -1 ? buffer.length : end).slice(0, 80);
}

function now100us() {
  return process.hrtime.bigint() / 100_000n;
}
