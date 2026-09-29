import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SETTINGS_DIR } from "./config.js";

// Past performances, kept when each show ends, so the report can compare nights: act and interval
// lengths, and when each cue was reached in running time (intervals left out, so a long interval
// doesn't make every Act 2 cue look late).
const PERFORMANCES_PATH = process.env.QLAB_PERFORMANCES_PATH || join(SETTINGS_DIR, "performances.json");
const MAX_PERFORMANCES = 80;
const MIN_ARCHIVE_SEC = 5 * 60;

const performances = await load();

export function listPerformances() {
  return performances;
}

// show: { startedAt, endedAt, intervals: [{ startedAt, endedAt, plannedSec }], log: [...] }
export async function archivePerformance(show, { complete = true } = {}) {
  if (!show?.startedAt) return null;
  const startMs = Date.parse(show.startedAt);
  const lastLog = show.log.length ? Date.parse(show.log[show.log.length - 1].at) : startMs;
  const endMs = show.endedAt ? Date.parse(show.endedAt) : lastLog;
  if ((endMs - startMs) / 1000 < MIN_ARCHIVE_SEC) return null;

  const intervals = show.intervals
    .filter((interval) => interval.startedAt && interval.endedAt)
    .map((interval) => ({ startMs: Date.parse(interval.startedAt), endMs: Date.parse(interval.endedAt), plannedSec: interval.plannedSec || 0 }))
    .sort((a, b) => a.startMs - b.startMs);

  // Acts: show start → first interval, between intervals, last interval → show end.
  const acts = [];
  let actStart = startMs;
  for (const interval of intervals) {
    acts.push({ label: `Act ${acts.length + 1}`, durationSec: round((interval.startMs - actStart) / 1000) });
    actStart = interval.endMs;
  }
  acts.push({ label: `Act ${acts.length + 1}`, durationSec: round((endMs - actStart) / 1000) });

  // When each cue was first reached, in running time (time since the start, minus intervals).
  const runningAt = (ms) => {
    let seconds = (ms - startMs) / 1000;
    for (const interval of intervals) {
      if (ms >= interval.endMs) seconds -= (interval.endMs - interval.startMs) / 1000;
      else if (ms > interval.startMs) seconds -= (ms - interval.startMs) / 1000;
    }
    return round(seconds);
  };
  const actAt = (ms) => intervals.filter((interval) => ms >= interval.endMs).length;
  const cues = {};
  for (const entry of show.log) {
    if (entry.kind !== "cue") continue;
    const key = entry.number ? `#${entry.number}` : entry.uniqueID;
    if (!key || cues[key]) continue;
    const ms = Date.parse(entry.at);
    cues[key] = { number: entry.number || "", name: entry.name || "", at: runningAt(ms), act: actAt(ms) };
  }

  const intervalSec = intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs) / 1000, 0);
  const performance = {
    id: `${startMs.toString(36)}`,
    label: "",
    startedAt: show.startedAt,
    endedAt: new Date(endMs).toISOString(),
    complete,
    totalSec: round((endMs - startMs) / 1000),
    runningSec: round((endMs - startMs) / 1000 - intervalSec),
    acts,
    intervals: intervals.map((interval) => ({ durationSec: round((interval.endMs - interval.startMs) / 1000), plannedSec: interval.plannedSec })),
    cues
  };
  const existing = performances.findIndex((entry) => entry.id === performance.id);
  if (existing !== -1) {
    performance.label = performances[existing].label;
    performances[existing] = performance;
  } else {
    performances.push(performance);
  }
  performances.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (performances.length > MAX_PERFORMANCES) performances.splice(0, performances.length - MAX_PERFORMANCES);
  await save();
  return performance;
}

export async function updatePerformance(id, { label }) {
  const performance = performances.find((entry) => entry.id === id);
  if (!performance) throw Object.assign(new Error("That performance isn't saved."), { status: 404 });
  performance.label = String(label ?? "").trim().slice(0, 60);
  await save();
  return performance;
}

export async function deletePerformance(id) {
  const index = performances.findIndex((entry) => entry.id === id);
  if (index === -1) throw Object.assign(new Error("That performance isn't saved."), { status: 404 });
  performances.splice(index, 1);
  await save();
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function save() {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(PERFORMANCES_PATH, `${JSON.stringify(performances)}\n`, "utf8");
}

async function load() {
  try {
    const saved = JSON.parse(await readFile(PERFORMANCES_PATH, "utf8"));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}
