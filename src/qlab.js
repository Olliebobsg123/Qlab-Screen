import net from "node:net";
import { QLAB_TCP_PORT } from "./config.js";
import { asArray, flattenCues } from "./cues.js";
import { broadcastChanges, broadcastPatch, broadcastSnapshot } from "./events.js";
import { decodeOsc, decodeSlip, encodeOsc, encodeSlip, parseData } from "./osc.js";
import { resetRunningTracking, recordRunningCues } from "./show.js";
import { markCuesIfChanged, setDisconnected, state } from "./state.js";

const pending = new Map();
const notesCache = new Map();
const notesInFlight = new Set();
let pollTimer = null;
let thumpTimer = null;
let qlabSocket = null;
let slipBuffer = Buffer.alloc(0);

export async function connectToQlab({ host, passcode = "", workspaceId = "" }) {
  clearTimers();
  setDisconnected({ host });
  broadcastSnapshot();

  await openQlabConnection(host);
  const workspacesReply = await query(host, "/workspaces", [], 3500);
  const workspaces = asArray(workspacesReply.data);
  const workspace = pickWorkspace(workspaces, workspaceId);

  if (!workspace?.uniqueID) {
    throw new Error("No open QLab workspace was found.");
  }

  const connectReply = await query(
    host,
    `/workspace/${workspace.uniqueID}/connect`,
    passcode ? [passcode] : [],
    6000
  );

  if (!String(connectReply.data).toLowerCase().startsWith("ok")) {
    throw new Error(`QLab rejected the passcode: ${connectReply.data || "unknown response"}.`);
  }

  Object.assign(state, {
    connected: true,
    workspaceId: workspace.uniqueID,
    workspaceName: workspace.displayName || workspace.name || workspace.uniqueID,
    lastError: ""
  });

  notesCache.clear();
  resetRunningTracking();
  await send(host, `/workspace/${state.workspaceId}/updates`, [1]);
  await refreshAll();
  await refreshStandby();
  pollTimer = setInterval(refreshAll, 1000);
  thumpTimer = setInterval(() => send(host, `/workspace/${state.workspaceId}/thump`).catch(() => {}), 15000);
}

export async function disconnectQlab() {
  const { host, workspaceId } = state;
  clearTimers();
  if (host && workspaceId) {
    await send(host, `/workspace/${workspaceId}/updates`, [0]).catch(() => {});
    await send(host, `/workspace/${workspaceId}/disconnect`).catch(() => {});
  }
  closeQlabConnection();
  setDisconnected();
  broadcastSnapshot();
}

export async function refreshAll(forceCues = false) {
  if (!state.connected || state.polling) return;
  state.polling = true;
  try {
    const shouldLoadCues = forceCues || state.cues.length === 0;
    const [cueReply, runningReply] = await Promise.all([
      shouldLoadCues ? query(state.host, `/workspace/${state.workspaceId}/cueLists`, [], 5000) : Promise.resolve(null),
      query(state.host, `/workspace/${state.workspaceId}/runningOrPausedCues`, [], 3000)
    ]);

    if (cueReply) {
      if (markCuesIfChanged(flattenCues(asArray(cueReply.data)), forceCues)) notesCache.clear();
    }

    state.running = flattenCues(asArray(runningReply.data));
    const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
    recordRunningCues(state.running, cueMap);
    await refreshTiming();
    refreshNotes();
    state.lastError = "";
  } catch (error) {
    state.lastError = error.message;
  } finally {
    state.polling = false;
    broadcastChanges();
  }
}

function refreshTiming() {
  const timing = {};
  const runningIds = state.running.map((cue) => cue.uniqueID).filter(Boolean);

  return Promise.all(runningIds.map(async (id) => {
    const base = `/workspace/${state.workspaceId}/cue_id/${id}`;
    const fields = await Promise.allSettled([
      query(state.host, `${base}/actionElapsed`, [], 1200),
      query(state.host, `${base}/currentDuration`, [], 1200),
      query(state.host, `${base}/duration`, [], 1200),
      query(state.host, `${base}/isPaused`, [], 1200)
    ]);

    const currentDuration = settledNumber(fields[1]);
    const duration = currentDuration > 0 ? currentDuration : settledNumber(fields[2]);

    timing[id] = {
      actionElapsed: settledNumber(fields[0]),
      duration,
      paused: Boolean(Number(settledData(fields[3]) || 0))
    };
  })).then(() => {
    state.time = timing;
  });
}

function settledData(result) {
  return result.status === "fulfilled" ? result.value.data : null;
}

function settledNumber(result) {
  const value = Number(settledData(result));
  return Number.isFinite(value) ? value : 0;
}

function clearTimers() {
  clearInterval(pollTimer);
  clearInterval(thumpTimer);
  pollTimer = null;
  thumpTimer = null;
}

function pickWorkspace(workspaces, requestedId) {
  if (requestedId) {
    return workspaces.find((workspace) =>
      workspace.uniqueID === requestedId ||
      workspace.displayName === requestedId ||
      workspace.name === requestedId
    );
  }
  return workspaces[0];
}

function query(host, address, args = [], timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(address);
      reject(new Error(`Timed out waiting for QLab reply to ${address}`));
    }, timeoutMs);

    pending.set(address, { resolve, reject, timeout });
    send(host, address, args).catch((error) => {
      clearTimeout(timeout);
      pending.delete(address);
      reject(error);
    });
  });
}

function send(host, address, args = []) {
  const message = encodeOsc(address, args);
  return new Promise((resolve, reject) => {
    if (!qlabSocket || qlabSocket.destroyed) {
      reject(new Error("QLab TCP connection is not open."));
      return;
    }
    qlabSocket.write(encodeSlip(message), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function openQlabConnection(host) {
  closeQlabConnection();
  slipBuffer = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: QLAB_TCP_PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out opening TCP OSC connection to ${host}:${QLAB_TCP_PORT}`));
    }, 3500);

    socket.once("connect", () => {
      clearTimeout(timeout);
      qlabSocket = socket;
      resolve();
    });

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    socket.on("data", handleTcpData);
    socket.on("close", () => {
      if (qlabSocket === socket) {
        qlabSocket = null;
        rejectPending("QLab TCP connection closed.");
      }
    });
  });
}

function closeQlabConnection() {
  if (qlabSocket && !qlabSocket.destroyed) {
    qlabSocket.end();
    qlabSocket.destroy();
  }
  qlabSocket = null;
  rejectPending("QLab TCP connection closed.");
}

function rejectPending(message) {
  for (const [address, waiter] of pending.entries()) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error(message));
    pending.delete(address);
  }
}

function handleTcpData(chunk) {
  slipBuffer = Buffer.concat([slipBuffer, chunk]);
  let endIndex;

  while ((endIndex = slipBuffer.indexOf(0xc0)) !== -1) {
    const frame = slipBuffer.subarray(0, endIndex);
    slipBuffer = slipBuffer.subarray(endIndex + 1);
    if (!frame.length) continue;

    let packet;
    try {
      packet = decodeOsc(decodeSlip(frame));
    } catch (error) {
      console.warn("Could not decode OSC packet:", error.message);
      continue;
    }

    state.lastMessageAt = new Date().toISOString();
    const reply = normalizeReply(packet);
    if (!reply) continue;

    const waiter = pending.get(reply.address);
    if (waiter) {
      clearTimeout(waiter.timeout);
      pending.delete(reply.address);
      waiter.resolve(reply);
    }
  }
}

function normalizeReply(packet) {
  if (packet.address?.startsWith("/update/")) {
    // QLab 5 sends .../playhead, QLab 4 sends .../playbackPosition; both carry the standby cue ID.
    const isPlayhead = /\/(playbackPosition|playhead)$/.test(packet.address);
    if (isPlayhead) {
      setStandby(String(packet.args[0] || ""));
    }
    const forceCues = !isPlayhead;
    refreshAll(forceCues).catch((error) => {
      state.lastError = error.message;
      broadcastPatch();
    });
    return null;
  }

  if (packet.address === "/reply" && packet.args.length >= 2) {
    const [address, status, data] = packet.args;
    return { address, status, data: parseData(data) };
  }

  if (packet.address.startsWith("/reply/")) {
    const address = packet.address.slice("/reply".length);
    const body = parseData(packet.args[0]);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return {
        address: body.address || address,
        status: body.status || "ok",
        data: body.data
      };
    }
    return { address, status: "ok", data: body };
  }

  if (pending.has(packet.address)) {
    return { address: packet.address, status: "ok", data: parseData(packet.args[0]) };
  }

  return null;
}

// --- Standby cue (the playhead) and cue notes ---

async function refreshStandby() {
  const lists = state.cues.filter((cue) => cue.depth === 0 && cue.uniqueID);
  for (const list of lists) {
    const base = `/workspace/${state.workspaceId}/cue_id/${list.uniqueID}`;
    for (const field of ["playheadId", "playbackPositionId"]) {
      try {
        const reply = await query(state.host, `${base}/${field}`, [], 1500);
        if (reply.status === "ok" && reply.data && reply.data !== "none") {
          setStandby(String(reply.data));
          return;
        }
      } catch {
        // Try the next field name / cue list.
      }
    }
  }
}

function setStandby(cueId) {
  const nextId = cueId && cueId !== "none" ? cueId : "";
  if (nextId === state.standbyId) return;
  state.standbyId = nextId;
  refreshNotes();
  broadcastPatch();
}

// Notes are fetched only for the cues screens actually show: standby and running.
function refreshNotes() {
  const wanted = new Set([state.standbyId, ...state.running.map((cue) => cue.uniqueID)].filter(Boolean));
  const notes = {};
  for (const id of wanted) {
    if (notesCache.has(id)) {
      if (notesCache.get(id)) notes[id] = notesCache.get(id);
    } else {
      loadNotes(id);
    }
  }
  state.notes = notes;
}

async function loadNotes(id) {
  if (notesInFlight.has(id) || !state.connected) return;
  notesInFlight.add(id);
  try {
    const reply = await query(state.host, `/workspace/${state.workspaceId}/cue_id/${id}/notes`, [], 1500);
    notesCache.set(id, typeof reply.data === "string" ? reply.data.trim() : "");
  } catch {
    notesCache.set(id, "");
  } finally {
    notesInFlight.delete(id);
  }
  refreshNotes();
  broadcastChanges();
}

// --- Control commands (only used when control is enabled in admin) ---

export async function sendWorkspaceCommand(path, args = []) {
  if (!state.connected || !state.workspaceId) {
    const error = new Error("Not connected to QLab.");
    error.status = 409;
    throw error;
  }

  const address = `/workspace/${state.workspaceId}${path}`;
  let reply;
  try {
    reply = await query(state.host, address, args, 1500);
  } catch (error) {
    // Some QLab versions don't reply to every command; the message itself was written.
    if (/Timed out/.test(error.message)) return { status: "sent" };
    throw error;
  }

  if (reply.status && reply.status !== "ok") {
    const error = new Error(reply.status === "denied"
      ? "QLab denied the command. The OSC passcode needs control access."
      : `QLab replied "${reply.status}" to ${path}.`);
    error.status = 502;
    throw error;
  }
  return { status: "ok", data: reply.data };
}
