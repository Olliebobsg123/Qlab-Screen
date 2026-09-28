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
    $("#deptEyebrow").textContent = adminDept ? "Department (admin view)" : "Department";
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
  const owned = new Set(view.cueIds);
  const running = (state.running || []).filter((cue) => owned.has(cue.uniqueID));
  const runningIds = new Set(running.map((cue) => cue.uniqueID));
  const playheads = state.playheads || {};
  const standbyIds = new Set(view.lists.map((list) => playheads[list.id]).filter(Boolean));

  const qlab = $("#deptQlab");
  qlab.dataset.state = state.connected ? "on" : "off";
  qlab.textContent = state.connected ? "QLab connected" : "QLab offline";

  const notice = $("#deptNotice");
  const problems = [];
  if (state.connected === false) problems.push("QLab isn't connected right now.");
  if (state.controlEnabled === false) problems.push("Cue control is switched off by the admin, so buttons won't do anything.");
  if (!view.cueIds.length) problems.push("No cues are assigned to this department yet. Ask the admin to choose your cue list in Admin → Departments.");
  notice.textContent = problems.join(" ");
  notice.hidden = !problems.length;

  // One GO card per cue list the department owns.
  $("#goCards").innerHTML = view.lists.map((list) => {
    const standby = cueMap.get(playheads[list.id]);
    const notes = getCueNotes(state, standby?.uniqueID);
    return `
      <div class="panel go-card">
        <div class="go-card-head">
          <span class="eyebrow">${escapeHtml(list.name)} · next</span>
          <div class="go-next">
            <strong class="go-number">${escapeHtml(standby?.number || "–")}</strong>
            <strong class="go-name">${escapeHtml(standby ? cueName(standby) : "End of list")}</strong>
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

  const cues = (state.cues || []).filter((cue) => owned.has(cue.uniqueID));
  $("#deptCueCount").textContent = `${cues.length} cue${cues.length === 1 ? "" : "s"}`;
  const listIds = new Set(view.lists.map((list) => list.id));
  const cuesEl = $("#deptCues");
  cuesEl.classList.toggle("empty", !cues.length);
  cuesEl.innerHTML = cues.length
    ? cues.map((cue) => {
      const isRunning = runningIds.has(cue.uniqueID);
      const isNext = standbyIds.has(cue.uniqueID);
      const inOwnList = listIds.has(rootList(cue, cueMap));
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
  renderPageOverlay(state.page, { pageKind: "department", dept: view?.department.id });
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
    const firstList = view?.lists[0];
    if (!firstList) return;
    event.preventDefault();
    act({ action: "go", listId: firstList.id }, "GO");
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
