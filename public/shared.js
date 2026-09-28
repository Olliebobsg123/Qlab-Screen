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
  const events = openLiveEvents(pageKind, clientId);
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

// --- Live timers: smooth elapsed/remaining/progress between server updates ---

// QLab is read twice a second; in between, running cues are counted on from the time of the last
// reading so clocks and progress bars move continuously.
export function liveTiming(timing) {
  if (!timing) return { elapsed: 0, duration: 0, remaining: null, progress: 0, paused: false };
  const duration = Number(timing.duration || 0);
  let elapsed = Number(timing.actionElapsed || 0);
  if (timing.at && !timing.paused) {
    // Cap the guess so a lost connection doesn't run the clock on forever.
    elapsed += Math.min(Math.max(0, (serverNow() - timing.at) / 1000), 3);
  }
  if (duration > 0) elapsed = Math.min(elapsed, duration);
  const remaining = duration > 0 ? Math.max(0, duration - elapsed) : null;
  return {
    elapsed,
    duration,
    remaining,
    progress: duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0,
    paused: Boolean(timing.paused)
  };
}

export function formatTenths(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

export function formatShort(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

// Elements opt in with data-live="elapsed|remaining|progress|ending" and data-cue="<id>".
// Optional: data-format="short", data-prefix / data-suffix, data-empty (text when there's no duration).
export function startLiveTimers(getState) {
  let last = 0;
  const tick = (now) => {
    requestAnimationFrame(tick);
    if (now - last < 50) return;
    last = now;
    const time = getState()?.time || {};
    for (const element of document.querySelectorAll("[data-live][data-cue]")) {
      const timing = time[element.dataset.cue];
      if (!timing && element.dataset.live !== "ending") continue;
      const live = liveTiming(timing);
      const format = element.dataset.format === "short" ? formatShort : formatTenths;
      const prefix = element.dataset.prefix || "";
      const suffix = element.dataset.suffix || "";
      if (element.dataset.live === "elapsed") {
        element.textContent = `${prefix}${format(live.elapsed)}${suffix}`;
      } else if (element.dataset.live === "remaining") {
        element.textContent = live.remaining == null
          ? (element.dataset.empty ?? "")
          : `${prefix}${format(live.remaining)}${suffix}`;
      } else if (element.dataset.live === "progress") {
        element.style.width = `${live.progress}%`;
      } else if (element.dataset.live === "ending") {
        const ending = timing ? endingClass(live.remaining) : "";
        element.dataset.ending = ending;
        element.classList.toggle("ending-soon", ending === "ending-soon");
        element.classList.toggle("ending-now", ending === "ending-now");
      }
    }
  };
  requestAnimationFrame(tick);
}

// --- One live connection per browser, shared by every tab ---

// Browsers allow only ~6 connections to one site, and each open page holds one for live updates,
// so with several tabs open the newest ones would never update (or even load). Instead one tab
// (the leader) keeps the live connection and relays every update to the others over a
// BroadcastChannel. If the leader tab closes, another tab takes over automatically.
const LIVE_TYPES = ["snapshot", "patch", "heartbeat", "meters"];
const LIVE_CHANNEL = "qlab-connect-live";
const FOLLOWER_STALE_MS = 25_000;

// Works like an EventSource for /events: addEventListener(type, fn) with event.data, onopen, onerror.
export function openLiveEvents(pageKind, clientId) {
  const target = new EventTarget();
  const api = {
    onopen: null,
    onerror: null,
    addEventListener: (type, listener) => target.addEventListener(type, listener)
  };
  const emit = (type, data) => {
    if (type === "open") return api.onopen?.();
    if (type === "error") return api.onerror?.();
    target.dispatchEvent(new MessageEvent(type, { data }));
  };
  const url = `/events?clientId=${encodeURIComponent(clientId)}&page=${encodeURIComponent(pageKind)}`;
  const openDirect = (relay = () => {}) => {
    const source = new EventSource(url);
    source.onopen = () => {
      emit("open");
      relay("open");
    };
    source.onerror = () => {
      emit("error");
      relay("error");
    };
    for (const type of LIVE_TYPES) {
      source.addEventListener(type, (event) => {
        emit(type, event.data);
        relay(type, event.data);
      });
    }
    return source;
  };

  if (!("BroadcastChannel" in window) || typeof navigator.locks?.request !== "function") {
    openDirect();
    return api;
  }

  const channel = new BroadcastChannel(LIVE_CHANNEL);
  let leader = false;
  let direct = null;
  let lastHeard = Date.now();
  let latest = null; // the leader's merged state, handed to tabs that open later
  let connected = false;

  const relay = (type, data) => {
    if (type === "snapshot") latest = JSON.parse(data);
    else if ((type === "patch" || type === "heartbeat") && latest) latest = { ...latest, ...JSON.parse(data), cues: latest.cues };
    channel.postMessage({ type, data });
  };

  channel.onmessage = (event) => {
    const { type, data } = event.data || {};
    if (type === "need-snapshot") {
      if (leader && latest) channel.postMessage({ type: "snapshot", data: JSON.stringify(latest) });
      return;
    }
    if (leader || direct) return;
    lastHeard = Date.now();
    if (type === "open" || type === "error") {
      connected = type === "open";
      emit(type);
      return;
    }
    if (!connected) {
      connected = true;
      emit("open");
    }
    emit(type, data);
  };

  // Whoever holds the lock is the leader; it's released automatically when that tab closes.
  navigator.locks.request(LIVE_CHANNEL, () => new Promise(() => {
    leader = true;
    if (!direct) direct = openDirect(relay);
  }));

  // Ask the current leader for the full state straight away.
  channel.postMessage({ type: "need-snapshot" });

  // Safety net: if the leader tab stops relaying (e.g. the browser froze it), connect directly.
  setInterval(() => {
    if (!leader && !direct && Date.now() - lastHeard > FOLLOWER_STALE_MS) direct = openDirect();
  }, 5000);

  return api;
}

// --- Cue light banner (department pages; monitor/TV when filtered to one department) ---

let cueLightBanner = null;
let lastCueLightKey = "";

// onAck: when given, the banner has a "Standing by" button (department pages only).
export function renderCueLightBanner(state, departmentId, { onAck } = {}) {
  const light = departmentId ? state?.cueLights?.[departmentId] : null;
  if (!light) {
    cueLightBanner?.remove();
    cueLightBanner = null;
    lastCueLightKey = "";
    return;
  }

  if (!cueLightBanner) {
    cueLightBanner = document.createElement("section");
    cueLightBanner.className = "cue-light";
    cueLightBanner.setAttribute("role", "alert");
    cueLightBanner.innerHTML = `
      <div class="cue-light-text">
        <strong class="cue-light-word"></strong>
        <span class="cue-light-cue"></span>
        <em class="cue-light-by"></em>
      </div>
      <button type="button" class="cue-light-ack">Standing by</button>`;
    cueLightBanner.querySelector(".cue-light-ack").addEventListener("click", () => onAck?.());
    document.body.prepend(cueLightBanner);
  }

  const key = `${light.state}:${light.at}`;
  if (key === lastCueLightKey) return;
  lastCueLightKey = key;
  const words = { standby: "STANDBY", ready: "STANDING BY", go: "GO" };
  cueLightBanner.dataset.state = light.state;
  cueLightBanner.querySelector(".cue-light-word").textContent = words[light.state] || light.state;
  cueLightBanner.querySelector(".cue-light-cue").textContent = light.cue || "";
  cueLightBanner.querySelector(".cue-light-by").textContent = light.state === "ready"
    ? "Waiting for GO"
    : light.by ? `from ${light.by}` : "";
  cueLightBanner.querySelector(".cue-light-ack").hidden = !(onAck && light.state === "standby");
  // A buzz on phones that support it, so operators notice without looking.
  if (light.state === "standby") navigator.vibrate?.(250);
  if (light.state === "go") navigator.vibrate?.([120, 60, 120]);
}

// Testing mode: each browser tab keeps its own department login (in sessionStorage, which is
// per tab) and sends it with every department request, instead of sharing one cookie.
const TAB_LOGIN_KEY = "qlab-dept-tab-login";

export function tabLogin() {
  try {
    return sessionStorage.getItem(TAB_LOGIN_KEY) || "";
  } catch {
    return "";
  }
}

export function setTabLogin(token) {
  try {
    if (token) sessionStorage.setItem(TAB_LOGIN_KEY, token);
    else sessionStorage.removeItem(TAB_LOGIN_KEY);
  } catch {
    // Storage blocked: falls back to the shared cookie.
  }
}

export function deptFetch(path, options = {}) {
  const token = tabLogin();
  const headers = { ...(options.headers || {}), ...(token ? { "X-Dept-Session": token } : {}) };
  return fetch(path, { ...options, headers });
}
