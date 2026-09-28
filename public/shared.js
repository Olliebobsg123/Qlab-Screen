// Helpers shared by the monitor and TV dashboard: department filters, standby/notes,
// show clock, countdown warnings and the backstage paging overlay.

export const DEPARTMENTS = {
  sound: { label: "Sound", types: ["Audio", "Mic", "Fade", "MIDI File"], pattern: /\b(SQ|SND|FX|SFX)\b/i },
  lighting: { label: "Lighting", types: ["Light"], pattern: /\b(LX|LQ)\b/i },
  video: { label: "Video", types: ["Video", "Camera", "Text", "Fade"], pattern: /\b(VQ|VID|VIDEO|PROJ)\b/i },
  stage: { label: "Stage", types: ["Memo"], pattern: /\b(SM|DSM|FLY|FLYS|STAGE|RAIL)\b/i },
  show: { label: "Show control", types: ["Network", "MIDI", "OSC", "Timecode", "Script"], pattern: null }
};

const params = new URLSearchParams(window.location.search);

// ?dept=sound uses a preset; ?types=audio,mic&color=red&text=LX builds a custom filter.
export function readCueFilter(searchParams = params) {
  const dept = String(searchParams.get("dept") || "").toLowerCase();
  const list = (name) => String(searchParams.get(name) || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const preset = DEPARTMENTS[dept] || null;
  const types = list("types");
  const colors = list("color");
  const text = String(searchParams.get("text") || "").trim().toLowerCase();
  const active = Boolean(preset || types.length || colors.length || text);
  return {
    active,
    dept: preset ? dept : "",
    label: preset ? preset.label : (active ? "Custom filter" : "All departments"),
    matches(cue) {
      if (!active) return true;
      if (!cue) return false;
      const type = String(cue.type || "");
      const name = `${cue.number || ""} ${cue.name || ""} ${cue.listName || ""}`;
      if (preset) {
        const typeMatch = preset.types.includes(type);
        const nameMatch = preset.pattern ? preset.pattern.test(name) : false;
        if (!typeMatch && !nameMatch) return false;
      }
      if (types.length && !types.includes(type.toLowerCase())) return false;
      if (colors.length && !colors.includes(String(cue.colorName || "").toLowerCase())) return false;
      if (text && !name.toLowerCase().includes(text)) return false;
      return true;
    }
  };
}

// Matching cues plus their parent groups, so the filtered list keeps its structure.
export function filterCueList(cues, filter) {
  if (!filter.active) return cues;
  const byId = new Map(cues.map((cue) => [cue.uniqueID, cue]));
  const keep = new Set();
  for (const cue of cues) {
    if (cue.type === "Cue List" || cue.type === "Group") continue;
    if (!filter.matches(cue)) continue;
    keep.add(cue.uniqueID);
    let parent = byId.get(cue.parentId);
    while (parent && !keep.has(parent.uniqueID)) {
      keep.add(parent.uniqueID);
      parent = byId.get(parent.parentId);
    }
  }
  return cues.filter((cue) => keep.has(cue.uniqueID));
}

export function filterRunning(running, cueMap, filter) {
  if (!filter.active) return running;
  return running.filter((cue) => {
    const full = cueMap.get(cue.uniqueID) || cue;
    return full.type !== "Cue List" && full.type !== "Group" && filter.matches(full);
  });
}

export function departmentOptionsHtml(filter, configured = []) {
  const selected = filter.dept || (filter.active ? "__custom" : "");
  const option = ([id, label]) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  let html = option(["", "All cues"]);
  if (configured.length) {
    html += `<optgroup label="Departments">${configured.map((department) => option([department.id, department.name])).join("")}</optgroup>`;
  }
  html += `<optgroup label="Quick filters by cue type">${Object.entries(DEPARTMENTS).map(([id, dept]) => option([id, dept.label])).join("")}</optgroup>`;
  if (filter.active && !filter.dept) html += option(["__custom", "Custom filter"]);
  return html;
}

// Departments set up in Admin, with the cues each owns (same rules as their control pages).
export async function loadConfiguredDepartments() {
  try {
    const data = await fetch("/api/departments/cues", { cache: "no-store" }).then((response) => response.json());
    return data.departments || [];
  } catch {
    return [];
  }
}

// A filter for one configured department, or null if ?dept= isn't one of them.
export function configuredDepartmentFilter(configured, searchParams = params) {
  const id = String(searchParams.get("dept") || "");
  const department = configured.find((entry) => entry.id === id);
  if (!department) return null;
  const ids = new Set(department.cueIds);
  return {
    active: true,
    dept: department.id,
    label: department.name,
    matches: (cue) => Boolean(cue && ids.has(cue.uniqueID))
  };
}

export function applyDepartment(dept) {
  if (dept === "__custom") return;
  const next = new URLSearchParams(window.location.search);
  for (const key of ["dept", "types", "color", "text"]) next.delete(key);
  if (dept) next.set("dept", dept);
  const query = next.toString();
  window.location.search = query ? `?${query}` : "";
}

// --- Standby cue and notes ---

export function getStandbyCue(state, cueMap) {
  return state.standbyId ? cueMap.get(state.standbyId) || null : null;
}

export function getCueNotes(state, cueId) {
  return cueId ? String(state.notes?.[cueId] || "") : "";
}

// --- Countdown warnings ---

const warnParam = Number(params.get("warn"));
export const WARN_SECONDS = Number.isFinite(warnParam) && warnParam > 0 ? warnParam : 10;
export const DANGER_SECONDS = Math.min(5, WARN_SECONDS / 2);

export function endingClass(remaining) {
  if (remaining == null || !Number.isFinite(remaining)) return "";
  if (remaining <= DANGER_SECONDS) return "ending-now";
  if (remaining <= WARN_SECONDS) return "ending-soon";
  return "";
}

// --- Show clock ---

let serverOffsetMs = 0;

export function syncServerTime(state) {
  if (state?.serverTime) serverOffsetMs = Number(state.serverTime) - Date.now();
}

export function serverNow() {
  return Date.now() + serverOffsetMs;
}

export function showClockInfo(show) {
  if (!show) return { label: "Show clock", value: "--:--", state: "idle" };
  const now = serverNow();

  if (show.intervalStartedAt) {
    const elapsed = (now - Date.parse(show.intervalStartedAt)) / 1000;
    if (show.intervalPlannedSec > 0) {
      const left = show.intervalPlannedSec - elapsed;
      return left >= 0
        ? { label: "Interval", value: `${formatClock(left)} left`, state: left <= 120 ? "warn" : "interval" }
        : { label: "Interval", value: `+${formatClock(-left)} over`, state: "over" };
    }
    return { label: "Interval", value: formatClock(elapsed), state: "interval" };
  }

  if (show.startedAt) {
    const end = show.endedAt ? Date.parse(show.endedAt) : now;
    const running = (end - Date.parse(show.startedAt)) / 1000;
    return {
      label: show.endedAt ? "Show ended" : "Show running",
      value: formatClock(running),
      state: show.endedAt ? "ended" : "running"
    };
  }

  return { label: "Show clock", value: "Not started", state: "idle" };
}

export function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

// --- Backstage paging overlay ---

let pageOverlay = null;
let dismissedPageId = "";

export function renderPageOverlay(page, { pageKind, dept }) {
  const visible = page && page.id !== dismissedPageId &&
    (page.target === "all" || page.target === pageKind || (dept && page.target === dept)) &&
    (!page.expiresAt || Date.parse(page.expiresAt) > serverNow());

  if (!visible) {
    pageOverlay?.remove();
    pageOverlay = null;
    return;
  }

  if (!pageOverlay) {
    pageOverlay = document.createElement("section");
    pageOverlay.className = "page-overlay";
    pageOverlay.setAttribute("role", "alert");
    pageOverlay.innerHTML = `
      <p class="eyebrow">Backstage call</p>
      <strong class="page-text"></strong>
      <span class="page-time"></span>
      <button type="button" class="secondary">Dismiss on this screen</button>
    `;
    pageOverlay.querySelector("button").addEventListener("click", () => {
      dismissedPageId = pageOverlay?.dataset.pageId || "";
      pageOverlay?.remove();
      pageOverlay = null;
    });
    document.body.append(pageOverlay);
  }

  if (pageOverlay.dataset.pageId !== page.id) {
    pageOverlay.dataset.pageId = page.id;
    pageOverlay.dataset.level = page.level;
    pageOverlay.querySelector(".page-text").textContent = page.text;
    pageOverlay.querySelector(".page-time").textContent = `Sent ${new Date(page.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    // Restart the attention animation for each new call.
    pageOverlay.classList.remove("flash");
    void pageOverlay.offsetWidth;
    pageOverlay.classList.add("flash");
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

// --- Control API (admin login or control token) ---

export async function sendControl(action, body = {}) {
  const response = await fetch(`/api/control/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Control request failed (${response.status}).`);
  return data;
}

// Live state stream shared by the control pages.
export function subscribeState(pageKind, onState) {
  let state = {};
  const clientId = `${pageKind}-${Math.random().toString(36).slice(2, 10)}`;
  const events = new EventSource(`/events?clientId=${clientId}&page=${encodeURIComponent(pageKind)}`);
  const merge = (patch) => {
    state = { ...state, ...patch, cues: patch.cues || state.cues || [] };
    syncServerTime(state);
    onState(state, true);
  };
  events.addEventListener("snapshot", (event) => merge(JSON.parse(event.data)));
  events.addEventListener("patch", (event) => merge(JSON.parse(event.data)));
  events.addEventListener("heartbeat", (event) => merge(JSON.parse(event.data)));
  events.onerror = () => onState(state, false);
  return events;
}

export function cueLabel(cue) {
  if (!cue) return "";
  return cue.name || cue.listName || cue.type || "";
}
