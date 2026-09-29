import {
  deptFetch,
  escapeHtml,
  formatTenths,
  getCueNotes,
  renderCueLightBanner,
  liveTiming,
  renderPageOverlay,
  showClockInfo,
  startLiveTimers,
  setTabLogin,
  subscribeState,
  tabLogin
} from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
// The admin can open any department with ?dept=<id>.
const adminDept = params.get("dept") || "";
const apiQuery = adminDept ? `dept=${encodeURIComponent(adminDept)}` : "";
const withQuery = (path, extra = "") => {
  const query = [apiQuery, extra].filter(Boolean).join("&");
  return query ? `${path}?${query}` : path;
};
const KEYBOARD_KEY = "qlab-dept-keyboard";
const SIDE_TAB_KEY = "qlab-dept-side-tab";
const COLORS = {
  red: "#ef4444", orange: "#f97316", yellow: "#facc15", green: "#4ade80",
  blue: "#60a5fa", purple: "#c084fc", magenta: "#f472b6", gray: "#9ca3af"
};
const SHOW_LABELS = {
  go: "GO", next: "Next", previous: "Previous", pause: "Paused all", resume: "Resumed all", stop: "Stopped all",
  panic: "Panic", hardStop: "Hard stop", showStart: "Show started", showEnd: "Show ended",
  intervalStart: "Interval started", intervalEnd: "Interval ended", page: "Call sent", clearPage: "Call cleared"
};

let state = {};
let view = null;
let viewCuesVersion = -1;
let loadingView = null;
let toastTimer = null;
let targetsBuilt = "";
let openCue = null;
let scrubbing = false;
let sideTab = readStored(SIDE_TAB_KEY, "cues");
if (sideTab === "lights") sideTab = "standbys"; // the tab's old name
let allDepartments = [];
const standbyChoice = new Map(); // which cue the stage manager picked for each department's standby
let targetCues = new Map(); // department id → its cue ids (for the standby cue pickers)
let targetCuesVersion = -1;
let loadingTargetCues = false;
const renderedHtml = new WeakMap();

await loadView();

subscribeState("department", (nextState, online) => {
  state = nextState;
  document.body.classList.toggle("server-offline", !online);
  if (Number(state.cuesVersion) !== viewCuesVersion) loadView();
  render();
});
setInterval(renderClock, 1000);
// Also pick up changes made in Admin (e.g. which cue types this department runs).
setInterval(() => loadView(), 10000);
startLiveTimers(() => state);

setupButtons();
setupCuePanel();
setupStandbys();
setupKeyboard();

// Fetch which cues this department owns. The list changes whenever cues are added, deleted or
// edited in QLab, and QLab often makes several changes in a row (add, then number, then name).
// So note which version of the cue list was asked about, and ask again if it moved on meanwhile;
// otherwise a change landing mid-request would be missed until the next one.
async function loadView() {
  if (loadingView) return loadingView;
  loadingView = (async () => {
    const requestedVersion = Number(state.cuesVersion ?? -1);
    const response = await deptFetch(withQuery("/api/dept/me"), { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    view = await response.json();
    viewCuesVersion = requestedVersion;
    const { department } = view;
    const isStageManager = department.role === "stageManager";
    document.title = `${department.name} · Cues`;
    $("#deptName").textContent = department.name;
    $("#deptEyebrow").textContent = `${isStageManager ? "Stage manager" : "Department"}${adminDept ? " (admin view)" : ""}${tabLogin() && !adminDept ? " · testing mode" : ""}`;
    document.documentElement.style.setProperty("--dept", COLORS[department.color] || COLORS.blue);
    buildPageTargets();
    render();
  })().catch(() => {
    // Network hiccup: the next state update or the safety refresh tries again.
  }).finally(() => {
    loadingView = null;
    if (state.cuesVersion != null && Number(state.cuesVersion) !== viewCuesVersion) loadView();
  });
  return loadingView;
}

async function act(body, label) {
  try {
    const response = await deptFetch(withQuery("/api/dept/action"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) window.location.href = "/login.html";
    if (!response.ok) throw new Error(data.error || "That didn't work.");
    if (data.status !== "debounced") toast(label);
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

function showAct(control, extra = {}, label = SHOW_LABELS[control] || control) {
  return act({ action: "control", control, ...extra }, label);
}

// --- Rendering ---

function render() {
  if (!view) return;
  const cueMap = new Map((state.cues || []).map((cue) => [cue.uniqueID, cue]));
  const can = (permission) => view.department.permissions?.includes(permission);
  const showAll = Boolean(view.showAll);
  const owned = new Set(showAll ? (state.cues || []).filter((cue) => cue.depth > 0).map((cue) => cue.uniqueID) : view.cueIds);
  const running = (state.running || []).filter((cue) => owned.has(cue.uniqueID) && cue.type !== "Cue List");
  const runningIds = new Set(running.map((cue) => cue.uniqueID));
  const standbyIds = new Set(standbyCueIds(showAll));

  renderDesk();

  const qlab = $("#deptQlab");
  qlab.dataset.state = state.connected ? "on" : "off";
  qlab.textContent = state.connected ? "QLab connected" : "QLab offline";

  const problems = [];
  if (state.connected === false) problems.push("QLab isn't connected right now.");
  if (state.controlEnabled === false) problems.push("Cue control is switched off by the admin, so buttons won't do anything.");
  if (!view.cueIds.length && !showAll) problems.push("No cues are assigned to this department yet. Ask the admin to choose your cues in Admin → Departments.");
  $("#deptNotice").textContent = problems.join(" ");
  $("#deptNotice").hidden = !problems.length;

  renderShowCard(cueMap, can);
  renderGoCards(cueMap);
  renderRunning(running, cueMap);
  renderSide(can);
  renderCues(cueMap, owned, runningIds, standbyIds, showAll);
  if (openCue) renderCuePanel();
  renderClock();
}

function standbyCueIds(showAll) {
  if (showAll) return [state.standbyId].filter(Boolean);
  if (view.mode === "sequence") return [state.deptNext?.[view.department.id]].filter(Boolean);
  return view.lists.map((list) => state.playheads?.[list.id]).filter(Boolean);
}

function renderShowCard(cueMap, can) {
  const showGo = can("showGo");
  const transport = can("transport");
  $("#showCard").hidden = !(showGo || transport);
  $("#showGoBlock").hidden = !showGo;
  $("#transportBlock").hidden = !transport;

  const standby = cueMap.get(state.standbyId);
  const notes = getCueNotes(state, standby?.uniqueID);
  $("#showNumber").textContent = standby?.number || "–";
  $("#showName").textContent = standby ? cueName(standby) : (state.connected ? "Nothing on standby" : "Waiting for QLab");
  $("#showNotes").hidden = !notes;
  $("#showNotes").textContent = notes;
  $("#showGo").disabled = !state.connected;
}

// One GO card per cue list the department owns, or one for its own cues in show order.
function renderGoCards(cueMap) {
  const sequenceMode = view.mode === "sequence";
  const sources = sequenceMode
    ? (view.cueIds.length ? [{ id: "", name: "My cues", standbyId: state.deptNext?.[view.department.id] }] : [])
    : view.lists.map((list) => ({ ...list, standbyId: state.playheads?.[list.id] }));
  const light = state.cueLights?.[view.department.id];
  setHtml($("#goCards"), sources.map((list) => {
    const standby = cueMap.get(list.standbyId);
    const notes = getCueNotes(state, standby?.uniqueID);
    // A standby called for this exact cue: mark the card instead of popping anything up over GO.
    const called = standby && light?.cueId === standby.uniqueID && ["standby", "ready"].includes(light.state);
    return `
      <div class="panel go-card ${called ? "called" : ""}">
        <div class="go-card-head">
          <div class="go-card-top">
            <span class="eyebrow">${called ? `Standby from ${escapeHtml(light.by || "stage manager")}` : `${escapeHtml(list.name)} · next`}</span>
            ${standby ? `<button type="button" class="tool-button small-button" data-open-cue="${escapeHtml(standby.uniqueID)}">Options</button>` : ""}
          </div>
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
  }).join(""));
}

function renderRunning(running, cueMap) {
  const element = $("#deptRunning");
  // Only take up space while something is playing.
  $("#runningPanel").hidden = !running.length;
  element.classList.toggle("empty", !running.length);
  $("#stopAllButton").textContent = view.department.permissions?.includes("transport") ? "Stop all cues" : "Stop all my cues";
  setHtml(element, running.length
    ? running.map((cue) => {
      const full = cueMap.get(cue.uniqueID) || cue;
      const live = liveTiming(state.time?.[cue.uniqueID]);
      const id = escapeHtml(cue.uniqueID);
      return `
        <button type="button" class="dept-run" data-open-cue="${id}">
          <span class="dept-run-top">
            <strong>${escapeHtml(full.number || "–")}</strong>
            <span>${escapeHtml(cueName(full))}${live.paused ? ' <span class="badge warn">PAUSED</span>' : ""}</span>
            <span class="dept-run-time" data-cue="${id}" data-format="short" ${live.remaining == null ? 'data-live="elapsed"' : 'data-live="remaining" data-prefix="−"'}></span>
          </span>
          <span class="progress"><span data-live="progress" data-cue="${id}"></span></span>
        </button>`;
    }).join("")
    : "Nothing running.");
}

// The side column: cues, and (for departments with the powers) calls and the show clock as tabs.
function renderSide(can) {
  const available = ["cues", can("paging") && "standbys", can("paging") && "calls", can("showClock") && "clock"].filter(Boolean);
  if (!available.includes(sideTab)) sideTab = "cues";
  $("#sideTabs").hidden = available.length < 2;
  for (const tab of document.querySelectorAll("[data-side-tab]")) {
    tab.hidden = !available.includes(tab.dataset.sideTab);
    tab.setAttribute("aria-selected", String(tab.dataset.sideTab === sideTab));
  }
  for (const name of ["cues", "standbys", "calls", "clock"]) $(`#side-${name}`).hidden = name !== sideTab;
  if (sideTab === "standbys") renderStandbys();
  $("#pageStatus").textContent = state.page ? `Showing: “${state.page.text}”` : "No active call";
}

function renderCues(cueMap, owned, runningIds, standbyIds, showAll) {
  const search = $("#cueSearch").value.trim().toLowerCase();
  const matches = (cue) => !search ||
    String(cue.number || "").toLowerCase().includes(search) ||
    cueName(cue).toLowerCase().includes(search);
  const cues = (state.cues || []).filter((cue) =>
    (owned.has(cue.uniqueID) && matches(cue)) || (showAll && cue.depth === 0 && !search));
  const count = (state.cues || []).filter((cue) => owned.has(cue.uniqueID)).length;
  $("#deptCuesTitle").textContent = showAll ? "Show cues" : "My cues";
  $("#deptCueCount").textContent = `${count} cue${count === 1 ? "" : "s"}`;

  const element = $("#deptCues");
  element.classList.toggle("empty", !cues.length);
  setHtml(element, cues.length
    ? cues.map((cue) => {
      if (cue.depth === 0) return `<div class="dept-cue-list">${escapeHtml(cue.name || cue.listName || "Cue list")}</div>`;
      const isRunning = runningIds.has(cue.uniqueID);
      const isNext = standbyIds.has(cue.uniqueID);
      const swatch = COLORS[String(cue.colorName || "").toLowerCase()];
      const id = escapeHtml(cue.uniqueID);
      return `
        <button type="button" class="dept-cue ${isRunning ? "running" : ""} ${isNext ? "standby" : ""}" data-open-cue="${id}" style="--depth:${Math.max(0, Number(cue.depth || 1) - 1)}">
          <span class="dept-cue-number">${escapeHtml(cue.number || "–")}</span>
          <span class="dept-cue-name">
            ${swatch ? `<span class="cue-swatch" style="--cue-swatch:${swatch}"></span>` : ""}${escapeHtml(cueName(cue))}
            ${isNext ? '<span class="badge standby-badge">NEXT</span>' : ""}
          </span>
          <span class="dept-cue-state">
            ${isRunning ? `<span class="dept-run-time" data-live="remaining" data-prefix="−" data-format="short" data-cue="${id}"></span>` : `<span class="quiet">${escapeHtml(formatType(cue.type))}</span>`}
          </span>
        </button>`;
    }).join("")
    : (search ? "No cues match." : "No cues are assigned to this department yet."));
}

function renderClock() {
  const clock = showClockInfo(state.show);
  const chip = $("#deptShowClock");
  chip.hidden = clock.state === "idle";
  chip.textContent = `${clock.label} ${clock.value}`;
  chip.dataset.state = clock.state;
  $("#clockValue").textContent = clock.value;
  $("#clockValue").dataset.state = clock.state;
  $("#clockLabel").textContent = clock.state === "idle" ? "Not started" : clock.label;
  renderCueLightBanner(state, view?.department.id, { onAck: () => act({ action: "cueLightAck" }, "Standing by") });
  // Whoever sends calls sees them in the Calls tab, not as an overlay over their controls.
  if (!view?.department.permissions?.includes("paging")) {
    renderPageOverlay(state.page, { pageKind: "department", dept: view?.department.id });
  }
}

// Calls can only go where the admin allows this department to send them.
async function buildPageTargets() {
  const allowed = view.department.pageTargets || [];
  const key = JSON.stringify(allowed);
  if (targetsBuilt === key) return;
  targetsBuilt = key;
  const { departments = [] } = await fetch("/api/departments").then((response) => response.json()).catch(() => ({}));
  allDepartments = departments;
  const options = [
    ["all", "Every screen"],
    ["dashboard", "TV dashboards"],
    ["monitor", "Monitors"],
    ...departments.filter((department) => department.id !== view.department.id).map((department) => [department.id, department.name])
  ].filter(([id]) => !allowed.length || allowed.includes(id));
  $("#pageForm").elements.target.innerHTML = options
    .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
}

// Lighting desk light: is the desk connected, and did the last lighting GO get there?
const DESK_FLASH_MS = 5000;
function renderDesk() {
  const chip = $("#deptDesk");
  const desk = state.desk;
  chip.hidden = !desk;
  if (!desk) return;
  const last = desk.last;
  const recent = last && Date.now() - Date.parse(last.at) < DESK_FLASH_MS;
  let text = desk.online ? "Desk ✓" : "Desk offline";
  let chipState = desk.online ? "on" : "off";
  if (recent) {
    text = !last.ok ? `LX ${last.cue} failed` : last.delivered ? `LX ${last.cue} → desk ✓` : `LX ${last.cue} sent`;
    chipState = !last.ok ? "off" : last.delivered ? "flash" : "pending";
    clearTimeout(renderDesk.timer);
    renderDesk.timer = setTimeout(renderDesk, DESK_FLASH_MS);
  }
  chip.textContent = text;
  chip.dataset.state = chipState;
  chip.title = last
    ? `${desk.detail}\nLast: desk cue ${last.cue} ${last.ok ? (last.delivered ? "delivered" : "sent (UDP, unconfirmed)") : "FAILED"} at ${new Date(last.at).toLocaleTimeString()}`
    : desk.detail;
}

// --- Standbys (cue lights) for departments with the backstage-calls power ---
// Pick one of a department's cues and send it a standby; it answers "standing by"; then GO.

async function loadTargetCues() {
  const version = Number(state.cuesVersion ?? -1);
  if (targetCuesVersion === version || loadingTargetCues) return;
  loadingTargetCues = true;
  try {
    const { departments = [] } = await fetch("/api/departments/cues", { cache: "no-store" }).then((response) => response.json());
    targetCues = new Map(departments.map((department) => [department.id, department.cueIds || []]));
    targetCuesVersion = version;
    if (sideTab === "standbys") renderStandbys();
  } catch {
    // Tries again on the next render.
  } finally {
    loadingTargetCues = false;
  }
}

// The cue a department is on now: its own next cue, or whichever of its cues is at a list playhead.
function targetNextCue(departmentId, cueIds) {
  const next = state.deptNext?.[departmentId];
  if (next) return next;
  const playheads = new Set(Object.values(state.playheads || {}));
  return cueIds.find((id) => playheads.has(id)) || "";
}

function renderStandbys() {
  loadTargetCues();
  const allowed = view.department.pageTargets || [];
  const targets = allDepartments.filter((department) =>
    department.id !== view.department.id && (!allowed.length || allowed.includes(department.id)));
  const cueMap = new Map((state.cues || []).map((cue) => [cue.uniqueID, cue]));
  const labels = { standby: "Standby", ready: "Standing by ✓", go: "GO" };
  setHtml($("#lightRows"), targets.length
    ? targets.map((department) => {
      const light = state.cueLights?.[department.id];
      const cueIds = (targetCues.get(department.id) || []).filter((cueId) => cueMap.has(cueId));
      const chosen = standbyChoice.has(department.id) ? standbyChoice.get(department.id) : targetNextCue(department.id, cueIds);
      const id = escapeHtml(department.id);
      const options = [`<option value="">No particular cue</option>`, ...cueIds.map((cueId) => {
        const cue = cueMap.get(cueId);
        return `<option value="${escapeHtml(cueId)}" ${cueId === chosen ? "selected" : ""}>${escapeHtml(`${cue.number ? `${cue.number} · ` : ""}${cueName(cue)}`)}</option>`;
      })].join("");
      return `
        <div class="light-row" data-state="${escapeHtml(light?.state || "off")}">
          <span class="light-name"><span class="dept-dot" style="--dept:${COLORS[department.color] || COLORS.blue}"></span>${escapeHtml(department.name)}${department.followStandby ? ' <span class="badge">follows</span>' : ""}</span>
          <span class="light-status">${escapeHtml(labels[light?.state] || "Off")}${light?.cue ? ` · ${escapeHtml(light.cue)}` : ""}</span>
          <span class="light-controls">
            <select data-light-cue="${id}" aria-label="Cue for ${escapeHtml(department.name)}">${options}</select>
            <button type="button" class="light-standby-button" data-light="standby" data-target="${id}">Standby</button>
            <button type="button" class="light-go-button" data-light="go" data-target="${id}" ${light ? "" : "disabled"}>GO</button>
            <button type="button" class="secondary" data-light="clear" data-target="${id}" ${light ? "" : "disabled"} aria-label="Clear">✕</button>
          </span>
        </div>`;
    }).join("")
    : `<p class="quiet">No departments to send standbys to. Add departments in Admin, or allow this department to call them.</p>`);
}

function setupStandbys() {
  $("#lightRows").addEventListener("change", (event) => {
    const select = event.target.closest("[data-light-cue]");
    if (select) standbyChoice.set(select.dataset.lightCue, select.value);
  });
  $("#lightRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-light]");
    if (!button) return;
    const target = button.dataset.target;
    const cueId = $(`[data-light-cue="${CSS.escape(target)}"]`)?.value || "";
    const labels = { standby: "Standby sent", go: "GO sent", clear: "Cleared" };
    act({ action: "cueLight", target, light: button.dataset.light, cueId }, labels[button.dataset.light]);
    // After a GO or clear, go back to suggesting the department's next cue.
    if (button.dataset.light !== "standby") standbyChoice.delete(target);
  });
}

// --- Cue panel: start, standby, start from a point, pause, skip ---

function setupCuePanel() {
  const panel = $("#cuePanel");
  document.addEventListener("click", (event) => {
    const row = event.target.closest("[data-open-cue]");
    if (!row) return;
    openCuePanel(row.dataset.openCue);
  });
  panel.addEventListener("close", () => {
    openCue = null;
  });

  $("#panelAck").addEventListener("click", () => act({ action: "cueLightAck" }, "Standing by"));
  $("#panelStart").addEventListener("click", () => cueAction("start", "Started"));
  $("#panelStop").addEventListener("click", () => cueAction("stop", "Stopped"));
  $("#panelStandby").addEventListener("click", async () => {
    if (await cueAction("standby", "Standing by")) panel.close();
  });
  $("#panelPause").addEventListener("click", () => {
    const paused = liveTiming(state.time?.[openCue?.cueId]).paused;
    cueAction(paused ? "resumeCue" : "pauseCue", paused ? "Resumed" : "Paused");
  });
  $("#panelStartFrom").addEventListener("click", () => {
    cueAction("startAt", `Started at ${formatTenths(Number($("#scrubRange").value))}`, { time: Number($("#scrubRange").value) });
  });

  const range = $("#scrubRange");
  range.addEventListener("input", () => {
    scrubbing = true;
    $("#scrubValue").textContent = formatTenths(Number(range.value));
  });
  // While a cue is running, letting go of the slider jumps it to that point.
  range.addEventListener("change", () => {
    scrubbing = false;
    if (isOpenCueRunning()) cueAction("seek", `Jumped to ${formatTenths(Number(range.value))}`, { time: Number(range.value) });
  });
  for (const button of document.querySelectorAll("[data-skip]")) {
    button.addEventListener("click", () => {
      const live = liveTiming(state.time?.[openCue?.cueId]);
      const time = Math.max(0, Math.min(openCue.duration || live.duration, live.elapsed + Number(button.dataset.skip)));
      cueAction("seek", `${Number(button.dataset.skip) > 0 ? "Forward" : "Back"} ${Math.abs(Number(button.dataset.skip))}s`, { time });
    });
  }

  // Keep the scrub bar following the cue while it plays.
  const follow = () => {
    requestAnimationFrame(follow);
    if (!openCue || scrubbing || !isOpenCueRunning()) return;
    const live = liveTiming(state.time?.[openCue.cueId]);
    range.value = String(live.elapsed);
    $("#scrubValue").textContent = formatTenths(live.elapsed);
  };
  requestAnimationFrame(follow);
}

async function openCuePanel(cueId) {
  openCue = { cueId, duration: 0, canScrub: false };
  $("#scrubRange").value = "0";
  renderCuePanel();
  const panel = $("#cuePanel");
  if (!panel.open) panel.showModal();
  try {
    const response = await deptFetch(withQuery("/api/dept/cue", `cueId=${encodeURIComponent(cueId)}`), { cache: "no-store" });
    const info = await response.json();
    if (openCue?.cueId === cueId && response.ok) {
      openCue = info;
      renderCuePanel();
    }
  } catch {
    // Keep the basic panel.
  }
}

function renderCuePanel() {
  const cue = (state.cues || []).find((entry) => entry.uniqueID === openCue.cueId);
  if (!cue) return;
  const running = isOpenCueRunning();
  const live = liveTiming(state.time?.[cue.uniqueID]);
  const duration = openCue.duration || live.duration;
  const notes = getCueNotes(state, cue.uniqueID);
  const standbyIds = new Set(standbyCueIds(Boolean(view.showAll)));

  const light = state.cueLights?.[view.department.id];
  const called = light?.cueId === cue.uniqueID && ["standby", "ready"].includes(light.state);
  $("#panelAck").hidden = !(called && light.state === "standby");
  $("#panelType").textContent = `${formatType(cue.type)}${called ? ` · standby from ${light.by || "stage manager"}` : standbyIds.has(cue.uniqueID) ? " · next" : ""}`;
  $("#panelNumber").textContent = cue.number || "";
  $("#panelName").textContent = cueName(cue);
  $("#panelNotes").hidden = !notes;
  $("#panelNotes").textContent = notes;

  $("#panelRunning").hidden = !running;
  for (const id of ["panelElapsed", "panelRemaining"]) $(`#${id}`).dataset.cue = cue.uniqueID;
  $("#panelState").textContent = live.paused ? "Paused" : "Playing";
  $("#panelState").dataset.state = live.paused ? "pending" : "on";

  const canScrub = openCue.canScrub && duration > 0;
  $("#panelScrub").hidden = !canScrub;
  $("#skipButtons").hidden = !running;
  $("#scrubRange").max = String(duration || 100);
  $("#scrubDuration").textContent = formatTenths(duration);
  if (!running && !scrubbing) $("#scrubValue").textContent = formatTenths(Number($("#scrubRange").value));

  $("#panelStart").hidden = running;
  $("#panelStartFrom").hidden = running || !canScrub;
  $("#panelPause").hidden = !running;
  $("#panelPause").textContent = live.paused ? "Resume" : "Pause";
  $("#panelStop").hidden = !running;
  $("#panelStandby").hidden = standbyIds.has(cue.uniqueID);
  $("#panelHint").textContent = canScrub
    ? (running ? "Drag the bar or use the skip buttons to jump." : "Drag the bar to choose where it starts, then press “Start from here”.")
    : "";
}

function isOpenCueRunning() {
  return Boolean(openCue && (state.running || []).some((cue) => cue.uniqueID === openCue.cueId));
}

function cueAction(action, label, extra = {}) {
  if (!openCue) return Promise.resolve(false);
  return act({ action, cueId: openCue.cueId, ...extra }, label);
}

// --- Buttons ---

function setupButtons() {
  $("#logoutButton").addEventListener("click", async () => {
    // A testing-mode tab only forgets its own login; otherwise sign this device out.
    if (!adminDept && tabLogin()) setTabLogin("");
    else if (!adminDept) await fetch("/api/logout", { method: "POST" });
    window.location.href = adminDept ? "/admin.html" : "/login.html";
  });
  $("#menuButton").addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    $("#menuButton").setAttribute("aria-expanded", String(open));
  });
  $("#stopAllButton").addEventListener("click", () => act({ action: "stopAll" }, "Stopped"));
  $("#cueSearch").addEventListener("input", render);
  $("#cueSearch").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    // Enter on an exact cue number opens that cue.
    const value = event.target.value.trim().toLowerCase();
    const cue = (state.cues || []).find((entry) => String(entry.number || "").toLowerCase() === value);
    if (cue && document.querySelector(`[data-open-cue="${CSS.escape(cue.uniqueID)}"]`)) openCuePanel(cue.uniqueID);
  });

  document.addEventListener("click", (event) => {
    const deptButton = event.target.closest("[data-act]");
    if (deptButton) {
      const { act: action, list } = deptButton.dataset;
      act({ action, listId: list }, { go: "GO", next: "Next", previous: "Previous" }[action] || action);
      return;
    }
    const showButton = event.target.closest("[data-show]");
    if (showButton) showAct(showButton.dataset.show);
  });

  for (const tab of document.querySelectorAll("[data-side-tab]")) {
    tab.addEventListener("click", () => {
      sideTab = tab.dataset.sideTab;
      writeStored(SIDE_TAB_KEY, sideTab);
      render();
    });
  }

  $("#hardStopButton").addEventListener("click", () => {
    if (window.confirm("Hard stop every cue immediately, with no fade?")) showAct("hardStop");
  });
  $("#intervalStartButton").addEventListener("click", () => {
    showAct("intervalStart", { minutes: Number($("#intervalMinutes").value) || 0 });
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
    if (await showAct("page", { ...pageFields(), text: pageForm.elements.text.value })) pageForm.elements.text.value = "";
  });

  // Hold to panic, so a stray tap can't fade out the show.
  const panic = $("#panicButton");
  let timer = null;
  panic.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    panic.classList.add("holding");
    timer = setTimeout(() => {
      panic.classList.remove("holding");
      showAct("panic");
    }, 800);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
    panic.addEventListener(type, () => {
      clearTimeout(timer);
      panic.classList.remove("holding");
    });
  }
}

function setupKeyboard() {
  const toggle = $("#deptKeyboard");
  toggle.checked = readStored(KEYBOARD_KEY, false);
  toggle.addEventListener("change", () => writeStored(KEYBOARD_KEY, toggle.checked));
  document.addEventListener("keydown", (event) => {
    if (!toggle.checked || event.repeat || event.code !== "Space") return;
    if (event.target.closest("input, select, textarea, button, dialog")) return;
    if (!view) return;
    event.preventDefault();
    if (view.department.permissions?.includes("showGo")) showAct("go");
    else if (view.mode === "sequence" || view.lists[0]) act({ action: "go", listId: view.lists[0]?.id }, "GO");
  });
}

// --- Helpers ---

// Only touch the DOM when a section really changed: rebuilding rows twice a second would
// swallow taps that land mid-rebuild. Live timers update their text in place instead.
function setHtml(element, html) {
  if (renderedHtml.get(element) === html) return;
  renderedHtml.set(element, html);
  element.innerHTML = html;
}

function cueName(cue) {
  return cue.name || cue.listName || cue.type || "";
}

function formatType(type) {
  return String(type || "Cue");
}

function toast(text, isError = false) {
  const element = $("#deptToast");
  element.textContent = text;
  element.dataset.error = isError ? "true" : "false";
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), isError ? 4000 : 1200);
}

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered in private browsing.
  }
}
