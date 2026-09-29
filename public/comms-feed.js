import { CommsClient } from "/comms.js";
import { escapeHtml } from "/shared.js";

// Sends one audio input (the show mix) to comms listeners who turn on the show feed.
const $ = (selector) => document.querySelector(selector);
let client = null;
let stream = null;
let analyser = null;

if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
  $("#feedStart").disabled = true;
  fetch("/api/admin/network").then((response) => response.json()).then((network) => {
    $("#feedNotice").textContent = network.httpsPort
      ? `Browsers only allow audio input on secure pages. Open https://${location.hostname}:${network.httpsPort}/comms-feed.html (or http://localhost on this Mac).`
      : "Browsers only allow audio input on secure (HTTPS) pages or on localhost.";
    $("#feedNotice").hidden = false;
  });
} else {
  listInputs();
}

$("#feedForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await start();
});
$("#feedStop").addEventListener("click", stop);

async function listInputs() {
  const selected = $("#feedInput").value;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  $("#feedInput").innerHTML = `<option value="">Default input</option>` + devices
    .filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default")
    .map((device, index) => `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Input ${index + 1}`)}</option>`)
    .join("");
  $("#feedInput").value = selected;
}

async function start() {
  stop();
  try {
    // Music, not voice: no echo cancelling, noise removal or automatic level.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: $("#feedInput").value ? { exact: $("#feedInput").value } : undefined,
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } catch (error) {
    $("#feedNotice").textContent = `Could not open the audio input: ${error.message}`;
    $("#feedNotice").hidden = false;
    return;
  }
  await listInputs();
  client = new CommsClient({
    mode: "feed",
    feedStream: stream,
    getTicket: () => fetch("/api/admin/comms/ticket", { cache: "no-store" }).then((response) => response.json()),
    onChange: render
  });
  await client.start();
  analyser = client.audioContext.createAnalyser();
  analyser.fftSize = 1024;
  client.audioContext.createMediaStreamSource(stream).connect(analyser);
  $("#feedStart").disabled = true;
  $("#feedStop").disabled = false;
  render();
}

function stop() {
  client?.stop();
  client = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  analyser = null;
  $("#feedStart").disabled = false;
  $("#feedStop").disabled = true;
  render();
}

function render() {
  if (!client) {
    $("#feedState").textContent = "Not sending";
    $("#feedListeners").textContent = "";
    return;
  }
  const listening = client.peers.filter((peer) => peer.kind === "user" && peer.feed);
  $("#feedState").textContent = client.status === "on" ? "Sending" : client.status === "reconnecting" ? "Reconnecting…" : "Starting…";
  $("#feedListeners").textContent = listening.length
    ? `Listening: ${listening.map((peer) => peer.name).join(", ")}`
    : `${client.peers.filter((peer) => peer.kind === "user").length} on comms, nobody listening to the feed yet`;
}

const buffer = new Float32Array(1024);
setInterval(() => {
  let peak = 0;
  if (analyser) {
    analyser.getFloatTimeDomainData(buffer);
    for (const value of buffer) peak = Math.max(peak, Math.abs(value));
  }
  $("#feedLevel").style.setProperty("--level", String(Math.min(1, peak)));
}, 100);
