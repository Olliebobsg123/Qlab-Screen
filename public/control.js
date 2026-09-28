import {
  cueLabel,
  escapeHtml,
  getCueNotes,
  getStandbyCue,
  sendControl,
  showClockInfo,
  subscribeState
} from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const controlWorkspace = $("#controlWorkspace");
const controlStatus = $("#controlStatus");
const disabledNotice = $("#controlDisabledNotice");
const standbyNumber = $("#controlStandbyNumber");
const standbyName = $("#controlStandbyName");
const standbyNotes = $("#controlStandbyNotes");
const runningList = $("#controlRunning");
const showClock = $("#controlShowClock");
const pageStatus = $("#pageStatus");
const message = $("#controlMessage");
const panicButton = $("#panicButton");
const keyboardToggle = $("#keyboardToggle");
const KEYBOARD_KEY = "qlab-control-keyboard";
const PANIC_HOLD_MS = 800;

let state = {};
let messageTimer = null;

subscribeState("control", (nextState, online) => {
  state = nextState;
  document.body.classList.toggle("server-offline", !online);
  render();
});
setInterval(renderClock, 1000);

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  run(button.dataset.action);
});

$("#intervalStartButton").addEventListener("click", () => {
  run("intervalStart", { minutes: Number($("#intervalMinutes").value) || 0 });
});

$("#hardStopButton").addEventListener("click", () => {
  if (window.confirm("Hard stop every cue immediately, with no fade?")) run("hardStop");
});

$("#cueForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.cueAction || "startCue";
  run(action, { cue: event.target.elements.cue.value.trim() });
});

for (const button of document.querySelectorAll("[data-page]")) {
  button.addEventListener("click", () => {
    const form = $("#pageForm").elements;
    run("page", {
      text: button.dataset.page,
      level: button.dataset.level || form.level.value,
      target: form.target.value,
      durationSec: Number(form.durationSec.value) || 0
    });
  });
}

$("#pageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target.elements;
  if (!form.text.value.trim()) return showMessage("Type a message first.");
  run("page", {
    text: form.text.value,
    level: form.level.value,
    target: form.target.value,
    durationSec: Number(form.durationSec.value) || 0
  }).then((ok) => {
    if (ok) form.text.value = "";
  });
});

addDepartmentTargets();
setupPanicHold();
setupKeyboard();

async function run(action, body = {}) {
  try {
    const result = await sendControl(action, { ...body, source: "control page" });
    if (result.status === "debounced") return true;
    showMessage(`${labelFor(action)} sent.`);
    return true;
  } catch (error) {
    showMessage(error.message, true);
    return false;
  }
}

function render() {
  controlWorkspace.textContent = state.workspaceName || "Waiting for QLab";
  controlStatus.textContent = state.connected ? "Connected" : (state.lastError || "Disconnected");
  document.body.classList.toggle("qlab-connected", Boolean(state.connected));
  const controlEnabled = Boolean(state.controlEnabled);
  disabledNotice.hidden = controlEnabled;
  for (const element of document.querySelectorAll("[data-qlab]")) {
    element.disabled = !controlEnabled || !state.connected;
  }

  const cueMap = new Map((state.cues || []).map((cue) => [cue.uniqueID, cue]));
  const standby = getStandbyCue(state, cueMap);
  const notes = getCueNotes(state, standby?.uniqueID);
  standbyNumber.textContent = standby?.number || "-";
  standbyName.textContent = standby ? cueLabel(standby) : (state.connected ? "No standby cue" : "-");
  standbyNotes.hidden = !notes;
  standbyNotes.textContent = notes;

  const running = (state.running || []).filter((cue) => cue.type !== "Cue List");
  runningList.innerHTML = running.length
    ? running.map((cue) => `<div><strong>${escapeHtml(cue.number || "-")}</strong> ${escapeHtml(cueLabel(cue))}</div>`).join("")
    : "Nothing running.";

  pageStatus.textContent = state.page ? `Showing: “${state.page.text}”` : "No active call";
  renderClock();
}

function renderClock() {
  const clock = showClockInfo(state.show);
  showClock.textContent = clock.state === "idle" ? clock.value : `${clock.label} ${clock.value}`;
  showClock.dataset.state = clock.state;
}

function setupPanicHold() {
  let timer = null;
  const start = (event) => {
    if (panicButton.disabled) return;
    event.preventDefault();
    panicButton.classList.add("holding");
    timer = setTimeout(() => {
      panicButton.classList.remove("holding");
      run("panic");
    }, PANIC_HOLD_MS);
  };
  const cancel = () => {
    clearTimeout(timer);
    panicButton.classList.remove("holding");
  };
  panicButton.addEventListener("pointerdown", start);
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) panicButton.addEventListener(type, cancel);
  panicButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") start(event);
  });
  panicButton.addEventListener("keyup", cancel);
}

function setupKeyboard() {
  try {
    keyboardToggle.checked = localStorage.getItem(KEYBOARD_KEY) === "1";
  } catch {
    keyboardToggle.checked = false;
  }
  keyboardToggle.addEventListener("change", () => {
    try {
      localStorage.setItem(KEYBOARD_KEY, keyboardToggle.checked ? "1" : "0");
    } catch {
      // Private browsing: the setting just won't persist.
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!keyboardToggle.checked || event.repeat) return;
    if (event.target.closest("input, select, textarea")) return;
    if (event.code === "Space") {
      event.preventDefault();
      run("go");
    } else if (event.key === "Escape") {
      run("panic");
    }
  });
}

function labelFor(action) {
  return {
    go: "GO",
    next: "Next",
    previous: "Previous",
    pause: "Pause all",
    resume: "Resume all",
    stop: "Stop all",
    panic: "Panic",
    hardStop: "Hard stop",
    startCue: "Start cue",
    standby: "Set standby",
    showStart: "Show start",
    showEnd: "Show end",
    intervalStart: "Interval start",
    intervalEnd: "Interval end",
    page: "Page",
    clearPage: "Clear page"
  }[action] || action;
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.dataset.error = isError ? "true" : "false";
  message.classList.add("visible");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => message.classList.remove("visible"), isError ? 5000 : 1800);
}

// Let calls go to the departments set up in Admin as well as the built-in groups.
async function addDepartmentTargets() {
  const { departments = [] } = await fetch("/api/departments").then((response) => response.json()).catch(() => ({}));
  if (!departments.length) return;
  const select = $("#pageForm").elements.target;
  const group = document.createElement("optgroup");
  group.label = "Departments";
  for (const department of departments) {
    const option = document.createElement("option");
    option.value = department.id;
    option.textContent = department.name;
    group.append(option);
  }
  select.append(group);
}
