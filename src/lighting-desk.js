import { execFile } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import { broadcastPatch } from "./events.js";
import { encodeOsc, encodeSlip } from "./osc.js";
import { getSettings } from "./settings.js";
import { logEvent } from "./show.js";
import { registerMetaProvider } from "./state.js";

// Lighting desk link: when a QLab cue tagged with a desk cue number starts (e.g. named "LX 5",
// or "Thunder [LX 5]"), QLab Connect itself sends the desk an OSC GO for that cue. QLab only
// plays the cue, so this works with a free QLab licence. Made for Zero 88 ZerOS desks
// (FLX, FLX S24/S48, ZerOS 7.14+), but the OSC command can be changed for other desks.

const MAX_RECENT = 12;
const LINK_CHECK_MS = 3000;
let socket = null;
// How we know the desk is there. ZerOS never answers OSC, so:
// TCP: a live connection to the desk's OSC port proves its OSC receiver is listening, and each GO
//      is written straight into it. UDP: the desk answering a ping shows it's on the network.
let tcp = null;
let tcpConnecting = false;
let link = { online: false, checkedAt: 0, detail: "Not checked yet" };
let linkKey = "";
// null until the first reading after connecting to QLab: cues already running then aren't new GOs.
let previousIds = null;
const recent = [];

export function deskSettings() {
  return getSettings().lightingDesk;
}

export function deskActive() {
  const desk = deskSettings();
  return Boolean(desk.enabled && desk.host);
}

export function resetDeskTracking() {
  previousIds = null;
}

// The desk cue a QLab cue is tagged with, or "" if none.
export function deskCueFor(cue, prefix = deskSettings().prefix) {
  const tag = escapeRegExp(String(prefix || "").trim());
  if (!tag) return "";
  const number = "(\\d+(?:\\.\\d+)?)";
  // "LX 5", "LX5", "LX 5 Lights up" at the start of the name or number, or "[LX 5]" anywhere.
  const start = new RegExp(`^\\s*${tag}\\s*${number}(?![\\d.])`, "i");
  const bracket = new RegExp(`\\[\\s*${tag}\\s*${number}\\s*\\]`, "i");
  for (const text of [cue?.name, cue?.number, cue?.listName]) {
    const value = String(text || "");
    const match = value.match(bracket) || value.match(start);
    if (match) return match[1];
  }
  return "";
}

// Called with every reading of QLab's running cues.
export function checkRunningForDesk(running) {
  const ids = new Set(running.map((cue) => cue.uniqueID).filter(Boolean));
  const previous = previousIds;
  previousIds = ids;
  if (!previous || !deskActive()) return;
  for (const cue of running) {
    if (!cue.uniqueID || previous.has(cue.uniqueID)) continue;
    const deskCue = deskCueFor(cue);
    if (deskCue) {
      const label = `${cue.number ? `${cue.number} ` : ""}${cue.name || ""}`.trim();
      sendDeskGo(deskCue, `QLab ${label}`).catch(() => {});
    }
  }
}

export async function sendDeskGo(deskCue, source = "") {
  const desk = deskSettings();
  if (!desk.host) throw Object.assign(new Error("Set the lighting desk's IP address first."), { status: 400 });
  const cue = String(deskCue).trim();
  if (!/^\d+(\.\d+)?$/.test(cue)) throw Object.assign(new Error("Desk cue numbers look like 5 or 5.5."), { status: 400 });
  const address = desk.command.replaceAll("{cue}", cue);
  // delivered: written into a live connection to the desk (TCP). UDP is sent but unconfirmed.
  const entry = { at: new Date().toISOString(), cue, address, source, ok: true, delivered: false, error: "" };
  try {
    if (desk.transport === "tcp") {
      await sendTcp(encodeOsc(address, []));
      entry.delivered = true;
    } else {
      await sendUdp(desk.host, desk.port, encodeOsc(address, []));
    }
  } catch (error) {
    entry.ok = false;
    entry.error = error.message;
  }
  recent.unshift(entry);
  recent.length = Math.min(recent.length, MAX_RECENT);
  logEvent("lighting-desk", `${entry.ok ? (entry.delivered ? "GO delivered" : "GO sent") : "FAILED"} desk cue ${cue} (${address})${source ? ` from ${source}` : ""}${entry.ok ? "" : `: ${entry.error}`}`);
  broadcastPatch();
  if (!entry.ok) throw Object.assign(new Error(`Could not reach the desk: ${entry.error}`), { status: 502 });
  return entry;
}

export function deskStatus() {
  return { ...deskSettings(), recent, link };
}

// What every screen gets (department pages show a desk light).
registerMetaProvider(() => {
  const desk = deskSettings();
  if (!desk.enabled || !desk.host) return { desk: null };
  const last = recent[0];
  return {
    desk: {
      transport: desk.transport,
      online: link.online,
      detail: link.detail,
      last: last ? { cue: last.cue, ok: last.ok, delivered: last.delivered, at: last.at, source: last.source } : null
    }
  };
});

setInterval(checkLink, LINK_CHECK_MS).unref();
setTimeout(checkLink, 500).unref();

// Call after the desk settings change.
export function restartDeskLink() {
  closeTcp();
  linkKey = "";
  setLink(false, "Checking…");
  checkLink();
}

function checkLink() {
  const desk = deskSettings();
  const key = `${desk.enabled}|${desk.host}|${desk.port}|${desk.transport}`;
  if (key !== linkKey) {
    linkKey = key;
    closeTcp();
  }
  if (!desk.enabled || !desk.host) {
    setLink(false, "Off");
    return;
  }
  if (desk.transport === "tcp") {
    if (!tcp && !tcpConnecting) openTcp(desk);
  } else {
    pingDesk(desk.host);
  }
}

function setLink(online, detail) {
  const changed = link.online !== online || link.detail !== detail;
  link = { online, detail, checkedAt: Date.now() };
  if (changed) broadcastPatch();
}

function openTcp(desk) {
  tcpConnecting = true;
  const socketForDesk = net.createConnection({ host: desk.host, port: desk.port });
  socketForDesk.setNoDelay(true);
  socketForDesk.setTimeout(2500);
  socketForDesk.once("connect", () => {
    tcpConnecting = false;
    tcp = socketForDesk;
    socketForDesk.setTimeout(0);
    // Notice a desk that's switched off or unplugged within a few seconds.
    socketForDesk.setKeepAlive(true, 1000);
    setLink(true, `Connected to the desk's OSC port (TCP ${desk.port})`);
  });
  socketForDesk.on("data", () => {});
  socketForDesk.once("timeout", () => socketForDesk.destroy(new Error("no answer")));
  socketForDesk.once("error", (error) => {
    const reason = error.code === "ECONNREFUSED"
      ? "The desk refused the connection. Is OSC on, set to TCP, on this port?"
      : error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH" || error.message === "no answer"
        ? "Can't reach the desk. Is it on, on this network, with this IP address?"
        : error.message;
    setLink(false, reason);
  });
  socketForDesk.once("close", () => {
    tcpConnecting = false;
    if (tcp === socketForDesk) {
      tcp = null;
      setLink(false, "Lost the connection to the desk. Reconnecting…");
    }
  });
}

function closeTcp() {
  const old = tcp;
  tcp = null;
  tcpConnecting = false;
  old?.destroy();
}

function pingDesk(host) {
  // macOS: -t is the timeout in seconds; Linux: -W.
  const args = process.platform === "darwin" ? ["-c", "1", "-t", "1", host] : ["-c", "1", "-W", "1", host];
  execFile("ping", args, { timeout: 2500 }, (error) => {
    if (error?.code === "ENOENT") {
      setLink(false, "Can't check the desk from this computer (no ping). UDP can't confirm GOs; use TCP.");
      return;
    }
    setLink(!error, error
      ? "The desk isn't answering on the network (ping). Is it on, with this IP address?"
      : "The desk is on the network (answers ping). UDP can't confirm each GO; use TCP for that.");
  });
}

async function sendTcp(buffer) {
  // Connection dropped (desk rebooted?): try once to reconnect straight away rather than lose the GO.
  if (!tcp || tcp.destroyed) {
    if (!tcpConnecting) openTcp(deskSettings());
    const until = Date.now() + 700;
    while ((!tcp || tcp.destroyed) && tcpConnecting && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!tcp || tcp.destroyed) throw new Error("not connected to the desk (TCP)");
  const socketForDesk = tcp;
  await new Promise((resolve, reject) => {
    socketForDesk.write(encodeSlip(buffer), (error) => (error ? reject(error) : resolve()));
  });
}

function sendUdp(host, port, buffer) {
  if (!socket) {
    socket = dgram.createSocket("udp4");
    socket.on("error", () => {
      socket?.close();
      socket = null;
    });
    socket.unref();
  }
  return new Promise((resolve, reject) => {
    socket.send(buffer, port, host, (error) => (error ? reject(error) : resolve()));
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
