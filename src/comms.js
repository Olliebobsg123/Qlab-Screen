import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocketServer } from "ws";
import { getSettings } from "./settings.js";

// Comms: talkback / intercom between departments, plus an optional show feed, in the browser.
// Audio goes straight between devices over WebRTC (Opus). This server only introduces them to each
// other (passes on offers, answers and network candidates) and keeps everyone's list of who's
// here, which channels they listen to and who is talking where. Each device decides for itself
// which incoming voices to play, so a voice on a channel you don't listen to is never heard.

const TICKET_MS = 60_000;
const ticketSecret = randomBytes(32);
const peers = new Map(); // id -> { ws, id, kind, name, deptId, color, allTalk, listen, talking, feed }
let nextId = 1;

export function commsSettings() {
  return getSettings().comms;
}

// Short-lived pass to open the comms socket (WebSockets can't carry the login header).
export function commsTicket({ kind = "user", name, deptId = "", color = "", allTalk = false }) {
  const payload = Buffer.from(JSON.stringify({ kind, name, deptId, color, allTalk, exp: Date.now() + TICKET_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readTicket(value) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return ticket.exp > Date.now() ? ticket : null;
  } catch {
    return null;
  }
}

function sign(payload) {
  return createHmac("sha256", ticketSecret).update(payload).digest("base64url");
}

export function commsStatus() {
  return {
    ...commsSettings(),
    people: [...peers.values()].map(publicPeer)
  };
}

export function attachCommsSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/comms") return;
    const ticket = readTicket(url.searchParams.get("ticket"));
    if (!commsSettings().enabled || !ticket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => join(ws, ticket, reachableAddress(request.socket.remoteAddress)));
  });
}

// The address other devices can send fast-comms audio to. A device on this computer connects from
// 127.0.0.1, which means nothing to anyone else, so use this computer's network address instead.
function reachableAddress(address) {
  const ip = String(address || "").replace(/^::ffff:/, "");
  if (ip !== "127.0.0.1" && ip !== "::1") return ip;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function join(ws, ticket, ip) {
  const peer = {
    ws,
    id: `p${nextId++}`,
    kind: ticket.kind === "feed" ? "feed" : "user",
    name: String(ticket.name || "Guest").slice(0, 40),
    deptId: ticket.deptId || "",
    color: ticket.color || "",
    allTalk: Boolean(ticket.allTalk),
    listen: [],
    talking: [],
    feed: false,
    // The desktop app's fast comms: where to send it audio directly (UDP), or null in a browser.
    native: null,
    ip,
    alive: true
  };
  peers.set(peer.id, peer);
  send(ws, { type: "welcome", id: peer.id, channels: commsSettings().channels, feedName: commsSettings().feedName });
  broadcastPeers();

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "state") {
      const channelIds = new Set(commsSettings().channels.map((channel) => channel.id));
      peer.listen = (Array.isArray(message.listen) ? message.listen : []).filter((id) => channelIds.has(id)).slice(0, 16);
      peer.talking = (Array.isArray(message.talking) ? message.talking : [])
        .filter((id) => channelIds.has(id) || (id === "*" && peer.allTalk)).slice(0, 16);
      peer.feed = Boolean(message.feed);
      const port = Number(message.nativePort);
      peer.native = Number.isInteger(port) && port > 0 && port < 65536 ? { ip: peer.ip, port } : null;
      broadcastPeers();
    } else if (message.type === "signal") {
      // Pass offers, answers and ICE candidates between two devices.
      const target = peers.get(String(message.to || ""));
      if (target) send(target.ws, { type: "signal", from: peer.id, data: message.data });
    } else if (message.type === "pong") {
      peer.alive = true;
    }
  });
  ws.on("close", () => {
    peers.delete(peer.id);
    broadcastPeers();
  });
  ws.on("error", () => ws.terminate());
}

function publicPeer(peer) {
  return {
    id: peer.id,
    kind: peer.kind,
    name: peer.name,
    deptId: peer.deptId,
    color: peer.color,
    listen: peer.listen,
    talking: peer.talking,
    feed: peer.feed,
    native: peer.native
  };
}

function broadcastPeers() {
  const list = [...peers.values()].map(publicPeer);
  for (const peer of peers.values()) send(peer.ws, { type: "peers", peers: list });
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

// Drop devices that vanished without closing (phone locked, Wi-Fi lost).
setInterval(() => {
  for (const peer of peers.values()) {
    if (!peer.alive) {
      peer.ws.terminate();
      continue;
    }
    peer.alive = false;
    send(peer.ws, { type: "ping" });
  }
}, 10_000).unref();
