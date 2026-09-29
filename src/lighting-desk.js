import dgram from "node:dgram";
import { broadcastPatch } from "./events.js";
import { encodeOsc } from "./osc.js";
import { getSettings } from "./settings.js";
import { logEvent } from "./show.js";

// Lighting desk link: when a QLab cue tagged with a desk cue number starts (e.g. named "LX 5",
// or "Thunder [LX 5]"), QLab Connect itself sends the desk an OSC GO for that cue. QLab only
// plays the cue, so this works with a free QLab licence. Made for Zero 88 ZerOS desks
// (FLX, FLX S24/S48, ZerOS 7.14+), but the OSC command can be changed for other desks.

const MAX_RECENT = 12;
let socket = null;
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
  const entry = { at: new Date().toISOString(), cue, address, source, ok: true, error: "" };
  try {
    await sendUdp(desk.host, desk.port, encodeOsc(address, []));
  } catch (error) {
    entry.ok = false;
    entry.error = error.message;
  }
  recent.unshift(entry);
  recent.length = Math.min(recent.length, MAX_RECENT);
  logEvent("lighting-desk", `${entry.ok ? "GO" : "FAILED"} desk cue ${cue} (${address})${source ? ` from ${source}` : ""}${entry.ok ? "" : `: ${entry.error}`}`);
  broadcastPatch();
  if (!entry.ok) throw Object.assign(new Error(`Could not reach the desk: ${entry.error}`), { status: 502 });
  return entry;
}

export function deskStatus() {
  return { ...deskSettings(), recent };
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
