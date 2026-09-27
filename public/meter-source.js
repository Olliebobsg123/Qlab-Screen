const $ = (selector) => document.querySelector(selector);
const notice = $("#meterNotice");
const inputSelect = $("#meterInput");
const labelInput = $("#meterLabel");
const startButton = $("#meterStart");
const stopButton = $("#meterStop");
const preview = $("#meterPreview");
const SEND_INTERVAL_MS = 100;
const CHANNELS = 2;

let audioContext = null;
let stream = null;
let timer = null;

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  showSecureNotice();
} else {
  listInputs();
}

$("#meterForm").addEventListener("submit", (event) => {
  event.preventDefault();
  start();
});
stopButton.addEventListener("click", stop);

async function showSecureNotice() {
  startButton.disabled = true;
  const network = await fetch("/api/admin/network").then((response) => response.json()).catch(() => ({}));
  const httpsUrl = network.httpsPort ? `https://${location.hostname}:${network.httpsPort}/meter-source.html` : "";
  notice.textContent = httpsUrl
    ? `Browsers only allow audio input on secure pages. Open ${httpsUrl} (or use http://localhost on the server itself).`
    : "Browsers only allow audio input on secure (HTTPS) pages or on localhost.";
  notice.hidden = false;
}

async function listInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const inputs = devices.filter((device) => device.kind === "audioinput");
  inputSelect.innerHTML = `<option value="">Default input</option>` + inputs
    .filter((device) => device.deviceId && device.deviceId !== "default")
    .map((device, index) => `<option value="${escapeText(device.deviceId)}">${escapeText(device.label || `Input ${index + 1}`)}</option>`)
    .join("");
}

async function start() {
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputSelect.value ? { exact: inputSelect.value } : undefined,
        channelCount: { ideal: CHANNELS },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } catch (error) {
    notice.textContent = `Could not open the audio input: ${error.message}`;
    notice.hidden = false;
    return;
  }

  // Labels only become visible after permission is granted.
  const selected = inputSelect.value;
  await listInputs();
  inputSelect.value = selected;

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const channelCount = Math.min(CHANNELS, source.channelCount || 1);
  const splitter = audioContext.createChannelSplitter(channelCount);
  source.connect(splitter);
  const analysers = Array.from({ length: channelCount }, (_, index) => {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    splitter.connect(analyser, index);
    return analyser;
  });
  const buffer = new Float32Array(2048);

  startButton.disabled = true;
  stopButton.disabled = false;
  timer = setInterval(() => {
    const levels = analysers.map((analyser) => {
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      let sum = 0;
      for (const sample of buffer) {
        const value = Math.abs(sample);
        if (value > peak) peak = value;
        sum += sample * sample;
      }
      return { peak, rms: Math.sqrt(sum / buffer.length) };
    });
    renderPreview(levels);
    fetch("/api/admin/meters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: labelInput.value, levels }),
      keepalive: true
    }).catch(() => {});
  }, SEND_INTERVAL_MS);
}

function stop() {
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
  startButton.disabled = !window.isSecureContext;
  stopButton.disabled = true;
}

function renderPreview(levels) {
  if (preview.children.length !== levels.length) {
    preview.innerHTML = levels.map(() => `<div class="meter"><span class="meter-rms"></span><span class="meter-peak"></span></div>`).join("");
  }
  levels.forEach((level, index) => {
    const meter = preview.children[index];
    meter.querySelector(".meter-rms").style.width = `${toPercent(level.rms)}%`;
    meter.querySelector(".meter-peak").style.left = `${toPercent(level.peak)}%`;
  });
}

function toPercent(amplitude) {
  if (amplitude <= 0) return 0;
  return Math.max(0, Math.min(100, ((20 * Math.log10(amplitude) + 60) / 60) * 100));
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
