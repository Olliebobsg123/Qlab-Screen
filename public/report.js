import { escapeHtml, formatClock, sendControl } from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const EVENT_LABELS = {
  cue: "Cue",
  control: "Remote",
  "show-start": "Show start",
  "show-end": "Show end",
  "interval-start": "Interval start",
  "interval-end": "Interval end",
  department: "Department",
  "cue-light": "Standby",
  "lighting-desk": "Lighting desk",
  note: "Note"
};
const SHOWN_PERFORMANCES = 8;
const NOTABLE_SEC = 60;
let performancesKey = "";

$("#refreshButton").addEventListener("click", load);
$("#resetButton").addEventListener("click", async () => {
  if (!window.confirm("Clear the GO log and show clock? Download the CSV first if you need it.")) return;
  await sendControl("showReset").catch((error) => window.alert(error.message));
  load();
});

load();
loadPerformances();
setInterval(load, 15000);
setInterval(loadPerformances, 30000);

$("#perfRows").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-label]");
  if (!input) return;
  await fetch(`/api/admin/performances/${input.dataset.label}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: input.value })
  });
  loadPerformances(true);
});
$("#perfRows").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button || !window.confirm("Delete this performance from the timing report?")) return;
  await fetch(`/api/admin/performances/${button.dataset.delete}`, { method: "DELETE" });
  loadPerformances(true);
});

// --- Night-by-night timings ---

async function loadPerformances(force = false) {
  const { performances = [] } = await fetch("/api/admin/performances", { cache: "no-store" }).then((response) => response.json()).catch(() => ({}));
  const key = JSON.stringify(performances.map((entry) => [entry.id, entry.label, entry.totalSec]));
  if (!force && key === performancesKey) return;
  performancesKey = key;
  renderPerformances(performances.slice(-SHOWN_PERFORMANCES));
}

const average = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
// "3:45", "1:05:10": no leading zero on the first number.
const short = (seconds) => formatClock(seconds).replace(/^0(?=\d)/, "");
const signed = (seconds) => `${seconds >= 0 ? "+" : "−"}${short(Math.abs(seconds))}`;
const diffCell = (value, avg) => {
  if (value == null) return "<td>–</td>";
  const diff = avg == null ? 0 : value - avg;
  const notable = Math.abs(diff) >= NOTABLE_SEC;
  return `<td class="${notable ? (diff > 0 ? "perf-long" : "perf-short") : ""}">${escapeHtml(short(value))}${avg != null && Math.abs(diff) >= 5 ? ` <small>${escapeHtml(signed(diff))}</small>` : ""}</td>`;
};

function renderPerformances(list) {
  if (!list.length) {
    $("#perfHead").innerHTML = "";
    $("#perfRows").innerHTML = `<tr><td class="empty">No performances saved yet. Press <strong>End show</strong> at the end of each performance and it's kept here.</td></tr>`;
    $("#perfHeadline").hidden = true;
    $("#perfDrift").hidden = true;
    $("#perfCuesBox").hidden = true;
    return;
  }
  const actCount = Math.max(...list.map((entry) => entry.acts.length));
  const intervalCount = Math.max(...list.map((entry) => entry.intervals.length));
  // Each night is compared with the average of the other nights.
  const others = (entry) => list.filter((other) => other !== entry && other.complete !== false);
  const avgOf = (entries, pick) => average(entries.map(pick).filter((value) => value != null));

  const columns = [];
  for (let index = 0; index < actCount; index += 1) {
    columns.push({ title: `Act ${index + 1}`, pick: (entry) => entry.acts[index]?.durationSec });
    if (index < intervalCount) columns.push({ title: "Interval", pick: (entry) => entry.intervals[index]?.durationSec });
  }
  columns.push({ title: "Running time", pick: (entry) => entry.runningSec });
  columns.push({ title: "Total", pick: (entry) => entry.totalSec });

  $("#perfHead").innerHTML = `<tr><th>Date</th><th>Name</th>${columns.map((column) => `<th>${column.title}</th>`).join("")}<th></th></tr>`;
  const rows = [...list].reverse().map((entry) => `
    <tr>
      <td>${escapeHtml(new Date(entry.startedAt).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))} ${escapeHtml(new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}${entry.complete === false ? ' <span class="badge warn">not ended</span>' : ""}</td>
      <td><input class="perf-label" data-label="${escapeHtml(entry.id)}" value="${escapeHtml(entry.label || "")}" placeholder="e.g. Opening night" maxlength="60"></td>
      ${columns.map((column) => diffCell(column.pick(entry), avgOf(others(entry), column.pick))).join("")}
      <td><button type="button" class="tool-button small-button" data-delete="${escapeHtml(entry.id)}" aria-label="Delete">✕</button></td>
    </tr>`);
  const complete = list.filter((entry) => entry.complete !== false);
  if (complete.length > 1) {
    rows.push(`<tr class="perf-average"><td>Average</td><td>${complete.length} shows</td>${columns.map((column) => {
      const value = avgOf(complete, column.pick);
      return `<td>${value == null ? "–" : escapeHtml(short(value))}</td>`;
    }).join("")}<td></td></tr>`);
  }
  $("#perfRows").innerHTML = rows.join("");

  const latest = list[list.length - 1];
  const rest = others(latest);
  renderHeadline(latest, rest, actCount);
  renderDrift(latest, rest);
  renderCueTable(list);
}

function renderHeadline(latest, rest, actCount) {
  const box = $("#perfHeadline");
  if (!rest.length) {
    box.hidden = true;
    return;
  }
  const parts = [];
  const running = latest.runningSec - average(rest.map((entry) => entry.runningSec));
  parts.push(`ran <strong>${Math.abs(running) < 30 ? "about average" : `${short(Math.abs(running))} ${running > 0 ? "long" : "short"}`}</strong>`);
  for (let index = 0; index < actCount; index += 1) {
    const value = latest.acts[index]?.durationSec;
    const avg = average(rest.map((entry) => entry.acts[index]?.durationSec).filter((entry) => entry != null));
    if (value == null || avg == null || Math.abs(value - avg) < 30) continue;
    parts.push(`Act ${index + 1} ${signed(value - avg)}`);
  }
  box.hidden = false;
  box.innerHTML = `The latest show (${escapeHtml(latest.label || new Date(latest.startedAt).toLocaleDateString())}) ${parts.join(", ")} compared with the average of ${rest.length} other show${rest.length === 1 ? "" : "s"}.`;
}

// Stretches between consecutive cues that ran longest compared with the other nights.
function renderDrift(latest, rest) {
  const common = Object.entries(latest.cues)
    .filter(([key]) => rest.some((entry) => entry.cues[key]))
    .sort((a, b) => a[1].at - b[1].at);
  const stretches = [];
  for (let index = 1; index < common.length; index += 1) {
    const [fromKey, from] = common[index - 1];
    const [toKey, to] = common[index];
    const gaps = rest.map((entry) => entry.cues[fromKey] && entry.cues[toKey] ? entry.cues[toKey].at - entry.cues[fromKey].at : null).filter((gap) => gap != null);
    if (!gaps.length) continue;
    stretches.push({ from, to, extra: (to.at - from.at) - average(gaps) });
  }
  const worst = stretches.filter((stretch) => Math.abs(stretch.extra) >= 20).sort((a, b) => Math.abs(b.extra) - Math.abs(a.extra)).slice(0, 5);
  $("#perfDrift").hidden = !worst.length;
  const name = (cue) => `${cue.number ? `${cue.number} ` : ""}${cue.name}`.trim();
  $("#perfDriftList").innerHTML = worst.map((stretch) => `
    <li><strong class="${stretch.extra > 0 ? "perf-long" : "perf-short"}">${escapeHtml(signed(stretch.extra))}</strong>
      between <strong>${escapeHtml(name(stretch.from))}</strong> and <strong>${escapeHtml(name(stretch.to))}</strong></li>`).join("");
}

function renderCueTable(list) {
  const keys = new Map();
  for (const entry of list) {
    for (const [key, cue] of Object.entries(entry.cues)) {
      if (!keys.has(key)) keys.set(key, { ...cue, times: [] });
      keys.get(key).times.push(cue.at);
    }
  }
  const rows = [...keys.entries()]
    .filter(([, cue]) => cue.times.length > 1)
    .sort((a, b) => average(a[1].times) - average(b[1].times));
  $("#perfCuesBox").hidden = !rows.length;
  if (!rows.length) return;
  const shown = [...list].reverse();
  $("#perfCuesHead").innerHTML = `<tr><th>Cue</th><th>Name</th>${shown.map((entry) => `<th>${escapeHtml(entry.label || new Date(entry.startedAt).toLocaleDateString([], { day: "numeric", month: "short" }))}</th>`).join("")}</tr>`;
  $("#perfCuesRows").innerHTML = rows.map(([key, cue]) => `
    <tr>
      <td>${escapeHtml(cue.number || "")}</td>
      <td>${escapeHtml(cue.name || "")}</td>
      ${shown.map((entry) => diffCell(entry.cues[key]?.at, average(list.filter((other) => other !== entry && other.cues[key]).map((other) => other.cues[key].at)))).join("")}
    </tr>`).join("");
}

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
