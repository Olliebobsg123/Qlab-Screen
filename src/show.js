import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SETTINGS_DIR } from "./config.js";
import { archivePerformance } from "./performances.js";

// Show clock, interval timer, and the GO log used for show reports.
const SHOW_PATH = process.env.QLAB_SHOW_PATH || join(SETTINGS_DIR, "show-log.json");
const MAX_LOG_ENTRIES = 5000;

const show = await loadShow();
let saveTimer = null;
// null means "not seeded yet": the first refresh after connecting only records what is
// already running, so a reconnect doesn't log those cues as new GOs.
let previousRunningIds = null;

export function publicShowState() {
  return {
    startedAt: show.startedAt,
    endedAt: show.endedAt,
    intervalStartedAt: show.intervalStartedAt,
    intervalPlannedSec: show.intervalPlannedSec,
    intervalTotalSec: show.intervals.reduce((total, interval) => total + intervalSeconds(interval), 0),
    goCount: show.log.filter((entry) => entry.kind === "cue").length,
    lastGoAt: [...show.log].reverse().find((entry) => entry.kind === "cue")?.at || null
  };
}

// Called after every QLab refresh with the current running cues.
export function recordRunningCues(running, cueMap) {
  const nextIds = new Set();
  const started = [];

  for (const cue of running) {
    if (!cue.uniqueID) continue;
    nextIds.add(cue.uniqueID);
    if (previousRunningIds && !previousRunningIds.has(cue.uniqueID)) started.push(cueMap.get(cue.uniqueID) || cue);
  }
  const seeded = previousRunningIds !== null;
  previousRunningIds = nextIds;
  if (!seeded) return false;

  const leafStarts = started.filter((cue) => cue.type !== "Cue List");
  if (!leafStarts.length) return false;

  const at = new Date().toISOString();
  if (!show.startedAt || show.endedAt) {
    // First cue after a reset (or after the previous show ended) starts a new show clock.
    if (show.endedAt) resetShowData();
    show.startedAt = at;
  }

  for (const cue of leafStarts) {
    pushLog({
      kind: "cue",
      at,
      uniqueID: cue.uniqueID,
      number: cue.number || "",
      name: cue.name || cue.listName || "",
      type: cue.type || "",
      listName: cue.listName || ""
    });
  }
  scheduleSave();
  return true;
}

export function resetRunningTracking() {
  previousRunningIds = null;
}

export function logEvent(kind, detail = "") {
  pushLog({ kind, at: new Date().toISOString(), detail: String(detail) });
  scheduleSave();
}

export function startShow() {
  // Starting again without ending the last show: keep it for the timing report anyway.
  if (show.startedAt && !show.endedAt) keepPerformance({ complete: false });
  resetShowData();
  show.startedAt = new Date().toISOString();
  logEvent("show-start");
}

export function endShow() {
  if (show.intervalStartedAt) endInterval();
  show.endedAt = new Date().toISOString();
  logEvent("show-end");
  keepPerformance();
}

function keepPerformance(options) {
  const copy = JSON.parse(JSON.stringify(show));
  archivePerformance(copy, options).catch((error) => console.warn("Could not save the performance:", error.message));
}

export function startInterval(plannedMinutes) {
  if (show.intervalStartedAt) return;
  const minutes = Number(plannedMinutes);
  show.intervalStartedAt = new Date().toISOString();
  show.intervalPlannedSec = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0;
  if (!show.startedAt) show.startedAt = show.intervalStartedAt;
  logEvent("interval-start", show.intervalPlannedSec ? `${minutes} min planned` : "");
}

export function endInterval() {
  if (!show.intervalStartedAt) return;
  const interval = { startedAt: show.intervalStartedAt, endedAt: new Date().toISOString(), plannedSec: show.intervalPlannedSec };
  show.intervals.push(interval);
  show.intervalStartedAt = null;
  show.intervalPlannedSec = 0;
  logEvent("interval-end", formatDuration(intervalSeconds(interval)));
}

export function resetShow() {
  if (show.startedAt && !show.endedAt) keepPerformance({ complete: false });
  resetShowData();
  scheduleSave();
}

export function getShowReport() {
  return {
    ...publicShowState(),
    intervals: show.intervals,
    log: show.log
  };
}

export function showReportCsv() {
  const rows = [["time", "show_clock", "kind", "cue_number", "cue_name", "cue_type", "cue_list", "detail"]];
  const startMs = show.startedAt ? Date.parse(show.startedAt) : null;
  for (const entry of show.log) {
    const offset = startMs == null ? "" : formatDuration((Date.parse(entry.at) - startMs) / 1000);
    rows.push([
      entry.at,
      offset,
      entry.kind,
      entry.number || "",
      entry.name || "",
      entry.type || "",
      entry.listName || "",
      entry.detail || ""
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function resetShowData() {
  Object.assign(show, emptyShow());
}

function pushLog(entry) {
  show.log.push(entry);
  if (show.log.length > MAX_LOG_ENTRIES) show.log.splice(0, show.log.length - MAX_LOG_ENTRIES);
}

function intervalSeconds(interval) {
  const end = interval.endedAt ? Date.parse(interval.endedAt) : Date.now();
  return Math.max(0, (end - Date.parse(interval.startedAt)) / 1000);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  // Prefix formula-like cells so spreadsheet apps don't execute cue names as formulas.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function emptyShow() {
  return {
    startedAt: null,
    endedAt: null,
    intervalStartedAt: null,
    intervalPlannedSec: 0,
    intervals: [],
    log: []
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveShow().catch((error) => console.warn("Could not save show log:", error.message));
  }, 1000);
}

async function saveShow() {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SHOW_PATH, `${JSON.stringify(show)}\n`, "utf8");
}

async function loadShow() {
  try {
    const saved = JSON.parse(await readFile(SHOW_PATH, "utf8"));
    return {
      ...emptyShow(),
      ...saved,
      intervals: Array.isArray(saved.intervals) ? saved.intervals : [],
      log: Array.isArray(saved.log) ? saved.log : []
    };
  } catch {
    return emptyShow();
  }
}
