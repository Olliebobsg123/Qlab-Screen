import { execFile } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import { broadcastPatch } from "./events.js";
import { encodeOsc, encodeSlip } from "./osc.js";
import { getSettings } from "./settings.js";
import { logEvent } from "./show.js";
import { registerMetaProvider, state } from "./state.js";

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
// Cues QLab Connect itself just started (GO buttons, tapping a cue), already sent to the desk.
const startedByUs = new Map();
const STARTED_BY_US_MS = 3000;
// Cue types that finish the moment they start, so they're never seen running. They only reach the
// desk when they're started from QLab Connect.
export const INSTANT_TYPES = new Set(["Memo", "Start", "Stop", "Pause", "Load", "Reset", "Devamp", "GoTo", "Goto",
  "Target", "Arm", "Disarm", "Script", "Network", "MIDI", "Text"]);

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

// What a QLab cue's tag asks the desk to do, or null. With the tag "LX":
//   LX 5 / [LX 5]      GO cue 5 on the main playback      (the OSC command set in Admin)
//   LX 2/5 / [LX 2/5]  GO cue 5 on playback 2             /zeros/cue/go/2/5
//   LXP 2              GO playback 2 (its next cue)        /zeros/playback/go/2
//   LXR 2              release playback 2                  /zeros/playback/release/2
//   LXM 3              run macro 3                         /zeros/macro/3
// Tags go at the start of the cue's name or number, or in [brackets] anywhere in the name.
const KINDS = { "": "cue", P: "playback", R: "release", M: "macro" };

export function deskActionFor(cue, prefix = deskSettings().prefix) {
  const tag = escapeRegExp(String(prefix || "").trim());
  if (!tag) return null;
  const body = `${tag}([PRM]?)\\s*(\\d+(?:\\.\\d+)?)(?:\\s*\\/\\s*(\\d+(?:\\.\\d+)?))?`;
  const start = new RegExp(`^\\s*${body}(?![\\d./])`, "i");
  const bracket = new RegExp(`\\[\\s*${body}\\s*\\]`, "i");
  for (const text of [cue?.name, cue?.number, cue?.listName]) {
    const value = String(text || "");
    const match = value.match(bracket) || value.match(start);
    if (match) return makeAction(KINDS[match[1].toUpperCase()], match[2], match[3], prefix);
  }
  return null;
}

function makeAction(kind, first, second, prefix) {
  const shown = String(prefix || "").trim().toUpperCase();
  if (kind === "cue") {
    // "LX 2/5": playback 2, cue 5. "LX 5": cue 5.
    const [playback, cue] = second ? [first, second] : ["", first];
    if (playback && !/^\d+$/.test(playback)) return null;
    return {
      kind, cue, playback,
      label: `${shown} ${playback ? `${playback}/` : ""}${cue}`,
      describe: `Cue ${cue}${playback ? ` on playback ${playback}` : ""}`
    };
  }
  // Playbacks and macros are whole numbers, with no "/".
  if (second || !/^\d+$/.test(first)) return null;
  const words = { playback: `Playback ${first} GO`, release: `Release playback ${first}`, macro: `Macro ${first}` };
  const letter = { playback: "P", release: "R", macro: "M" }[kind];
  return { kind, number: first, label: `${shown}${letter} ${first}`, describe: words[kind] };
}

// Kept for callers that only need to know whether (and how) a cue is tagged.
export function deskCueFor(cue, prefix) {
  return deskActionFor(cue, prefix)?.label || "";
}

function deskAddress(action) {
  const desk = deskSettings();
  if (action.kind === "cue") {
    return action.playback
      ? `/zeros/cue/go/${action.playback}/${action.cue}`
      : desk.command.replaceAll("{cue}", action.cue);
  }
  if (action.kind === "playback") return `/zeros/playback/go/${action.number}`;
  if (action.kind === "release") return `/zeros/playback/release/${action.number}`;
  return `/zeros/macro/${action.number}`;
}

// Called with every reading of QLab's running cues.
export function checkRunningForDesk(running) {
  const ids = new Set(running.map((cue) => cue.uniqueID).filter(Boolean));
  const previous = previousIds;
  previousIds = ids;
  if (!previous || !deskActive()) return;
  for (const cue of running) {
    if (!cue.uniqueID || previous.has(cue.uniqueID)) continue;
    if (Date.now() - (startedByUs.get(cue.uniqueID) || 0) < STARTED_BY_US_MS) continue;
    const action = deskActionFor(cue);
    if (action) {
      const label = `${cue.number ? `${cue.number} ` : ""}${cue.name || ""}`.trim();
      sendDeskAction(action, `QLab ${label}`).catch(() => {});
    }
  }
}

// QLab Connect is starting these cues (by unique ID) with run(): send the tagged ones to the desk
// once QLab accepts, including instant cues like Memo cues that would never be seen running.
// They're marked first, so the running check (which can hear back from QLab before run() returns)
// doesn't send them a second time.
export async function withDeskStart(cueIds, source, run) {
  const ids = cueIds.filter(Boolean);
  if (!deskActive() || !ids.length) return run();
  const now = Date.now();
  for (const [id, at] of startedByUs) if (now - at > STARTED_BY_US_MS) startedByUs.delete(id);
  for (const id of ids) startedByUs.set(id, now);
  let result;
  try {
    result = await run();
  } catch (error) {
    for (const id of ids) startedByUs.delete(id);
    throw error;
  }
  for (const id of ids) {
    const cue = state.cues.find((entry) => entry.uniqueID === id);
    const action = deskActionFor(cue);
    if (!action) continue;
    const label = `${cue.number ? `${cue.number} ` : ""}${cue.name || ""}`.trim();
    sendDeskAction(action, `${source}: ${label}`).catch(() => {});
  }
  return result;
}

// Every tagged cue in the workspace, so the admin can see what will fire the desk.
function taggedCues() {
  return state.cues
    .filter((cue) => cue.depth > 0)
    .map((cue) => ({ number: cue.number || "", name: cue.name || "", type: cue.type || "", action: deskActionFor(cue) }))
    .filter((cue) => cue.action)
    .map(({ action, ...cue }) => ({ ...cue, deskCue: action.label, describe: action.describe }))
    .map((cue) => ({ ...cue, instant: INSTANT_TYPES.has(cue.type) }))
    .slice(0, 300);
}

// The test button: "5", "2/5", "M3", "P2", "R2", or a full tag like "LXM 3".
export async function sendDeskGo(input, source = "") {
  const prefix = deskSettings().prefix;
  const text = String(input || "").trim();
  const tagText = new RegExp(`^${escapeRegExp(prefix)}`, "i").test(text) ? text : `${prefix}${/^\d/.test(text) ? " " : ""}${text}`;
  const action = deskActionFor({ name: tagText }, prefix);
  if (!action) throw Object.assign(new Error("Try a desk cue number like 5 or 5.5, 2/5 (cue 5 on playback 2), P2, R2 or M3."), { status: 400 });
  return sendDeskAction(action, source);
}

export async function sendDeskAction(action, source = "") {
  const desk = deskSettings();
  if (!desk.host) throw Object.assign(new Error("Set the lighting desk's IP address first."), { status: 400 });
  const address = deskAddress(action);
  const cue = action.label;
  // delivered: written into a live connection to the desk (TCP). UDP is sent but unconfirmed.
  const entry = { at: new Date().toISOString(), cue, label: action.label, describe: action.describe, address, source, ok: true, delivered: false, error: "" };
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
  logEvent("lighting-desk", `${entry.ok ? (entry.delivered ? "Delivered" : "Sent") : "FAILED"} ${action.describe} (${address})${source ? ` from ${source}` : ""}${entry.ok ? "" : `: ${entry.error}`}`);
  broadcastPatch();
  if (!entry.ok) throw Object.assign(new Error(`Could not reach the desk: ${entry.error}`), { status: 502 });
  return entry;
}

export function deskStatus() {
  return { ...deskSettings(), recent, link, tagged: taggedCues() };
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
      last: last ? { cue: last.cue, label: last.label, describe: last.describe, ok: last.ok, delivered: last.delivered, at: last.at, source: last.source } : null
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
