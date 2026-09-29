import { timingSafeEqual } from "node:crypto";
import { hasAdminAuth } from "./auth.js";
import { clearPage, sendPage } from "./paging.js";
import { withDeskStart } from "./lighting-desk.js";
import { sendWorkspaceCommand } from "./qlab.js";
import { state } from "./state.js";
import { controlSettings } from "./settings.js";
import { endInterval, endShow, logEvent, resetShow, startInterval, startShow } from "./show.js";

const GO_DEBOUNCE_MS = 350;
let lastGoAt = 0;

// Each action says whether it sends commands to QLab (and so needs control enabled).
const ACTIONS = {
  go: { qlab: true, label: "GO", run: () => goWithDebounce() },
  stop: { qlab: true, label: "Stop all", run: () => sendWorkspaceCommand("/stop") },
  hardStop: { qlab: true, label: "Hard stop", run: () => sendWorkspaceCommand("/hardStop") },
  panic: { qlab: true, label: "Panic", run: () => sendWorkspaceCommand("/panic") },
  pause: { qlab: true, label: "Pause all", run: () => sendWorkspaceCommand("/pause") },
  resume: { qlab: true, label: "Resume all", run: () => sendWorkspaceCommand("/resume") },
  next: { qlab: true, label: "Playhead next", run: () => movePlayhead("next") },
  previous: { qlab: true, label: "Playhead previous", run: () => movePlayhead("previous") },
  startCue: { qlab: true, label: "Start cue", run: (arg) => startCueByNumber(arg) },
  stopCue: { qlab: true, label: "Stop cue", run: (arg) => sendWorkspaceCommand(`/cue/${cueNumber(arg)}/stop`) },
  standby: { qlab: true, label: "Set playhead", run: (arg) => sendWorkspaceCommand(`/playhead/${cueNumber(arg)}`) },
  page: { qlab: false, label: "Page backstage", run: (arg, body, onChange) => sendPage({ ...body, text: body.text || arg }, onChange) },
  clearPage: { qlab: false, label: "Clear page", run: () => clearPage() },
  showStart: { qlab: false, label: "Start show clock", run: () => startShow() },
  showEnd: { qlab: false, label: "End show", run: () => endShow() },
  intervalStart: { qlab: false, label: "Start interval", run: (arg, body) => startInterval(body.minutes ?? arg) },
  intervalEnd: { qlab: false, label: "End interval", run: () => endInterval() },
  showReset: { qlab: false, label: "Reset show report", run: () => resetShow() }
};

export function listControlActions() {
  return Object.entries(ACTIONS).map(([id, action]) => ({ id, label: action.label, qlab: action.qlab }));
}

// Control accepts the admin login (browser pages) or the control token (Stream Deck, Companion, scripts).
export function hasControlAuth(request, url) {
  if (hasAdminAuth(request)) return true;
  const token = controlSettings().token;
  const supplied = String(request.headers["x-control-token"] || url.searchParams.get("token") || "");
  return Boolean(token) && safeEqual(supplied, token);
}

export async function runControlAction(actionId, body = {}, onChange = () => {}) {
  const action = ACTIONS[actionId];
  if (!action) throw httpError(404, `Unknown control action "${actionId}".`);
  if (action.qlab && !controlSettings().enabled) {
    throw httpError(403, "QLab control is turned off. Enable it on the admin page.");
  }

  const arg = body.arg ?? body.cue ?? "";
  const result = await action.run(arg, body, onChange);
  if (action.qlab && result?.status !== "debounced") {
    logEvent("control", `${action.label}${arg ? ` ${arg}` : ""}${body.source ? ` (${String(body.source).slice(0, 40)})` : ""}`);
  }
  return result || { status: "ok" };
}

async function startCueByNumber(arg) {
  const number = cueNumber(arg);
  const cue = state.cues.find((entry) => entry.number && entry.number === number);
  return withDeskStart([cue?.uniqueID], "Start cue", () => sendWorkspaceCommand(`/cue/${number}/start`));
}

async function goWithDebounce() {
  // Protects against a double-tap or a bouncing MIDI key firing two GOs.
  const now = Date.now();
  if (now - lastGoAt < GO_DEBOUNCE_MS) return { status: "debounced" };
  lastGoAt = now;
  return withDeskStart([state.standbyId], "GO", () => sendWorkspaceCommand("/go"));
}

async function movePlayhead(direction) {
  try {
    return await sendWorkspaceCommand(`/playhead/${direction}`);
  } catch (error) {
    if (error.status !== 502 || /denied/.test(error.message)) throw error;
    // QLab 4 name for the same command.
    return sendWorkspaceCommand(`/playbackPosition/${direction}`);
  }
}

function cueNumber(value) {
  const number = String(value || "").trim();
  if (!number || !/^[^\s/#*,?[\]{}]+$/.test(number)) {
    throw httpError(400, "A valid cue number is required.");
  }
  return number;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
