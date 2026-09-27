import {
  applyDepartment,
  departmentOptionsHtml,
  endingClass,
  filterCueList,
  filterRunning,
  getCueNotes,
  getStandbyCue,
  readCueFilter,
  renderPageOverlay,
  showClockInfo,
  syncServerTime
} from "/shared.js";

const statusText = document.querySelector("#statusText");
const workspaceHero = document.querySelector("#workspaceHero");
const workspaceText = document.querySelector("#workspaceText");
const runningCount = document.querySelector("#runningCount");
const lastUpdate = document.querySelector("#lastUpdate");
const cueCount = document.querySelector("#cueCount");
const cueList = document.querySelector("#cueList");
const runningList = document.querySelector("#runningList");
const mobileStatus = document.querySelector("#mobileStatus");
const mobileLastUpdate = document.querySelector("#mobileLastUpdate");
const mobileGroup = document.querySelector("#mobileGroup");
const mobileCueNumber = document.querySelector("#mobileCueNumber");
const mobileCueName = document.querySelector("#mobileCueName");
const mobileProgress = document.querySelector("#mobileProgress");
const mobileElapsed = document.querySelector("#mobileElapsed");
const mobileRemaining = document.querySelector("#mobileRemaining");
const mobileRunningCount = document.querySelector("#mobileRunningCount");
const mobileWorkspace = document.querySelector("#mobileWorkspace");
const fullscreenButton = document.querySelector("#fullscreenButton");
const wakeLockButton = document.querySelector("#wakeLockButton");
const wakeStateBadge = document.querySelector("#wakeStateBadge");
const versionBadge = document.querySelector("#versionBadge");
const deptSelect = document.querySelector("#deptSelect");
const showClockCell = document.querySelector("#showClockCell");
const showClockLabel = document.querySelector("#showClockLabel");
const showClockValue = document.querySelector("#showClockValue");
const standbyCard = document.querySelector("#standbyCard");
const standbyNumber = document.querySelector("#standbyNumber");
const standbyName = document.querySelector("#standbyName");
const standbyNotes = document.querySelector("#standbyNotes");
const mobileStandby = document.querySelector("#mobileStandby");
const mobileStandbyNotes = document.querySelector("#mobileStandbyNotes");
const cueFilter = readCueFilter();
const VIEWER_PAGE = "monitor";
const VIEWER_CLIENT_ID_KEY = "qlab-screen-client-id";

let currentState = null;
let serverOnline = false;
let eventsOnline = false;
let lastEventAt = 0;
let lastScrollTarget = "";
let userScrolledAt = 0;
let autoScrolling = false;
let wakeLock = null;
let wakeLockWanted = false;
let lastCueVersion = -1;
let lastRunningIdsKey = "";
let lastStandbyId = "";
let lastRenderedCues = null;
let fullStateRequest = null;
let lastFullStateFetchAt = 0;
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const viewerClientId = getViewerClientId();

const events = new EventSource(`/events?clientId=${encodeURIComponent(viewerClientId)}&page=${encodeURIComponent(VIEWER_PAGE)}`);

events.onopen = () => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  render(currentState);
};

events.addEventListener("snapshot", (event) => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  render(JSON.parse(event.data));
});

events.addEventListener("patch", (event) => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  render(mergeStatePatch(currentState, JSON.parse(event.data)));
});

events.addEventListener("heartbeat", (event) => {
  eventsOnline = true;
  serverOnline = true;
  lastEventAt = Date.now();
  render(mergeStatePatch(currentState, JSON.parse(event.data)));
});

events.onerror = () => {
  eventsOnline = false;
  render(currentState);
};

pollState();
setInterval(pollState, 2000);
setInterval(renderClockAndPage, 1000);

deptSelect.innerHTML = departmentOptionsHtml(cueFilter);
deptSelect.addEventListener("change", () => applyDepartment(deptSelect.value));
if (cueFilter.active) document.querySelector(".hero-block .eyebrow").textContent = `QLab Screen · ${cueFilter.label}`;

cueList.addEventListener("scroll", () => {
  if (autoScrolling) return;
  userScrolledAt = Date.now();
}, { passive: true });

fullscreenButton.addEventListener("click", toggleFullscreen);
wakeLockButton.addEventListener("click", toggleWakeLock);
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
ensureFullState();

function render(state) {
  currentState = state || {};
  syncServerTime(currentState);
  const allCueMap = new Map((currentState.cues || []).map((cue) => [cue.uniqueID, cue]));
  const visibleRunning = filterRunning(currentState.running || [], allCueMap, cueFilter);
  const runningIds = new Set((currentState.running || []).map((cue) => cue.uniqueID));
  const runningIdsKey = Array.from(runningIds).sort().join("|");
  document.body.classList.toggle("server-offline", !serverOnline);
  document.body.classList.toggle("events-offline", serverOnline && !eventsOnline);
  document.body.classList.toggle("qlab-connected", Boolean(serverOnline && currentState.connected && !currentState.lastError));
  document.body.classList.toggle("qlab-error", Boolean(serverOnline && currentState.lastError));

  if (!serverOnline) {
    statusText.textContent = "Server disconnected";
  } else if (!eventsOnline) {
    statusText.textContent = "Reconnecting live view";
  } else {
    statusText.textContent = currentState.connected ? "Connected" : "Disconnected";
    if (currentState.lastError) statusText.textContent = currentState.lastError;
  }
  workspaceHero.textContent = currentState.workspaceName || "Waiting for workspace";
  versionBadge.textContent = `v${currentState.appVersion || "0.0.0"}`;
  const currentGroup = getCurrentGroup(currentState) || "-";
  workspaceText.textContent = currentGroup;
  runningCount.textContent = String(visibleRunning.length);
  const updateTime = currentState.lastMessageAt ? new Date(currentState.lastMessageAt).toLocaleTimeString() : "-";
  lastUpdate.textContent = updateTime;

  const visibleCues = filterCueList(currentState.cues || [], cueFilter);
  cueCount.textContent = cueFilter.active
    ? `${visibleCues.length} of ${(currentState.cues || []).length} cues`
    : `${visibleCues.length} cues`;
  renderCueList(visibleCues, runningIds, runningIdsKey);

  runningList.classList.toggle("empty", !visibleRunning.length);
  runningList.innerHTML = visibleRunning.length
    ? visibleRunning.map(renderRunningCue).join("")
    : "Nothing running.";

  renderStandby(allCueMap);
  renderClockAndPage();

  if (currentState.connected && !currentState.cues?.length) {
    ensureFullState();
  }

  renderMobileGlance(currentState, currentGroup, updateTime);
  requestAnimationFrame(() => scrollToActiveCue(currentState));
}

function renderCueList(cues, runningIds, runningIdsKey) {
  const cueVersion = Number(currentState.cuesVersion || 0);
  const standbyId = currentState.standbyId || "";
  const sourceCues = currentState.cues || [];
  if (cueVersion === lastCueVersion && runningIdsKey === lastRunningIdsKey &&
    standbyId === lastStandbyId && sourceCues === lastRenderedCues) return;

  cueList.classList.toggle("empty", cues.length === 0);
  cueList.innerHTML = cues.length
    ? cues.map((cue) => renderCue(cue, runningIds.has(cue.uniqueID), cue.uniqueID === standbyId)).join("")
    : (cueFilter.active && currentState.cues?.length ? `No ${cueFilter.label.toLowerCase()} cues.` : "No cues loaded.");

  lastCueVersion = cueVersion;
  lastRunningIdsKey = runningIdsKey;
  lastStandbyId = standbyId;
  lastRenderedCues = sourceCues;
}

function renderStandby(cueMap) {
  const standby = getStandbyCue(currentState, cueMap);
  const notes = getCueNotes(currentState, standby?.uniqueID);
  const hiddenByFilter = standby && !cueFilter.matches(standby) && cueFilter.active;
  standbyCard.classList.toggle("muted-standby", Boolean(hiddenByFilter));
  standbyNumber.textContent = standby?.number || "-";
  standbyName.textContent = standby
    ? `${getCueDisplayName(standby) || formatCueType(standby.type)}${hiddenByFilter ? " (other department)" : ""}`
    : (currentState.connected ? "No standby cue" : "Waiting for QLab");
  standbyNotes.hidden = !notes;
  standbyNotes.textContent = notes;
  mobileStandby.textContent = standby ? `${standby.number || "-"}  ${getCueDisplayName(standby)}` : "-";
  mobileStandbyNotes.hidden = !notes;
  mobileStandbyNotes.textContent = notes;
}

function renderClockAndPage() {
  const clock = showClockInfo(currentState?.show);
  showClockLabel.textContent = clock.label;
  showClockValue.textContent = clock.value;
  showClockCell.dataset.state = clock.state;
  renderPageOverlay(currentState?.page, { pageKind: VIEWER_PAGE, dept: cueFilter.dept });
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
    wakeLockButton.textContent = "Wake Lock Unsupported";
    wakeLockButton.disabled = true;
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
      fullscreenButton.textContent = document.body.classList.contains("focus-mode") ? "Exit Focus Mode" : "Focus Mode";
    } else {
      fullscreenButton.textContent = "Add to Home Screen";
    }
  } else {
    fullscreenButton.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
  }

  if (!("wakeLock" in navigator) || typeof navigator.wakeLock.request !== "function") {
    wakeLockButton.textContent = "Wake Lock Unsupported";
    wakeLockButton.disabled = true;
    wakeStateBadge.textContent = "Awake Unavailable";
    wakeStateBadge.dataset.state = "unsupported";
    return;
  }

  wakeLockButton.disabled = false;
  wakeLockButton.textContent = wakeLock ? "Allow Sleep" : "Keep Awake";
  wakeStateBadge.textContent = wakeLock ? "Awake On" : (wakeLockWanted ? "Awake Waiting" : "Awake Off");
  wakeStateBadge.dataset.state = wakeLock ? "on" : (wakeLockWanted ? "pending" : "off");
}

function renderMobileGlance(state, currentGroup, updateTime) {
  const cueMap = new Map((state.cues || []).map((cue) => [cue.uniqueID, cue]));
  const primary = pickPrimaryCue(filterRunning(state.running || [], cueMap, cueFilter), cueMap);
  const fullCue = cueMap.get(primary?.uniqueID) || primary;
  const timing = state.time?.[primary?.uniqueID] || {};
  const elapsed = Number(timing.actionElapsed || 0);
  const duration = Number(timing.duration || 0);
  const remaining = duration > 0 ? Math.max(0, duration - elapsed) : null;
  const progress = duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;

  mobileStatus.textContent = statusText.textContent;
  mobileLastUpdate.textContent = updateTime;
  mobileGroup.textContent = currentGroup;
  mobileCueNumber.textContent = fullCue?.number || "-";
  mobileCueName.textContent = fullCue ? getCueDisplayName(fullCue) : "No cue running";
  mobileProgress.style.width = `${progress}%`;
  mobileElapsed.textContent = `${formatTime(elapsed)} elapsed`;
  mobileRemaining.textContent = remaining == null ? "duration unavailable" : `${formatTime(remaining)} remaining`;
  mobileProgress.parentElement.dataset.ending = endingClass(remaining);
  mobileRunningCount.textContent = `${filterRunning(state.running || [], cueMap, cueFilter).length} running`;
  mobileWorkspace.textContent = state.workspaceName || "No workspace";
}

async function pollState() {
  if (eventsOnline && Date.now() - lastEventAt < 20000) return;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("State request failed.");
    serverOnline = true;
    const nextState = mergeStatePatch(currentState, await response.json());
    render(nextState);
    if (nextState.connected && !nextState.cues?.length) ensureFullState();
  } catch {
    serverOnline = false;
    eventsOnline = false;
    render(currentState);
  }
}

async function ensureFullState() {
  if (fullStateRequest) return fullStateRequest;
  if (Date.now() - lastFullStateFetchAt < 3000) return null;

  lastFullStateFetchAt = Date.now();
  fullStateRequest = fetch("/api/state", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Full state request failed.");
      return response.json();
    })
    .then((fullState) => {
      serverOnline = true;
      render(fullState);
      return fullState;
    })
    .catch(() => null)
    .finally(() => {
      fullStateRequest = null;
    });

  return fullStateRequest;
}

function mergeStatePatch(previousState, patch) {
  return {
    ...(previousState || {}),
    ...patch,
    cues: patch.cues || previousState?.cues || []
  };
}

function renderCue(cue, isRunning, isStandby) {
  const isDisabled = Number(cue.armed) === 0;
  const isGroup = cue.type === "Group" || cue.type === "Cue List";
  const displayName = getCueDisplayName(cue);
  const detail = getCueDetail(cue);
  const timing = currentState.time?.[cue.uniqueID] || {};
  const elapsed = Number(timing.actionElapsed || 0);
  const duration = Number(timing.duration || 0);
  const remaining = duration > 0 ? Math.max(0, duration - elapsed) : null;
  const liveTiming = isRunning
    ? `<div class="cue-live-time">${escapeHtml(formatTime(elapsed))}${remaining != null ? ` / ${escapeHtml(formatTime(remaining))}` : ""}</div>`
    : "";
  return `
    <article class="cue-row ${isRunning ? "running" : ""} ${isStandby ? "standby" : ""} ${isDisabled ? "disabled" : ""} ${isGroup ? "group-row" : ""}" data-cue-id="${escapeHtml(cue.uniqueID)}" data-parent-id="${escapeHtml(cue.parentId || "")}" style="--depth:${Number(cue.depth || 0)}">
      <div class="cue-number">${escapeHtml(cue.number || "-")}</div>
      <div class="cue-title cue-indent">
        ${renderCueSwatch(cue)}
        <div class="cue-copy">
          <div class="cue-name">${escapeHtml(displayName)}</div>
          ${detail ? `<div class="cue-detail">${escapeHtml(detail)}</div>` : ""}
          ${liveTiming}
        </div>
      </div>
      <div class="type">${escapeHtml(formatCueType(cue.type || "cue"))}</div>
      <div class="badges">
        ${cue.flagged ? '<span class="badge warn">F</span>' : ""}
        ${isDisabled ? '<span class="badge danger">D</span>' : ""}
        ${isRunning ? '<span class="badge">RUN</span>' : ""}
        ${isStandby ? '<span class="badge standby-badge">NEXT</span>' : ""}
      </div>
    </article>
  `;
}

function scrollToActiveCue(state) {
  if (!state?.cues?.length) return;
  if (Date.now() - userScrolledAt < 5000) return;

  const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
  const running = filterRunning(state.running || [], cueMap, cueFilter);
  // With nothing running, keep the standby cue in view instead.
  const primary = running.length ? pickPrimaryCue(running, cueMap) : getStandbyCue(state, cueMap);
  if (!primary) return;
  const targetCue = cueMap.get(primary?.uniqueID) || findParentInList(primary, cueMap);
  if (!targetCue?.uniqueID || targetCue.uniqueID === lastScrollTarget) return;

  const row = cueList.querySelector(`[data-cue-id="${CSS.escape(targetCue.uniqueID)}"]`);
  if (!row) return;

  lastScrollTarget = targetCue.uniqueID;
  autoScrolling = true;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => {
    autoScrolling = false;
  }, 900);
}

function pickPrimaryCue(running, cueMap) {
  const withFullCue = running.map((cue) => cueMap.get(cue.uniqueID) || cue);
  return withFullCue.find((cue) => cue.type !== "Group" && cue.type !== "Cue List") || withFullCue[0] || null;
}

function findParentInList(cue, cueMap) {
  let current = cue;
  while (current?.parentId) {
    const parent = cueMap.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function getCurrentGroup(state) {
  const cueMap = new Map((state.cues || []).map((cue) => [cue.uniqueID, cue]));
  const primary = pickPrimaryCue(state.running || [], cueMap);
  if (!primary) return "";

  const fullCue = cueMap.get(primary.uniqueID) || primary;
  if (fullCue.groupName) return fullCue.groupName;

  let current = fullCue;
  while (current?.parentId) {
    const parent = cueMap.get(current.parentId);
    if (!parent) break;
    if (parent.name || parent.number) return parent.name || parent.number;
    current = parent;
  }

  return fullCue.listName || "";
}

function renderRunningCue(cue) {
  const timing = currentState.time?.[cue.uniqueID] || {};
  const elapsed = Number(timing.actionElapsed || 0);
  const duration = Number(timing.duration || 0);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;
  const remaining = duration > 0 ? Math.max(0, duration - elapsed) : null;
  const displayName = getCueDisplayName(cue);
  const detail = getCueDetail(cue);
  const notes = getCueNotes(currentState, cue.uniqueID);

  return `
    <article class="run-card ${endingClass(remaining)}">
      <div class="run-top">
        <strong class="cue-number">${escapeHtml(cue.number || "-")}</strong>
        <div class="run-main">
          <strong class="run-title">${escapeHtml(displayName)}</strong>
          ${detail ? `<div class="run-detail">${escapeHtml(detail)}</div>` : ""}
        </div>
        <span class="timer">${formatTime(elapsed)}</span>
      </div>
      <div class="progress" aria-hidden="true"><span style="--progress:${progress}%"></span></div>
      <div class="meta">
        ${duration > 0 ? `${formatTime(remaining)} remaining of ${formatTime(duration)}` : "Duration unavailable"}
        ${timing.paused ? " / paused" : ""}
      </div>
      ${notes ? `<p class="notes-text">${escapeHtml(notes)}</p>` : ""}
    </article>
  `;
}

function formatTime(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "--:--.-";
  const value = Math.max(0, Number(seconds));
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function getCueDisplayName(cue) {
  if (!cue) return "";
  if (cue.type === "Timecode") return cue.listName || cue.name || cue.number || "Timecode";
  if (cue.type === "Memo") return cue.name || cue.listName || "";
  if (cue.type === "Cue List" || cue.type === "Group") return cue.name || cue.listName || cue.number || cue.type;
  return cue.name || cue.listName || cue.number || cue.type || "";
}

function getCueDetail(cue) {
  if (!cue) return "";
  if (cue.type === "Timecode") return cue.name && cue.name !== cue.listName ? cue.name : "";
  if (cue.type === "Memo") return "";
  if (!cue.name && cue.listName && cue.listName !== cue.number) return cue.listName;
  return "";
}

function formatCueType(type) {
  return type === "Cue List" ? "list" : String(type || "cue").toLowerCase();
}

function renderCueSwatch(cue) {
  const color = mapCueColor(cue.colorName);
  if (!color) return "";
  return `<span class="cue-swatch" style="--cue-swatch:${escapeHtml(color)}"></span>`;
}

function mapCueColor(colorName) {
  const value = String(colorName || "").toLowerCase();
  const map = {
    red: "#ef4444",
    orange: "#f97316",
    yellow: "#facc15",
    green: "#4ade80",
    blue: "#60a5fa",
    purple: "#c084fc",
    magenta: "#f472b6",
    gray: "#9ca3af"
  };
  return map[value] || "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
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
