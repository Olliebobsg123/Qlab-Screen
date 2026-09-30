import dgram from "node:dgram";
import dns from "node:dns";
import { addressFor, lanAddresses } from "./network.js";

// A tiny name server for the show network, so the secure address (e.g. qlab-connect.duckdns.org)
// works with no internet: it answers that one name with this computer's address, and passes every
// other lookup on to a normal DNS server. Devices use it when the router hands out this computer's
// address as the DNS server.

const PORT = 53;
const TTL = 60;
const FORWARD_TIMEOUT_MS = 2500;
const TYPE_A = 1;

let socket = null;
let upstream = null;
let answeredName = "";
let status = { running: false, error: "", answered: 0, forwarded: 0, lastClient: "" };
const pending = new Map(); // forwarded id -> { id, address, port, timer }
let nextId = 1;

export function dnsStatus() {
  return { ...status, name: answeredName };
}

// name: the one name to answer; "" stops the server.
export function configureDnsServer(name) {
  answeredName = String(name || "").toLowerCase();
  if (!answeredName) return stop();
  if (socket) return;
  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", onQuery);
  socket.on("error", (error) => {
    status = { ...status, running: false, error: portError(error) };
    stop();
  });
  socket.bind(PORT, "0.0.0.0", () => {
    status = { ...status, running: true, error: "" };
  });
  upstream = dgram.createSocket("udp4");
  upstream.on("message", onUpstreamReply);
  upstream.on("error", () => {});
  upstream.bind(0);
}

function stop() {
  socket?.close();
  upstream?.close();
  socket = null;
  upstream = null;
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  status = { ...status, running: false };
}

function portError(error) {
  if (error.code === "EADDRINUSE") return "Another program on this computer is already answering name lookups (port 53).";
  if (error.code === "EACCES") return "This computer won't let QLab Connect answer name lookups (port 53 needs permission).";
  return error.message;
}

function onQuery(message, remote) {
  const question = readQuestion(message);
  if (!question) return;
  if (question.name === answeredName) {
    status.answered += 1;
    status.lastClient = remote.address;
    socket?.send(answer(message, question, question.type === TYPE_A ? addressFor(remote.address) : ""), remote.port, remote.address);
    return;
  }
  forward(message, remote);
}

// Everything else goes to a real DNS server (when there is internet).
function forward(message, remote) {
  if (!upstream) return;
  const id = nextId;
  nextId = nextId >= 0xffff ? 1 : nextId + 1;
  const timer = setTimeout(() => {
    pending.delete(id);
    socket?.send(failure(message), remote.port, remote.address);
  }, FORWARD_TIMEOUT_MS);
  pending.set(id, { id: message.readUInt16BE(0), address: remote.address, port: remote.port, timer });
  const copy = Buffer.from(message);
  copy.writeUInt16BE(id, 0);
  status.forwarded += 1;
  for (const server of upstreamServers()) upstream.send(copy, 53, server);
}

function onUpstreamReply(message) {
  if (message.length < 12) return;
  const entry = pending.get(message.readUInt16BE(0));
  if (!entry) return;
  pending.delete(message.readUInt16BE(0));
  clearTimeout(entry.timer);
  const copy = Buffer.from(message);
  copy.writeUInt16BE(entry.id, 0);
  socket?.send(copy, entry.port, entry.address);
}

// This computer's own DNS servers, minus itself (the router may point it back at us).
function upstreamServers() {
  const own = new Set(lanAddresses().map((entry) => entry.address));
  const servers = dns.getServers()
    .filter((server) => /^\d+\.\d+\.\d+\.\d+$/.test(server) && !server.startsWith("127.") && !own.has(server));
  return (servers.length ? servers : ["1.1.1.1", "8.8.8.8"]).slice(0, 2);
}

function readQuestion(message) {
  if (message.length < 12 || message.readUInt16BE(4) !== 1) return null;
  if (message[2] & 0x80) return null; // a reply, not a query
  const labels = [];
  let offset = 12;
  while (offset < message.length) {
    const length = message[offset];
    if (length === 0) break;
    if (length > 63 || offset + 1 + length > message.length) return null;
    labels.push(message.toString("latin1", offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  if (offset + 5 > message.length) return null;
  return {
    name: labels.join(".").toLowerCase(),
    type: message.readUInt16BE(offset + 1),
    end: offset + 5
  };
}

// Our answer: the address for A lookups, an empty "no such record" for anything else
// (AAAA, HTTPS…), so devices fall back to the IPv4 address.
function answer(message, question, ip) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8480 | (message.readUInt16BE(2) & 0x0100), 2); // reply, authoritative, recursion flags
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(ip ? 1 : 0, 6);
  const parts = [header, message.subarray(12, question.end)];
  if (ip) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0); // the name, pointing back at the question
    record.writeUInt16BE(TYPE_A, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(TTL, 6);
    record.writeUInt16BE(4, 10);
    ip.split(".").forEach((part, index) => record.writeUInt8(Number(part), 12 + index));
    parts.push(record);
  }
  return Buffer.concat(parts);
}

function failure(message) {
  const question = readQuestion(message);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8082 | (message.readUInt16BE(2) & 0x0100), 2); // reply, server failure
  header.writeUInt16BE(question ? 1 : 0, 4);
  return Buffer.concat([header, question ? message.subarray(12, question.end) : Buffer.alloc(0)]);
}
