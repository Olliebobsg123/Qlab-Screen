import net from "node:net";
import { QLAB_TCP_PORT } from "./config.js";
import { asArray, flattenCues } from "./cues.js";
import { broadcastChanges, broadcastPatch, broadcastSnapshot } from "./events.js";
import { decodeOsc, decodeSlip, encodeOsc, encodeSlip, parseData } from "./osc.js";
import { resetRunningTracking, recordRunningCues } from "./show.js";
import { markCuesIfChanged, setDisconnected, state } from "./state.js";

const pending = new Map();
const notesCache = new Map();
const staleNotes = new Set();
const notesInFlight = new Set();
// Playhead per cue list; the screens show the one for the list the operator is working in.
const playheads = new Map();
let activeListId = "";
let playheadField = "";
let refreshQueued = { queued: false, forceCues: false };
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
  staleNotes.clear();
  playheads.clear();
  activeListId = "";
  playheadField = "";
  resetRunningTracking();
  await send(host, `/workspace/${state.workspaceId}/updates`, [1]);
  await refreshAll();
  await refreshAllPlayheads();
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
  if (!state.connected) return;
  if (state.polling) {
    // Don't drop updates that arrive mid-poll: run once more when this poll finishes.
    refreshQueued = { queued: true, forceCues: refreshQueued.forceCues || forceCues };
    return;
  }
  state.polling = true;
  try {
    const shouldLoadCues = forceCues || state.cues.length === 0;
    const [cueReply, runningReply] = await Promise.all([
      shouldLoadCues ? query(state.host, `/workspace/${state.workspaceId}/cueLists`, [], 5000) : Promise.resolve(null),
      query(state.host, `/workspace/${state.workspaceId}/runningOrPausedCues`, [], 3000)
    ]);

    if (cueReply) {
      markCuesIfChanged(flattenCues(asArray(cueReply.data)));
    }

    state.running = flattenCues(asArray(runningReply.data));
    const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
    recordRunningCues(state.running, cueMap);
    await Promise.all([refreshTiming(), refreshActivePlayhead()]);
    refreshNotes();
    state.lastError = "";
  } catch (error) {
    state.lastError = error.message;
  } finally {
    state.polling = false;
    broadcastChanges();
    if (refreshQueued.queued) {
      const { forceCues: queuedForce } = refreshQueued;
      refreshQueued = { queued: false, forceCues: false };
      refreshAll(queuedForce).catch(() => {});
    }
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

// Waiters are queued per address so two identical queries in flight each get a reply.
function query(host, address, args = [], timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timeout: null };
    const remove = () => {
      const queue = pending.get(address);
      if (!queue) return;
      const index = queue.indexOf(waiter);
      if (index !== -1) queue.splice(index, 1);
      if (!queue.length) pending.delete(address);
    };
    waiter.timeout = setTimeout(() => {
      remove();
      reject(new Error(`Timed out waiting for QLab reply to ${address}`));
    }, timeoutMs);

    if (!pending.has(address)) pending.set(address, []);
    pending.get(address).push(waiter);
    send(host, address, args).catch((error) => {
      clearTimeout(waiter.timeout);
      remove();
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
  for (const [address, queue] of pending.entries()) {
    for (const waiter of queue) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(message));
    }
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

    const queue = pending.get(reply.address);
    const waiter = queue?.shift();
    if (queue && !queue.length) pending.delete(reply.address);
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(reply);
    }
  }
}

function normalizeReply(packet) {
  if (packet.address?.startsWith("/update/")) {
    // QLab 5 sends .../playhead, QLab 4 sends .../playbackPosition; both carry the standby cue ID.
    const playheadMatch = packet.address.match(/\/cueList\/([^/]+)\/(playbackPosition|playhead)$/);
    if (playheadMatch) {
      // The operator moved this list's playhead, so it's the list to show.
      activeListId = playheadMatch[1];
      setListPlayhead(playheadMatch[1], String(packet.args[0] ?? ""));
    }
    const cueMatch = packet.address.match(/\/cue_id\/([^/]+)$/);
    if (cueMatch) staleNotes.add(cueMatch[1]);
    const forceCues = !playheadMatch;
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

function cueLists() {
  return state.cues.filter((cue) => cue.depth === 0 && cue.uniqueID);
}

// Ask QLab where one cue list's playhead is. QLab 5 calls it playheadId, QLab 4 playbackPositionId.
async function queryPlayhead(listId) {
  const base = `/workspace/${state.workspaceId}/cue_id/${listId}`;
  const fields = playheadField ? [playheadField] : ["playheadId", "playbackPositionId"];
  for (const field of fields) {
    try {
      const reply = await query(state.host, `${base}/${field}`, [], 1500);
      if (reply.status && reply.status !== "ok") continue;
      playheadField = field;
      return { ok: true, cueId: typeof reply.data === "string" ? reply.data : "" };
    } catch {
      // Try the other field name.
    }
  }
  return { ok: false, cueId: "" };
}

async function refreshAllPlayheads() {
  for (const list of cueLists()) {
    const result = await queryPlayhead(list.uniqueID);
    if (result.ok) playheads.set(list.uniqueID, normalizeCueId(result.cueId));
  }
  if (!activeListId) {
    // Start on the first list that has a playhead (carts don't).
    activeListId = cueLists().find((list) => playheads.get(list.uniqueID))?.uniqueID || cueLists()[0]?.uniqueID || "";
  }
  applyStandby();
}

// Polled every refresh so the standby cue corrects itself even if an update message was missed.
async function refreshActivePlayhead() {
  if (!activeListId && cueLists().length) activeListId = cueLists()[0].uniqueID;
  if (!activeListId) return;
  const result = await queryPlayhead(activeListId);
  if (result.ok) {
    playheads.set(activeListId, normalizeCueId(result.cueId));
    applyStandby();
  }
}

function setListPlayhead(listId, cueId) {
  playheads.set(listId, normalizeCueId(cueId));
  applyStandby();
}

function applyStandby() {
  const nextId = playheads.get(activeListId) || "";
  if (nextId === state.standbyId) return;
  state.standbyId = nextId;
  refreshNotes();
  broadcastPatch();
}

function normalizeCueId(cueId) {
  const value = String(cueId || "");
  return value && value !== "none" ? value : "";
}

// Notes are fetched only for the cues screens actually show: standby and running.
function refreshNotes() {
  const wanted = new Set([state.standbyId, ...state.running.map((cue) => cue.uniqueID)].filter(Boolean));
  const notes = {};
  for (const id of wanted) {
    // Keep showing the old notes while a changed cue's notes are re-read.
    if (notesCache.get(id)) notes[id] = notesCache.get(id);
    if (!notesCache.has(id) || staleNotes.has(id)) loadNotes(id);
  }
  state.notes = notes;
}

async function loadNotes(id) {
  if (notesInFlight.has(id) || !state.connected) return;
  notesInFlight.add(id);
  try {
    staleNotes.delete(id);
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
