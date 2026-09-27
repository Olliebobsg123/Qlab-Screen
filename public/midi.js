import { escapeHtml, sendControl, subscribeState } from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const secureNotice = $("#secureNotice");
const disabledNotice = $("#controlDisabledNotice");
const accessStatus = $("#midiAccessStatus");
const qlabStatus = $("#qlabStatus");
const armedToggle = $("#armedToggle");
const startButton = $("#midiStartButton");
const inputsEl = $("#midiInputs");
const monitor = $("#midiMonitor");
const form = $("#mappingForm");
const actionSelect = $("#mappingAction");
const learnButton = $("#learnButton");
const mappingMessage = $("#mappingMessage");
const mappingList = $("#mappingList");
const ARMED_KEY = "qlab-midi-armed";
const DISABLED_INPUTS_KEY = "qlab-midi-disabled-inputs";
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const STARTER_LAYOUT = [
  { action: "go", type: "note", number: 60 },
  { action: "next", type: "note", number: 62 },
  { action: "previous", type: "note", number: 59 },
  { action: "pause", type: "note", number: 64 },
  { action: "resume", type: "note", number: 65 },
  { action: "stop", type: "note", number: 67 },
  { action: "panic", type: "note", number: 36 }
];

let midiAccess = null;
let actions = [];
let mappings = [];
let learning = false;
let disabledInputs = new Set(readStored(DISABLED_INPUTS_KEY, []));
const ccValues = new Map();

armedToggle.checked = readStored(ARMED_KEY, true);
armedToggle.addEventListener("change", () => writeStored(ARMED_KEY, armedToggle.checked));
startButton.addEventListener("click", startMidi);
learnButton.addEventListener("click", () => {
  learning = !learning;
  learnButton.textContent = learning ? "Listening… press a key" : "Learn from MIDI";
  learnButton.classList.toggle("learning", learning);
});
form.addEventListener("submit", addMapping);
$("#presetButton").addEventListener("click", addStarterLayout);
mappingList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  saveMappings(mappings.filter((mapping) => mapping.id !== button.dataset.remove));
});

subscribeState("midi", (state, online) => {
  qlabStatus.textContent = !online ? "Server offline" : (state.connected ? `Connected: ${state.workspaceName || ""}` : "Not connected");
  disabledNotice.hidden = Boolean(state.controlEnabled);
});

await loadSettings();
checkEnvironment();

async function loadSettings() {
  const response = await fetch("/api/admin/control", { cache: "no-store" });
  const data = await response.json();
  actions = data.actions || [];
  mappings = data.midiMappings || [];
  actionSelect.innerHTML = actions
    .filter((action) => action.id !== "showReset")
    .map((action) => `<option value="${escapeHtml(action.id)}">${escapeHtml(action.label)}${action.qlab ? "" : " (no QLab)"}</option>`)
    .join("");
  renderMappings();
}

async function checkEnvironment() {
  if (typeof navigator.requestMIDIAccess !== "function" || !window.isSecureContext) {
    startButton.disabled = true;
    if (!window.isSecureContext) {
      const network = await fetch("/api/admin/network").then((response) => response.json()).catch(() => ({}));
      const httpsUrl = network.httpsPort ? `https://${location.hostname}:${network.httpsPort}/midi.html` : "";
      secureNotice.innerHTML = httpsUrl
        ? `Browsers only allow MIDI on secure pages. Open <a href="${escapeHtml(httpsUrl)}">${escapeHtml(httpsUrl)}</a> instead.
           The first time, your browser will warn about the self-signed certificate: choose “Advanced” → “Proceed”.`
        : "Browsers only allow MIDI on secure (HTTPS) pages. Enable HTTPS on the server (HTTPS_PORT) and open this page over https://.";
    } else {
      secureNotice.textContent = "This browser has no Web MIDI support. Use Chrome, Edge, Opera or Firefox on a laptop, desktop or Android device (Safari and iPhone/iPad don't support Web MIDI).";
    }
    secureNotice.hidden = false;
    accessStatus.textContent = "Unavailable";
    return;
  }

  // If permission was already granted, connect straight away.
  const permission = await navigator.permissions?.query({ name: "midi" }).catch(() => null);
  if (permission?.state === "granted") startMidi();
}

async function startMidi() {
  try {
    accessStatus.textContent = "Requesting…";
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    accessStatus.textContent = "Connected";
    startButton.textContent = "Refresh devices";
    midiAccess.onstatechange = renderInputs;
    renderInputs();
  } catch (error) {
    accessStatus.textContent = "Blocked";
    secureNotice.textContent = `MIDI access was refused (${error.message}). Allow MIDI for this site in the browser's site settings, then reload.`;
    secureNotice.hidden = false;
  }
}

function renderInputs() {
  const inputs = Array.from(midiAccess?.inputs.values() || []);
  for (const input of inputs) input.onmidimessage = (event) => handleMidi(input, event);

  inputsEl.classList.toggle("empty", inputs.length === 0);
  inputsEl.innerHTML = inputs.length
    ? inputs.map((input) => `
        <label class="toggle-row">
          <input type="checkbox" data-input="${escapeHtml(input.id)}" ${disabledInputs.has(input.id) ? "" : "checked"}>
          <span>${escapeHtml(input.name || "MIDI input")}${input.manufacturer ? ` · ${escapeHtml(input.manufacturer)}` : ""}${input.state !== "connected" ? " (disconnected)" : ""}</span>
        </label>`).join("")
    : "No MIDI inputs found. Plug in your keyboard, then press “Refresh devices”.";

  for (const checkbox of inputsEl.querySelectorAll("[data-input]")) {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) disabledInputs.delete(checkbox.dataset.input);
      else disabledInputs.add(checkbox.dataset.input);
      writeStored(DISABLED_INPUTS_KEY, Array.from(disabledInputs));
    });
  }
}

function handleMidi(input, event) {
  const message = parseMidi(event.data);
  if (!message) return;
  monitor.textContent = `${input.name || "MIDI"} · ${describe(message)}${message.trigger ? "" : " (release)"}`;
  if (!message.trigger) return;

  if (learning) {
    learning = false;
    learnButton.textContent = "Learn from MIDI";
    learnButton.classList.remove("learning");
    form.elements.type.value = message.type;
    form.elements.channel.value = String(message.channel);
    form.elements.number.value = String(message.number);
    mappingMessage.textContent = `Learned ${describe(message)}. Choose an action and press “Add mapping”.`;
    return;
  }

  if (disabledInputs.has(input.id) || !armedToggle.checked) return;
  for (const mapping of mappings) {
    if (mapping.type !== message.type || mapping.number !== message.number) continue;
    if (mapping.channel && mapping.channel !== message.channel) continue;
    trigger(mapping, message);
  }
}

async function trigger(mapping, message) {
  const row = mappingList.querySelector(`[data-mapping="${CSS.escape(mapping.id)}"]`);
  row?.classList.remove("fired", "failed");
  void row?.offsetWidth;
  try {
    const body = { arg: mapping.arg, source: `MIDI ${describe(message)}` };
    if (mapping.action === "page") body.text = mapping.arg;
    if (mapping.action === "intervalStart") body.minutes = Number(mapping.arg) || 0;
    await sendControl(mapping.action, body);
    row?.classList.add("fired");
  } catch (error) {
    row?.classList.add("failed");
    monitor.textContent = `${describe(message)} → ${error.message}`;
  }
}

// Returns { type, channel (1-16), number, trigger } or null for messages we ignore.
function parseMidi(data) {
  const [status, data1 = 0, data2 = 0] = data;
  const kind = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (kind === 0x90 || kind === 0x80) {
    return { type: "note", channel, number: data1, value: data2, trigger: kind === 0x90 && data2 > 0 };
  }
  if (kind === 0xb0) {
    // Fire once when a CC crosses the halfway point, so faders and sustain pedals act like buttons.
    const key = `${channel}:${data1}`;
    const previous = ccValues.get(key) ?? 0;
    ccValues.set(key, data2);
    return { type: "cc", channel, number: data1, value: data2, trigger: data2 >= 64 && previous < 64 };
  }
  if (kind === 0xc0) {
    return { type: "program", channel, number: data1, value: 0, trigger: true };
  }
  return null;
}

function describe(message) {
  const channel = message.channel ? `ch ${message.channel}` : "any ch";
  if (message.type === "note") return `Note ${noteName(message.number)} (${message.number}) ${channel}`;
  if (message.type === "cc") return `CC ${message.number} ${channel}`;
  return `Program ${message.number} ${channel}`;
}

function noteName(number) {
  return `${NOTE_NAMES[number % 12]}${Math.floor(number / 12) - 1}`;
}

async function addMapping(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const mapping = {
    action: data.action,
    arg: String(data.arg || "").trim(),
    type: data.type,
    channel: Number(data.channel) || 0,
    number: Number(data.number)
  };
  const needsArg = ["startCue", "stopCue", "standby", "page"].includes(mapping.action);
  if (needsArg && !mapping.arg) {
    mappingMessage.textContent = "This action needs a cue number or message.";
    return;
  }
  await saveMappings([...mappings.filter((existing) => !sameTrigger(existing, mapping)), mapping]);
  form.elements.arg.value = "";
}

async function addStarterLayout() {
  const additions = STARTER_LAYOUT.map((mapping) => ({ ...mapping, channel: 0, arg: "" }));
  await saveMappings([
    ...mappings.filter((existing) => !additions.some((mapping) => sameTrigger(existing, mapping))),
    ...additions
  ]);
}

function sameTrigger(left, right) {
  return left.type === right.type && left.number === right.number && Number(left.channel) === Number(right.channel);
}

async function saveMappings(nextMappings) {
  try {
    const response = await fetch("/api/admin/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ midiMappings: nextMappings })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save mappings.");
    mappings = data.midiMappings;
    mappingMessage.textContent = "Mappings saved.";
    renderMappings();
  } catch (error) {
    mappingMessage.textContent = error.message;
  }
}

function renderMappings() {
  const labels = new Map(actions.map((action) => [action.id, action.label]));
  const sorted = [...mappings].sort((left, right) => left.type.localeCompare(right.type) || left.number - right.number);
  mappingList.classList.toggle("empty", sorted.length === 0);
  mappingList.innerHTML = sorted.length
    ? sorted.map((mapping) => `
        <div class="mapping-row" data-mapping="${escapeHtml(mapping.id)}">
          <strong>${escapeHtml(describe(mapping))}</strong>
          <span>→ ${escapeHtml(labels.get(mapping.action) || mapping.action)}${mapping.arg ? ` <em>${escapeHtml(mapping.arg)}</em>` : ""}</span>
          <button type="button" class="secondary" data-remove="${escapeHtml(mapping.id)}">Remove</button>
        </div>`).join("")
    : "No mappings yet. Use “Learn from MIDI” or add the starter layout (C4 = GO).";
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
    // Not persisted in private browsing.
  }
}
