import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { RTP_MIDI_PORT } from "./config.js";
import { sendMidiBytes } from "./midi-out.js";

// A network MIDI (RTP-MIDI / AppleMIDI) session named "QLab Connect". iPhone apps such as midimittr,
// Macs and rtpMIDI on Windows can connect to it; the MIDI they send is played out of the same MIDI
// output as the browser pass-through, so QLab's MIDI triggers fire. The session is announced over
// Bonjour so devices find it without typing an address.
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
  return {
    ...status,
    sessionName: SESSION_NAME,
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

  if (command === "BY" && message.length >= 16) {
    const remoteSsrc = message.readUInt32BE(12);
    const participant = participants.get(remoteSsrc);
    if (participant) console.log(`Network MIDI: "${participant.name}" disconnected`);
    participants.delete(remoteSsrc);
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
    if (participant.lastSeen < cutoff) participants.delete(key);
  }
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
