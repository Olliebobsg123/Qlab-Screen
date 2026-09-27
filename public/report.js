import { escapeHtml, formatClock, sendControl } from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const EVENT_LABELS = {
  cue: "Cue",
  control: "Remote",
  "show-start": "Show start",
  "show-end": "Show end",
  "interval-start": "Interval start",
  "interval-end": "Interval end"
};

$("#refreshButton").addEventListener("click", load);
$("#resetButton").addEventListener("click", async () => {
  if (!window.confirm("Clear the GO log and show clock? Download the CSV first if you need it.")) return;
  await sendControl("showReset").catch((error) => window.alert(error.message));
  load();
});

load();
setInterval(load, 15000);

async function load() {
  const report = await fetch("/api/admin/report", { cache: "no-store" }).then((response) => response.json());
  const started = report.startedAt ? Date.parse(report.startedAt) : null;
  const ended = report.endedAt ? Date.parse(report.endedAt) : Date.now();
  const runningSec = started ? (ended - started) / 1000 : 0;
  const intervalSec = (report.intervals || []).reduce((total, interval) =>
    total + (Date.parse(interval.endedAt) - Date.parse(interval.startedAt)) / 1000, 0);

  $("#reportTitle").textContent = report.startedAt
    ? `Show on ${new Date(report.startedAt).toLocaleDateString()}`
    : "No show recorded yet";
  $("#reportStarted").textContent = report.startedAt ? new Date(report.startedAt).toLocaleTimeString() : "-";
  $("#reportRunning").textContent = started ? `${formatClock(runningSec)}${report.endedAt ? "" : " (running)"}` : "-";
  $("#reportIntervals").textContent = report.intervals?.length
    ? `${report.intervals.length} · ${formatClock(intervalSec)}`
    : (report.intervalStartedAt ? "In interval" : "-");
  $("#reportGoCount").textContent = String(report.goCount || 0);
  $("#reportStageTime").textContent = started ? formatClock(runningSec - intervalSec) : "-";

  const rows = [...(report.log || [])].reverse();
  $("#reportRows").innerHTML = rows.length
    ? rows.map((entry) => {
      const offset = started ? formatClock((Date.parse(entry.at) - started) / 1000) : "";
      return `<tr data-kind="${escapeHtml(entry.kind)}">
        <td>${escapeHtml(new Date(entry.at).toLocaleTimeString())}</td>
        <td>${escapeHtml(offset)}</td>
        <td>${escapeHtml(EVENT_LABELS[entry.kind] || entry.kind)}</td>
        <td>${escapeHtml(entry.number || "")}</td>
        <td>${escapeHtml(entry.name || entry.detail || "")}</td>
        <td>${escapeHtml(entry.type || "")}</td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="6" class="empty">Nothing logged yet. Cues fired in QLab appear here automatically.</td></tr>`;
}
