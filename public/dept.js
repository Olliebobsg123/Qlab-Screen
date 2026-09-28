import { escapeHtml, getCueNotes, renderPageOverlay, showClockInfo, subscribeState } from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
// The admin can open any department with ?dept=<id>.
const adminDept = params.get("dept") || "";
const apiSuffix = adminDept ? `?dept=${encodeURIComponent(adminDept)}` : "";
const KEYBOARD_KEY = "qlab-dept-keyboard";
const COLORS = {
  red: "#ef4444", orange: "#f97316", yellow: "#facc15", green: "#4ade80",
  blue: "#60a5fa", purple: "#c084fc", magenta: "#f472b6", gray: "#9ca3af"
};

let state = {};
let view = null;
let viewCuesVersion = -1;
let loadingView = null;
let toastTimer = null;
let targetsAdded = false;

await loadView();

subscribeState("department", (nextState, online) => {
  state = nextState;
  document.body.classList.toggle("server-offline", !online);
  if (Number(state.cuesVersion) !== viewCuesVersion) loadView();
  render();
});
setInterval(renderClock, 1000);

$("#logoutButton").addEventListener("click", async () => {
  if (!adminDept) await fetch("/api/logout", { method: "POST" });
  window.location.href = adminDept ? "/admin.html" : "/login.html";
});
$("#stopAllButton").addEventListener("click", () => act({ action: "stopAll" }, "Stopped your cues"));

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const { act: action, cue, list } = button.dataset;
  const labels = { go: "GO", start: "Started", stop: "Stopped", standby: "Standing by", next: "Next", previous: "Previous" };
  act({ action, cueId: cue, listId: list }, labels[action] || action);
});

setupKeyboard();
setupShowControls();

async function loadView() {
  if (loadingView) return loadingView;
  loadingView = (async () => {
    const response = await fetch(`/api/dept/me${apiSuffix}`, { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    view = await response.json();
    viewCuesVersion = Number(state.cuesVersion ?? -1);
    const { department } = view;
    document.title = `${department.name} · Cues`;
    $("#deptName").textContent = department.name;
    const isStageManager = department.role === "stageManager";
    $("#deptEyebrow").textContent = `${isStageManager ? "Stage manager" : "Department"}${adminDept ? " (admin view)" : ""}`;
    document.body.classList.toggle("is-stage-manager", isStageManager);
    addDepartmentTargets();
    document.documentElement.style.setProperty("--dept", COLORS[department.color] || COLORS.blue);
    render();
  })().finally(() => {
    loadingView = null;
  });
  return loadingView;
}

async function act(body, label) {
  try {
    const response = await fetch(`/api/dept/action${apiSuffix}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) window.location.href = "/login.html";
    if (!response.ok) throw new Error(data.error || "That didn't work.");
    toast(label);
  } catch (error) {
    toast(error.message, true);
  }
}

function render() {
  if (!view) return;
  const cueMap = new Map((state.cues || []).map((cue) => [cue.uniqueID, cue]));
  const can = (permission) => view.department.permissions?.includes(permission);
  const showAll = Boolean(view.showAll);
  const owned = new Set(showAll ? (state.cues || []).filter((cue) => cue.depth > 0).map((cue) => cue.uniqueID) : view.cueIds);
  const running = (state.running || []).filter((cue) => owned.has(cue.uniqueID) && cue.type !== "Cue List");
  const runningIds = new Set(running.map((cue) => cue.uniqueID));
  const playheads = state.playheads || {};
  const sequenceMode = view.mode === "sequence";
  const sequenceNextId = state.deptNext?.[view.department.id] || "";
  const standbyIds = new Set(showAll
    ? [state.standbyId].filter(Boolean)
    : sequenceMode ? [sequenceNextId].filter(Boolean) : view.lists.map((list) => playheads[list.id]).filter(Boolean));

  renderShowControls(cueMap, can);

  const qlab = $("#deptQlab");
  qlab.dataset.state = state.connected ? "on" : "off";
  qlab.textContent = state.connected ? "QLab connected" : "QLab offline";

  const notice = $("#deptNotice");
  const problems = [];
  if (state.connected === false) problems.push("QLab isn't connected right now.");
  if (state.controlEnabled === false) problems.push("Cue control is switched off by the admin, so buttons won't do anything.");
  if (!view.cueIds.length && !showAll) problems.push("No cues are assigned to this department yet. Ask the admin to choose your cues in Admin → Departments.");
  notice.textContent = problems.join(" ");
  notice.hidden = !problems.length;

  // One GO card per cue list the department owns, or one for its own sequence of cues.
  const goSources = sequenceMode
    ? (view.cueIds.length ? [{ id: "", name: "My cues", standbyId: sequenceNextId }] : [])
    : view.lists.map((list) => ({ ...list, standbyId: playheads[list.id] }));
  $("#goCards").innerHTML = goSources.map((list) => {
    const standby = cueMap.get(list.standbyId);
    const notes = getCueNotes(state, standby?.uniqueID);
    return `
      <div class="panel go-card">
        <div class="go-card-head">
          <span class="eyebrow">${escapeHtml(list.name)} · next</span>
          <div class="go-next">
            <strong class="go-number">${escapeHtml(standby?.number || "–")}</strong>
            <strong class="go-name">${escapeHtml(standby ? cueName(standby) : "End of your cues")}</strong>
          </div>
          ${notes ? `<p class="notes-text">${escapeHtml(notes)}</p>` : ""}
        </div>
        <button type="button" class="go-button dept-go" data-act="go" data-list="${escapeHtml(list.id)}" ${standby ? "" : "disabled"}>GO</button>
        <div class="go-steps">
          <button type="button" class="secondary" data-act="previous" data-list="${escapeHtml(list.id)}">◀ Previous</button>
          <button type="button" class="secondary" data-act="next" data-list="${escapeHtml(list.id)}">Next ▶</button>
        </div>
      </div>`;
  }).join("");

  const runningEl = $("#deptRunning");
  runningEl.classList.toggle("empty", !running.length);
  runningEl.innerHTML = running.length
    ? running.map((cue) => {
      const full = cueMap.get(cue.uniqueID) || cue;
      const timing = state.time?.[cue.uniqueID] || {};
      const elapsed = Number(timing.actionElapsed || 0);
      const duration = Number(timing.duration || 0);
      const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
      const remaining = duration > 0 ? Math.max(0, duration - elapsed) : null;
      return `
        <div class="dept-run">
          <div class="dept-run-top">
            <strong>${escapeHtml(full.number || "–")}</strong>
            <span>${escapeHtml(cueName(full))}</span>
            <span class="dept-run-time">${remaining == null ? formatTime(elapsed) : `−${formatTime(remaining)}`}</span>
            <button type="button" class="secondary small-button" data-act="stop" data-cue="${escapeHtml(cue.uniqueID)}">Stop</button>
          </div>
          <div class="progress"><span style="--progress:${progress}%"></span></div>
        </div>`;
    }).join("")
    : "Nothing running.";

  // Departments that can fire any cue see the whole show, with cue list headings.
  const cues = (state.cues || []).filter((cue) => owned.has(cue.uniqueID) || (showAll && cue.depth === 0));
  const cueCount = cues.filter((cue) => cue.depth > 0).length;
  $("#deptCuesTitle").textContent = showAll ? "Show cues" : "My cues";
  $("#deptCueCount").textContent = `${cueCount} cue${cueCount === 1 ? "" : "s"}`;
  $("#stopAllButton").textContent = can("transport") ? "Stop all cues" : "Stop all my cues";
  const listIds = new Set(view.lists.map((list) => list.id));
  const cuesEl = $("#deptCues");
  cuesEl.classList.toggle("empty", !cues.length);
  cuesEl.innerHTML = cues.length
    ? cues.map((cue) => {
      if (cue.depth === 0) return `<div class="dept-cue-list">${escapeHtml(cue.name || cue.listName || "Cue list")}</div>`;
      const isRunning = runningIds.has(cue.uniqueID);
      const isNext = standbyIds.has(cue.uniqueID);
      const inOwnList = showAll || sequenceMode || listIds.has(rootList(cue, cueMap));
      const swatch = COLORS[String(cue.colorName || "").toLowerCase()];
      return `
        <div class="dept-cue ${isRunning ? "running" : ""} ${isNext ? "standby" : ""}" style="--depth:${Math.max(0, Number(cue.depth || 1) - 1)}">
          <span class="dept-cue-number">${escapeHtml(cue.number || "–")}</span>
          <span class="dept-cue-name">
            ${swatch ? `<span class="cue-swatch" style="--cue-swatch:${swatch}"></span>` : ""}
            ${escapeHtml(cueName(cue))}
            ${isRunning ? '<span class="badge">RUN</span>' : ""}
            ${isNext ? '<span class="badge standby-badge">NEXT</span>' : ""}
          </span>
          <span class="dept-cue-actions">
            ${inOwnList && !isNext ? `<button type="button" class="secondary small-button" data-act="standby" data-cue="${escapeHtml(cue.uniqueID)}" title="Put the playhead on this cue">Standby</button>` : ""}
            ${isRunning
              ? `<button type="button" class="secondary small-button" data-act="stop" data-cue="${escapeHtml(cue.uniqueID)}">Stop</button>`
              : `<button type="button" class="small-button" data-act="start" data-cue="${escapeHtml(cue.uniqueID)}">Start</button>`}
          </span>
        </div>`;
    }).join("")
    : "No cues are assigned to this department yet.";

  renderClock();
}

function renderClock() {
  const clock = showClockInfo(state.show);
  const chip = $("#deptShowClock");
  chip.hidden = clock.state === "idle";
  chip.textContent = `${clock.label} ${clock.value}`;
  chip.dataset.state = clock.state;
  // Whoever sends calls sees them in the paging card, not as an overlay over their controls.
  if (!view?.department.permissions?.includes("paging")) {
    renderPageOverlay(state.page, { pageKind: "department", dept: view?.department.id });
  }
  $("#clockValue").textContent = clock.value;
  $("#clockValue").dataset.state = clock.state;
  $("#clockLabel").textContent = clock.state === "idle" ? "Not started" : clock.label;
}

function rootList(cue, cueMap) {
  let current = cue;
  while (current?.parentId && cueMap.get(current.parentId)) current = cueMap.get(current.parentId);
  return current?.uniqueID || "";
}

function cueName(cue) {
  return cue.name || cue.listName || cue.type || "";
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function setupKeyboard() {
  const toggle = $("#deptKeyboard");
  try {
    toggle.checked = localStorage.getItem(KEYBOARD_KEY) === "1";
  } catch {
    toggle.checked = false;
  }
  toggle.addEventListener("change", () => {
    try {
      localStorage.setItem(KEYBOARD_KEY, toggle.checked ? "1" : "0");
    } catch {
      // Not remembered in private browsing.
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!toggle.checked || event.repeat || event.code !== "Space") return;
    if (event.target.closest("input, select, textarea, button")) return;
    if (view?.department.permissions?.includes("showGo")) {
      event.preventDefault();
      showAct("go", {}, "GO");
      return;
    }
    if (!view || (view.mode !== "sequence" && !view.lists[0])) return;
    event.preventDefault();
    act({ action: "go", listId: view.lists[0]?.id }, "GO");
  });
}

function toast(text, isError = false) {
  const element = $("#deptToast");
  element.textContent = text;
  element.dataset.error = isError ? "true" : "false";
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), isError ? 4000 : 1200);
}

// --- Show-wide controls (Stage Manager and departments given those powers) ---

const SHOW_LABELS = {
  go: "GO", next: "Next", previous: "Previous", pause: "Paused all", resume: "Resumed all", stop: "Stopped all",
  panic: "Panic", hardStop: "Hard stop", startCue: "Started", standby: "Standing by", showStart: "Show started",
  showEnd: "Show ended", intervalStart: "Interval started", intervalEnd: "Interval ended", page: "Call sent", clearPage: "Call cleared"
};

function showAct(control, extra = {}, label = SHOW_LABELS[control] || control) {
  return act({ action: "control", control, ...extra }, label);
}

function renderShowControls(cueMap, can) {
  const showGo = can("showGo");
  const transport = can("transport");
  const anyCue = can("anyCue");
  $("#showCard").hidden = !(showGo || transport || anyCue);
  $("#showGoBlock").hidden = !showGo;
  $("#transportBlock").hidden = !transport;
  $("#cueNumberForm").hidden = !anyCue;
  $("#clockCard").hidden = !can("showClock");
  $("#pagingCard").hidden = !can("paging");

  const standby = cueMap.get(state.standbyId);
  const notes = getCueNotes(state, standby?.uniqueID);
  $("#showNumber").textContent = standby?.number || "–";
  $("#showName").textContent = standby ? cueName(standby) : (state.connected ? "Nothing on standby" : "Waiting for QLab");
  $("#showNotes").hidden = !notes;
  $("#showNotes").textContent = notes;
  $("#showGo").disabled = !state.connected;
  $("#pageStatus").textContent = state.page ? `Showing: “${state.page.text}”` : "No active call";
}

function setupShowControls() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-show]");
    if (!button) return;
    showAct(button.dataset.show);
  });

  $("#hardStopButton").addEventListener("click", () => {
    if (window.confirm("Hard stop every cue immediately, with no fade?")) showAct("hardStop");
  });
  $("#intervalStartButton").addEventListener("click", () => {
    showAct("intervalStart", { minutes: Number($("#intervalMinutes").value) || 0 });
  });
  $("#cueNumberForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const control = event.submitter?.dataset.cueAction || "startCue";
    showAct(control, { cue: event.target.elements.cue.value.trim() });
  });

  const pageForm = $("#pageForm");
  const pageFields = () => ({
    level: pageForm.elements.level.value,
    target: pageForm.elements.target.value,
    durationSec: Number(pageForm.elements.durationSec.value) || 0
  });
  for (const button of document.querySelectorAll("[data-page]")) {
    button.addEventListener("click", () => {
      showAct("page", { ...pageFields(), text: button.dataset.page, level: button.dataset.level || pageForm.elements.level.value });
    });
  }
  pageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pageForm.elements.text.value.trim()) return;
    await showAct("page", { ...pageFields(), text: pageForm.elements.text.value });
    pageForm.elements.text.value = "";
  });

  // Hold to panic, so a stray tap can't fade out the show.
  const panic = $("#panicButton");
  let timer = null;
  const start = (event) => {
    event.preventDefault();
    panic.classList.add("holding");
    timer = setTimeout(() => {
      panic.classList.remove("holding");
      showAct("panic");
    }, 800);
  };
  const cancel = () => {
    clearTimeout(timer);
    panic.classList.remove("holding");
  };
  panic.addEventListener("pointerdown", start);
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) panic.addEventListener(type, cancel);
}

async function addDepartmentTargets() {
  if (targetsAdded) return;
  targetsAdded = true;
  const { departments = [] } = await fetch("/api/departments").then((response) => response.json()).catch(() => ({}));
  const others = departments.filter((department) => department.id !== view?.department.id);
  if (!others.length) return;
  const group = document.createElement("optgroup");
  group.label = "Departments";
  for (const department of others) group.append(new Option(department.name, department.id));
  $("#pageForm").elements.target.append(group);
}
