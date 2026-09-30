import { execFile } from "node:child_process";
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
const TYPE_AAAA = 28;
let ipv6 = "";

// The computer's global IPv6 address (network.js primaryIPv6), for AAAA lookups of the name.
export function setDnsIpv6(address) {
  ipv6 = address || "";
}

let socket = null;
let upstream = null;
let answeredName = "";
let status = { running: false, error: "", answered: 0, forwarded: 0, lastClient: "", upstream: "", upstreamOk: null, failed: 0 };
let gateway = "";
let checkTimer = null;
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
  findGateway();
  clearInterval(checkTimer);
  checkTimer = setInterval(checkUpstream, 60000);
  checkTimer.unref();
  setTimeout(checkUpstream, 1500).unref();
}

// The router's address, which always answers lookups on its own network.
function findGateway() {
  const done = (error, stdout) => {
    const match = !error && String(stdout).match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)|default\s+via\s+(\d+\.\d+\.\d+\.\d+)|0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
    gateway = match ? match[1] || match[2] || match[3] : "";
  };
  if (process.platform === "darwin") execFile("route", ["-n", "get", "default"], { timeout: 3000 }, done);
  else if (process.platform === "win32") execFile("route", ["print", "0.0.0.0"], { timeout: 3000 }, done);
  else execFile("ip", ["route", "show", "default"], { timeout: 3000 }, done);
}

// Can we reach a real DNS server? (Shown in Admin; "no" usually just means no internet.)
function checkUpstream() {
  if (!upstream) return;
  findGateway();
  const probe = Buffer.from("abcd01000001000000000000076578616d706c6503636f6d0000010001", "hex");
  const id = nextId;
  nextId = nextId >= 0xffff ? 1 : nextId + 1;
  probe.writeUInt16BE(id, 0);
  const timer = setTimeout(() => {
    pending.delete(id);
    status.upstreamOk = false;
  }, FORWARD_TIMEOUT_MS);
  pending.set(id, { probe: true, timer });
  for (const server of upstreamServers()) upstream.send(probe, 53, server);
}

function stop() {
  socket?.close();
  upstream?.close();
  socket = null;
  upstream = null;
  clearInterval(checkTimer);
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
    const address = question.type === TYPE_A ? addressFor(remote.address) : question.type === TYPE_AAAA ? ipv6 : "";
    socket?.send(answer(message, question, address, question.type), remote.port, remote.address);
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
    status.failed += 1;
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
  status.upstreamOk = true;
  if (entry.probe) return;
  const copy = Buffer.from(message);
  copy.writeUInt16BE(entry.id, 0);
  socket?.send(copy, entry.port, entry.address);
}

// Where other lookups go: this computer's own DNS servers (minus itself: the router may point it
// back at us), the router, then public ones. Asked all at once; the first answer wins.
function upstreamServers() {
  const own = new Set(lanAddresses().map((entry) => entry.address));
  const candidates = [...dns.getServers(), gateway, "1.1.1.1", "8.8.8.8"]
    .filter((server) => /^\d+\.\d+\.\d+\.\d+$/.test(server || "") && !server.startsWith("127.") && !own.has(server));
  const list = [...new Set(candidates)].slice(0, 4);
  status.upstream = list.join(", ");
  return list;
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
function answer(message, question, ip, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8480 | (message.readUInt16BE(2) & 0x0100), 2); // reply, authoritative, recursion flags
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(ip ? 1 : 0, 6);
  const parts = [header, message.subarray(12, question.end)];
  if (ip) {
    const data = type === TYPE_AAAA ? ipv6Bytes(ip) : Buffer.from(ip.split(".").map(Number));
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0); // the name, pointing back at the question
    record.writeUInt16BE(type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(TTL, 6);
    record.writeUInt16BE(data.length, 10);
    parts.push(record, data);
  }
  return Buffer.concat(parts);
}

function ipv6Bytes(address) {
  const [head, tail = ""] = address.split("::");
  const groups = (part) => (part ? part.split(":") : []);
  const missing = 8 - groups(head).length - groups(tail).length;
  const all = [...groups(head), ...Array(address.includes("::") ? missing : 0).fill("0"), ...groups(tail)];
  const bytes = Buffer.alloc(16);
  all.slice(0, 8).forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16) || 0, index * 2));
  return bytes;
}

function failure(message) {
  const question = readQuestion(message);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8082 | (message.readUInt16BE(2) & 0x0100), 2); // reply, server failure
  header.writeUInt16BE(question ? 1 : 0, 4);
  return Buffer.concat([header, question ? message.subarray(12, question.end) : Buffer.alloc(0)]);
}
