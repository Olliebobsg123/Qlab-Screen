import net from "node:net";
import { QLAB_TCP_PORT } from "./config.js";
import { asArray, flattenCues } from "./cues.js";
import { broadcastChanges, broadcastPatch, broadcastSnapshot } from "./events.js";
import { decodeOsc, decodeSlip, encodeOsc, encodeSlip, parseData } from "./osc.js";
import { checkRunningForDesk, deskActive, resetDeskTracking } from "./lighting-desk.js";
import { resetRunningTracking, recordRunningCues } from "./show.js";
import { markCuesIfChanged, setDisconnected, state } from "./state.js";

const pending = new Map();
// Three independent loops, so one slow or unanswered question can't hold up the others:
// what's running (and cue list changes), running cue timing, and cue list playheads.
const POLL_MS = 500;
// With the lighting desk link on, check what's running much more often, so a tagged cue's
// desk GO follows QLab's GO closely.
const DESK_POLL_MS = 80;
let lastPollAt = 0;
const TIMING_MS = 250;
// New, renamed or deleted cues show up within about half a second, even if QLab doesn't announce them.
// Fetching every cue is QLab's heaviest question, and it shares the line with GO commands, so it
// is asked less often while cues are playing or just after a command, and less often again if
// this workspace is slow to describe (so a big show never keeps QLab busy).
const CUE_LIST_MS = 500;
const CUE_LIST_BUSY_MS = 3000;
const CUE_LIST_TICK_MS = 100;
let nextCueListAt = 0;
let lastCueListMs = 0;
let lastCommandAt = 0;
const PLAYHEAD_MS = 1000;
const PLAYHEAD_BACKOFF_MS = 30_000;
let openWorkspaces = [];
let connectInfo = { reply: "", connectedAt: 0, updates: 0 };
const extraNoteIds = [];

// Lets other modules (departments) ask for notes on the cues they show.
export function registerNoteIds(provider) {
  extraNoteIds.push(provider);
}
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
let timingTimer = null;
let playheadTimer = null;
let timingBusy = false;
let cueListTimer = null;
let cueListBusy = false;
// Reconnect automatically if QLab restarts or the network drops, until someone disconnects on purpose.
let lastConnection = null;
let reconnectTimer = null;
const RECONNECT_MS = 3000;
let playheadBusy = false;
// Durations rarely change, so they're read in the background and cached, not on every tick.
const durations = new Map();
const durationsInFlight = new Set();
// Cue lists that didn't answer a playhead question (e.g. carts) are left alone for a while.
const playheadBackoff = new Map();
let qlabSocket = null;
let slipBuffer = Buffer.alloc(0);

export async function connectToQlab(connection) {
  const { host, passcode = "", workspaceId = "" } = connection;
  clearTimeout(reconnectTimer);
  // Kept as the same object so keepConnected() can tell its own retries apart from a new connection.
  lastConnection = connection;
  clearTimers();
  setDisconnected({ host });
  broadcastSnapshot();

  await openQlabConnection(host);
  const workspacesReply = await query(host, "/workspaces", [], 3500);
  const workspaces = asArray(workspacesReply.data);
  openWorkspaces = workspaces.map(describeWorkspace);
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
  // QLab 5 answers e.g. "ok:view|edit|control", which tells us what the passcode allows.
  connectInfo = { reply: String(connectReply.data), connectedAt: Date.now(), updates: 0 };

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
  resetDeskTracking();
  // Plain commands (GO, start, stop) get no answer unless asked for one, which left every
  // button waiting for a reply that never came.
  await send(host, "/alwaysReply", [1]).catch(() => {});
  await send(host, `/workspace/${state.workspaceId}/updates`, [1]);
  await refreshAll();
  await refreshAllPlayheads();
  // Twice a second; screens count smoothly in between using the timestamps on each reading.
  pollTimer = setInterval(() => {
    if (deskActive() || Date.now() - lastPollAt >= POLL_MS - DESK_POLL_MS / 2) refreshAll();
  }, DESK_POLL_MS);
  nextCueListAt = 0;
  cueListTimer = setInterval(refreshCueLists, CUE_LIST_TICK_MS);
  timingTimer = setInterval(refreshTiming, TIMING_MS);
  playheadTimer = setInterval(refreshActivePlayhead, PLAYHEAD_MS);
  thumpTimer = setInterval(() => send(host, `/workspace/${state.workspaceId}/thump`).catch(() => {}), 15000);
}

// Keep trying to connect (at startup before QLab is open, or after losing the connection).
export function keepConnected(connection) {
  lastConnection = connection;
  clearTimeout(reconnectTimer);
  connectToQlab(connection).catch((error) => {
    state.lastError = `${error.message} Retrying…`;
    broadcastSnapshot();
    if (lastConnection === connection) reconnectTimer = setTimeout(() => keepConnected(connection), RECONNECT_MS);
  });
}

export async function disconnectQlab() {
  lastConnection = null;
  clearTimeout(reconnectTimer);
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
  lastPollAt = Date.now();
  try {
    const shouldLoadCues = forceCues || state.cues.length === 0;
    const [cueReply, runningReply] = await Promise.all([
      shouldLoadCues ? query(state.host, `/workspace/${state.workspaceId}/cueLists`, [], 5000) : Promise.resolve(null),
      query(state.host, `/workspace/${state.workspaceId}/runningOrPausedCues`, [], 1500)
    ]);

    if (cueReply) {
      markCuesIfChanged(flattenCues(asArray(cueReply.data)));
    }

    state.running = flattenCues(asArray(runningReply.data));
    checkRunningForDesk(state.running);
    const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
    recordRunningCues(state.running, cueMap);
    // Drop timing for cues that stopped, and get a reading for new ones straight away.
    const runningIds = new Set(state.running.map((cue) => cue.uniqueID));
    if (Object.keys(state.time).some((id) => !runningIds.has(id))) {
      state.time = Object.fromEntries(Object.entries(state.time).filter(([id]) => runningIds.has(id)));
    }
    if (state.running.some((cue) => !state.time[cue.uniqueID])) refreshTiming();
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

// Elapsed time and pause state for running cues, four times a second. Each reading is stamped
// with when QLab answered, so screens can count on smoothly from it.
async function refreshTiming() {
  if (!state.connected || timingBusy) return;
  const ids = state.running.map((cue) => cue.uniqueID).filter(Boolean);
  if (!ids.length) {
    if (Object.keys(state.time).length) {
      state.time = {};
      broadcastChanges();
    }
    return;
  }

  timingBusy = true;
  try {
    const next = {};
    await Promise.all(ids.map(async (id) => {
      const base = `/workspace/${state.workspaceId}/cue_id/${id}`;
      const askedAt = Date.now();
      let answeredAt = askedAt;
      const [elapsed, paused] = await Promise.allSettled([
        query(state.host, `${base}/actionElapsed`, [], 800).then((reply) => {
          answeredAt = Date.now();
          return reply;
        }),
        query(state.host, `${base}/isPaused`, [], 800)
      ]);
      ensureDuration(id);
      const previous = state.time[id];
      if (elapsed.status !== "fulfilled") {
        // No answer this time: keep the last reading so screens keep counting from it.
        if (previous) next[id] = { ...previous, duration: durations.get(id)?.value || previous.duration };
        return;
      }
      next[id] = {
        actionElapsed: settledNumber(elapsed),
        duration: durations.get(id)?.value || previous?.duration || 0,
        paused: paused.status === "fulfilled" ? Boolean(Number(paused.value.data || 0)) : Boolean(previous?.paused),
        at: Math.round((askedAt + answeredAt) / 2)
      };
    }));
    // Only keep cues that are still running (one may have stopped while we were asking).
    const stillRunning = new Set(state.running.map((cue) => cue.uniqueID));
    state.time = Object.fromEntries(Object.entries(next).filter(([id]) => stillRunning.has(id)));
  } finally {
    timingBusy = false;
    broadcastChanges();
  }
}

// Read a cue's duration in the background (and again every few seconds, as it can change).
function ensureDuration(id) {
  const cached = durations.get(id);
  if ((cached && Date.now() - cached.at < 5000) || durationsInFlight.has(id)) return;
  durationsInFlight.add(id);
  const base = `/workspace/${state.workspaceId}/cue_id/${id}`;
  Promise.allSettled([
    query(state.host, `${base}/currentDuration`, [], 1500),
    query(state.host, `${base}/duration`, [], 1500)
  ]).then(([current, fallback]) => {
    const value = settledNumber(current) > 0 ? settledNumber(current) : settledNumber(fallback);
    durations.set(id, { value, at: Date.now() });
  }).finally(() => durationsInFlight.delete(id));
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
  clearInterval(timingTimer);
  clearInterval(playheadTimer);
  clearInterval(cueListTimer);
  cueListTimer = null;
  pollTimer = null;
  thumpTimer = null;
  timingTimer = null;
  playheadTimer = null;
  durations.clear();
  playheadBackoff.clear();
}

function describeWorkspace(workspace) {
  return {
    id: workspace.uniqueID,
    name: workspace.displayName || workspace.name || workspace.uniqueID
  };
}

// What the app is actually receiving from QLab, for the admin page: open workspaces and
// how many cues of each type each cue list holds.
export async function qlabDiagnostics() {
  if (state.connected) {
    try {
      const reply = await query(state.host, "/workspaces", [], 2500);
      openWorkspaces = asArray(reply.data).map(describeWorkspace);
    } catch {
      // Keep the list from when we connected.
    }
  }
  const lists = state.cues.filter((cue) => cue.depth === 0).map((list) => {
    const types = {};
    let count = 0;
    const ids = new Set([list.uniqueID]);
    for (const cue of state.cues) {
      if (!ids.has(cue.parentId)) continue;
      ids.add(cue.uniqueID);
      count += 1;
      types[cue.type || "Unknown"] = (types[cue.type || "Unknown"] || 0) + 1;
    }
    return { id: list.uniqueID, name: list.name || list.listName || "Cue list", type: list.type, count, types };
  });
  return {
    connected: state.connected,
    workspaceId: state.workspaceId,
    workspaceName: state.workspaceName,
    openWorkspaces,
    lists
  };
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
        handleConnectionLost();
      }
    });
  });
}

function handleConnectionLost() {
  if (!state.connected || !lastConnection) return;
  const connection = lastConnection;
  clearTimers();
  setDisconnected({ host: connection.host, lastError: "Lost the connection to QLab. Reconnecting…" });
  broadcastSnapshot();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => keepConnected(connection), RECONNECT_MS);
}

// Re-read every cue list twice a second; screens only get a new list when something changed.
async function refreshCueLists() {
  if (!state.connected || cueListBusy || Date.now() < nextCueListAt) return;
  cueListBusy = true;
  const startedAt = Date.now();
  try {
    const reply = await query(state.host, `/workspace/${state.workspaceId}/cueLists`, [], 5000);
    if (markCuesIfChanged(flattenCues(asArray(reply.data)))) broadcastChanges();
  } catch {
    // Try again next round.
  } finally {
    cueListBusy = false;
    lastCueListMs = Date.now() - startedAt;
    const showBusy = state.running.length > 0 || Date.now() - lastCommandAt < CUE_LIST_BUSY_MS;
    nextCueListAt = Date.now() + Math.max(showBusy ? CUE_LIST_BUSY_MS : CUE_LIST_MS, lastCueListMs * 10);
  }
}

// QLab said something changed: fetch the cue list soon, but not in the middle of a burst of GOs.
function requestCueListRefresh() {
  const soon = Date.now() + Math.max(250, lastCueListMs * 4);
  if (Date.now() - lastCommandAt < 1000) return;
  nextCueListAt = Math.min(nextCueListAt, soon);
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
    connectInfo.updates += 1;
    // QLab 5 sends .../playhead, QLab 4 sends .../playbackPosition; both carry the standby cue ID.
    const playheadMatch = packet.address.match(/\/cueList\/([^/]+)\/(playbackPosition|playhead)$/);
    if (playheadMatch) {
      // The operator moved this list's playhead, so it's the list to show.
      activeListId = playheadMatch[1];
      setListPlayhead(playheadMatch[1], String(packet.args[0] ?? ""));
    }
    const cueMatch = packet.address.match(/\/cue_id\/([^/]+)$/);
    if (cueMatch) staleNotes.add(cueMatch[1]);
    // QLab also announces cues starting and stopping, so don't re-read every cue straight away.
    if (!playheadMatch) requestCueListRefresh();
    refreshAll().catch((error) => {
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
      const reply = await query(state.host, `${base}/${field}`, [], 800);
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
  for (const list of cueLists().filter((entry) => entry.type !== "Cue Cart")) {
    const result = await queryPlayhead(list.uniqueID);
    if (result.ok) playheads.set(list.uniqueID, normalizeCueId(result.cueId));
  }
  if (!activeListId) {
    // Start on the first list that has a playhead (carts don't).
    activeListId = cueLists().find((list) => playheads.get(list.uniqueID))?.uniqueID || cueLists()[0]?.uniqueID || "";
  }
  applyStandby();
}

// Polled every refresh so standby cues correct themselves even if an update message was missed.
// Every cue list is polled (departments each follow their own list); workspaces have only a few.
async function refreshActivePlayhead() {
  if (!state.connected || playheadBusy) return;
  if (!activeListId && cueLists().length) activeListId = cueLists()[0].uniqueID;
  const now = Date.now();
  // Carts have no playhead, and lists that didn't answer recently are skipped for a while.
  const lists = cueLists()
    .filter((list) => list.type !== "Cue Cart" && (playheadBackoff.get(list.uniqueID) || 0) <= now)
    .slice(0, 12);
  playheadBusy = true;
  try {
    const results = await Promise.all(lists.map((list) => queryPlayhead(list.uniqueID)));
    lists.forEach((list, index) => {
      if (results[index].ok) {
        playheads.set(list.uniqueID, normalizeCueId(results[index].cueId));
        playheadBackoff.delete(list.uniqueID);
      } else {
        playheadBackoff.set(list.uniqueID, Date.now() + PLAYHEAD_BACKOFF_MS);
      }
    });
    applyStandby();
  } finally {
    playheadBusy = false;
  }
}

// One property of one cue (e.g. its duration), for the department cue panel.
export async function queryCueValue(cueId, field) {
  if (!state.connected) return null;
  const reply = await query(state.host, `/workspace/${state.workspaceId}/cue_id/${cueId}/${field}`, [], 1500);
  return reply.status && reply.status !== "ok" ? null : reply.data;
}

// For the QLab check in Admin.
export function connectionInfo() {
  return { ...connectInfo, playheadField };
}

export function rawQuery(path, args = [], timeoutMs = 1500) {
  if (!state.connected) return Promise.reject(new Error("Not connected to QLab."));
  const address = path.startsWith("/workspace/") || path === "/version" ? path : `/workspace/${state.workspaceId}${path}`;
  return query(state.host, address, args, timeoutMs);
}

export function listPlayhead(listId) {
  return playheads.get(listId) || "";
}

// Move one cue list's playhead to a cue (QLab 5 playheadId, QLab 4 playbackPositionId).
export async function setPlayhead(listId, cueId) {
  const field = playheadField || "playheadId";
  await sendWorkspaceCommand(`/cue_id/${listId}/${field}`, [cueId]);
  setListPlayhead(listId, cueId);
}

function setListPlayhead(listId, cueId) {
  playheads.set(listId, normalizeCueId(cueId));
  applyStandby();
}

function applyStandby() {
  const nextId = playheads.get(activeListId) || "";
  const nextPlayheads = Object.fromEntries(playheads);
  if (nextId === state.standbyId && JSON.stringify(nextPlayheads) === JSON.stringify(state.playheads)) return;
  state.standbyId = nextId;
  state.playheads = nextPlayheads;
  refreshNotes();
  broadcastPatch();
}

function normalizeCueId(cueId) {
  const value = String(cueId || "");
  return value && value !== "none" ? value : "";
}

// Notes are fetched only for the cues screens actually show: standby and running.
function refreshNotes() {
  const wanted = new Set([
    ...extraNoteIds.flatMap((provider) => provider()),
    state.standbyId,
    ...Object.values(state.playheads || {}),
    ...state.running.map((cue) => cue.uniqueID)
  ].filter(Boolean));
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
  lastCommandAt = Date.now();
  let reply;
  try {
    reply = await query(state.host, address, args, 500);
  } catch (error) {
    // Some QLab versions don't reply to every command; the message itself was written.
    if (/Timed out/.test(error.message)) {
      refreshAll().catch(() => {});
      return { status: "sent" };
    }
    throw error;
  } finally {
    lastCommandAt = Date.now();
  }
  // Show what the command started or stopped straight away rather than at the next check.
  refreshAll().catch(() => {});

  if (reply.status && reply.status !== "ok") {
    const error = new Error(reply.status === "denied"
      ? "QLab denied the command. The OSC passcode needs control access."
      : `QLab replied "${reply.status}" to ${path}.`);
    error.status = 502;
    throw error;
  }
  return { status: "ok", data: reply.data };
}
