import {
  endingClass,
  escapeHtml,
  filterRunning,
  getCueNotes,
  getStandbyCue,
  readCueFilter,
  renderPageOverlay,
  showClockInfo,
  syncServerTime
} from "/shared.js";

const tvConnection = document.querySelector("#tvConnection");
const tvWorkspace = document.querySelector("#tvWorkspace");
const tvClock = document.querySelector("#tvClock");
const tvGroup = document.querySelector("#tvGroup");
const tvCueNumber = document.querySelector("#tvCueNumber");
const tvCueName = document.querySelector("#tvCueName");
const tvProgress = document.querySelector("#tvProgress");
const tvElapsed = document.querySelector("#tvElapsed");
const tvRemaining = document.querySelector("#tvRemaining");
const tvRunningList = document.querySelector("#tvRunningList");
const tvFullscreenButton = document.querySelector("#tvFullscreenButton");
const tvWakeLockButton = document.querySelector("#tvWakeLockButton");
const tvWakeStateBadge = document.querySelector("#tvWakeStateBadge");
const tvVersionBadge = document.querySelector("#tvVersionBadge");
const tvCurrent = document.querySelector("#tvCurrent");
const tvShowClock = document.querySelector("#tvShowClock");
const tvCurrentNotes = document.querySelector("#tvCurrentNotes");
const tvStandby = document.querySelector("#tvStandby");
const tvStandbyNumber = document.querySelector("#tvStandbyNumber");
const tvStandbyName = document.querySelector("#tvStandbyName");
const tvStandbyNotes = document.querySelector("#tvStandbyNotes");
const tvMeters = document.querySelector("#tvMeters");
const cueFilter = readCueFilter();
const METER_STALE_MS = 2000;
const VIEWER_PAGE = "dashboard";
const VIEWER_CLIENT_ID_KEY = "qlab-screen-client-id";

let currentState = {};
let serverOnline = false;
let eventsOnline = false;
let lastEventAt = 0;
let wakeLock = null;
let wakeLockWanted = false;
let lastMetersAt = 0;
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const viewerClientId = getViewerClientId();

updateClock();
setInterval(() => {
  updateClock();
  renderClockAndPage();
  if (lastMetersAt && Date.now() - lastMetersAt > METER_STALE_MS) tvMeters.hidden = true;
}, 1000);

const events = new EventSource(`/events?clientId=${encodeURIComponent(viewerClientId)}&page=${encodeURIComponent(VIEWER_PAGE)}`);

events.onopen = () => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  render();
};

events.addEventListener("snapshot", (event) => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  currentState = JSON.parse(event.data);
  render();
});

events.addEventListener("patch", (event) => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  currentState = mergeStatePatch(currentState, JSON.parse(event.data));
  render();
});

events.addEventListener("heartbeat", (event) => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  currentState = mergeStatePatch(currentState, JSON.parse(event.data));
  render();
});

events.addEventListener("meters", (event) => {
  renderMeters(JSON.parse(event.data));
});

events.onerror = () => {
  eventsOnline = false;
  render();
};

pollState();
setInterval(pollState, 5000);

tvFullscreenButton.addEventListener("click", toggleFullscreen);
tvWakeLockButton.addEventListener("click", toggleWakeLock);
document.addEventListener("fullscreenchange", syncViewControls);
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("pointerdown", ensureWakeLockOnFirstInteraction, { once: true, passive: true });
window.addEventListener("pagehide", () => sendPresence(false));
window.addEventListener("beforeunload", () => sendPresence(false));
syncViewControls();
sendPresence(document.visibilityState === "visible");
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  sendPresence(document.visibilityState === "visible");
}, 30000);

function render() {
  document.body.classList.toggle("server-offline", !serverOnline);
  document.body.classList.toggle("events-offline", serverOnline && !eventsOnline);
  document.body.classList.toggle("qlab-connected", Boolean(serverOnline && currentState.connected && !currentState.lastError));
  document.body.classList.toggle("qlab-error", Boolean(serverOnline && currentState.lastError));

  syncServerTime(currentState);
  const cueMap = new Map((currentState.cues || []).map((cue) => [cue.uniqueID, cue]));
  const running = filterRunning(currentState.running || [], cueMap, cueFilter);
  const primary = pickPrimaryCue(running, cueMap);
  const fullCue = cueMap.get(primary?.uniqueID) || primary;
  const group = findGroupName(fullCue, cueMap);
  const timing = currentState.time?.[primary?.uniqueID] || {};
  const elapsed = Number(timing.actionElapsed || 0);
  const duration = Number(timing.duration || 0);
  const remaining = duration > 0 ? Math.max(0, duration - elapsed) : null;
  const progress = duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;

  if (!serverOnline) {
    tvConnection.textContent = "Server disconnected";
  } else if (!eventsOnline) {
    tvConnection.textContent = "Reconnecting live view";
  } else {
    tvConnection.textContent = currentState.connected ? "Connected" : currentState.lastError || "Disconnected";
  }
  tvVersionBadge.textContent = `v${currentState.appVersion || "0.0.0"}`;
  const workspace = currentState.workspaceName || currentState.workspaceId || "-";
  tvWorkspace.textContent = cueFilter.active ? `${workspace} · ${cueFilter.label}` : workspace;
  tvGroup.textContent = group || (running.length ? "Ungrouped cue" : "Waiting for QLab");
  tvCueNumber.textContent = primary?.number || "-";
  tvCueName.textContent = fullCue ? getCueDisplayName(fullCue) : "No cue running";
  tvProgress.style.width = `${progress}%`;
  tvElapsed.textContent = `${formatTime(elapsed)} elapsed`;
  tvRemaining.textContent = remaining == null ? "duration unavailable" : `${formatTime(remaining)} remaining`;
  tvCurrent.dataset.ending = endingClass(remaining);

  const currentNotes = getCueNotes(currentState, primary?.uniqueID);
  tvCurrentNotes.hidden = !currentNotes;
  tvCurrentNotes.textContent = currentNotes;

  const standby = getStandbyCue(currentState, cueMap);
  const standbyNotes = getCueNotes(currentState, standby?.uniqueID);
  tvStandby.hidden = !standby;
  tvStandbyNumber.textContent = standby?.number || "-";
  tvStandbyName.textContent = standby ? getCueDisplayName(standby) || standby.type : "-";
  tvStandbyNotes.hidden = !standbyNotes;
  tvStandbyNotes.textContent = standbyNotes;
  renderClockAndPage();

  tvRunningList.innerHTML = running.length
    ? running.map((cue) => `<div>${escapeHtml(cue.number || "-")} ${escapeHtml(getCueDisplayName(cue))}</div>`).join("")
    : "Nothing running.";
}

async function toggleFullscreen() {
  if (isIos) {
    if (!isStandalone) {
      window.alert("On iPhone/iPad, add this page to the Home Screen for the closest fullscreen experience.");
      return;
    }
    document.body.classList.toggle("focus-mode");
    syncViewControls();
    return;
  }

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    syncViewControls();
  }
}

async function toggleWakeLock() {
  if (wakeLock) {
    wakeLockWanted = false;
    await releaseWakeLock();
    return;
  }

  wakeLockWanted = true;
  await requestWakeLock();
}

async function ensureWakeLockOnFirstInteraction() {
  if (wakeLockWanted && wakeLock === null) {
    await requestWakeLock();
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || typeof navigator.wakeLock.request !== "function") {
    tvWakeLockButton.textContent = "Wake Lock Unsupported";
    tvWakeLockButton.disabled = true;
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      syncViewControls();
    });
  } catch {
    wakeLock = null;
  }

  syncViewControls();
}

async function releaseWakeLock() {
  if (!wakeLock) {
    syncViewControls();
    return;
  }

  const activeLock = wakeLock;
  wakeLock = null;
  await activeLock.release().catch(() => {});
  syncViewControls();
}

async function handleVisibilityChange() {
  sendPresence(document.visibilityState === "visible");
  if (document.visibilityState !== "visible") return;
  if (wakeLockWanted && wakeLock === null) await requestWakeLock();
}

function syncViewControls() {
  if (isIos) {
    if (isStandalone) {
      tvFullscreenButton.textContent = document.body.classList.contains("focus-mode") ? "Exit Focus Mode" : "Focus Mode";
    } else {
      tvFullscreenButton.textContent = "Add to Home Screen";
    }
  } else {
    tvFullscreenButton.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
  }

  if (!("wakeLock" in navigator) || typeof navigator.wakeLock.request !== "function") {
    tvWakeLockButton.textContent = "Wake Lock Unsupported";
    tvWakeLockButton.disabled = true;
    tvWakeStateBadge.textContent = "Awake Unavailable";
    tvWakeStateBadge.dataset.state = "unsupported";
    return;
  }

  tvWakeLockButton.disabled = false;
  tvWakeLockButton.textContent = wakeLock ? "Allow Sleep" : "Keep Awake";
  tvWakeStateBadge.textContent = wakeLock ? "Awake On" : (wakeLockWanted ? "Awake Waiting" : "Awake Off");
  tvWakeStateBadge.dataset.state = wakeLock ? "on" : (wakeLockWanted ? "pending" : "off");
}

async function pollState() {
  if (eventsOnline && Date.now() - lastEventAt < 20000) return;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("State request failed.");
    serverOnline = true;
    currentState = mergeStatePatch(currentState, await response.json());
    render();
  } catch {
    serverOnline = false;
    eventsOnline = false;
    render();
  }
}

function mergeStatePatch(previousState, patch) {
  return {
    ...(previousState || {}),
    ...patch,
    cues: patch.cues || previousState?.cues || []
  };
}

function pickPrimaryCue(running, cueMap) {
  const withFullCue = running.map((cue) => cueMap.get(cue.uniqueID) || cue);
  return withFullCue.find((cue) => cue.type !== "Group" && cue.type !== "Cue List") || withFullCue[0] || null;
}

function findGroupName(cue, cueMap) {
  if (!cue) return "";
  if (cue.groupName) return cue.groupName;

  let current = cue;
  while (current?.parentId) {
    const parent = cueMap.get(current.parentId);
    if (!parent) break;
    if (parent.name || parent.number) return parent.name || parent.number;
    current = parent;
  }

  return cue.listName || "";
}

function getCueDisplayName(cue) {
  if (!cue) return "";
  if (cue.type === "Timecode") return cue.listName || cue.name || cue.number || "Timecode";
  if (cue.type === "Memo") return cue.name || cue.listName || "";
  if (cue.type === "Cue List" || cue.type === "Group") return cue.name || cue.listName || cue.number || cue.type;
  return cue.name || cue.listName || cue.number || cue.type || "";
}

function formatTime(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "--:--.-";
  const value = Math.max(0, Number(seconds));
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function renderClockAndPage() {
  const clock = showClockInfo(currentState.show);
  tvShowClock.textContent = clock.state === "idle" ? "" : `${clock.label} ${clock.value}`;
  tvShowClock.dataset.state = clock.state;
  renderPageOverlay(currentState.page, { pageKind: VIEWER_PAGE, dept: cueFilter.dept });
}

function renderMeters(payload) {
  const levels = payload.levels || [];
  if (!levels.length) return;
  lastMetersAt = Date.now();
  tvMeters.hidden = false;

  if (tvMeters.children.length !== levels.length + 1) {
    tvMeters.innerHTML = `<span class="eyebrow tv-meter-label"></span>` + levels.map(() => `
      <div class="meter"><span class="meter-rms"></span><span class="meter-peak"></span></div>
    `).join("");
  }

  tvMeters.querySelector(".tv-meter-label").textContent = payload.label || "Audio";
  levels.forEach((level, index) => {
    const meter = tvMeters.children[index + 1];
    meter.querySelector(".meter-rms").style.width = `${toMeterPercent(level.rms)}%`;
    meter.querySelector(".meter-peak").style.left = `${toMeterPercent(level.peak)}%`;
    meter.dataset.clip = level.peak >= 0.99 ? "true" : "false";
  });
}

// Linear 0..1 amplitude to a -60..0 dBFS bar.
function toMeterPercent(value) {
  const amplitude = Number(value) || 0;
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function getViewerClientId() {
  const existing = localStorage.getItem(VIEWER_CLIENT_ID_KEY);
  if (existing) return existing;
  const created = `viewer-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  localStorage.setItem(VIEWER_CLIENT_ID_KEY, created);
  return created;
}

function sendPresence(visible) {
  const payload = JSON.stringify({
    clientId: viewerClientId,
    page: VIEWER_PAGE,
    visible
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon("/api/presence", blob);
    return;
  }

  fetch("/api/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {});
}

function updateClock() {
  tvClock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
