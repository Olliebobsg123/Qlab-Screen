import { CommsClient } from "/comms.js";
import { escapeHtml } from "/shared.js";

// The comms dock on department pages: a bar at the bottom of the screen with a TALK button for
// your main channel, and a panel with every channel (listen, talk, volume) and the show feed.
// TALK: hold to talk, or double-tap to keep talking (tap again to stop).

const DOUBLE_TAP_MS = 320;
const PREFS_KEY = "qlab-comms-prefs";

export async function setupComms({ fetchComms }) {
  const dock = document.querySelector("#commsDock");
  const button = document.querySelector("#commsButton");
  const info = await fetchComms().catch(() => null);
  if (!info?.enabled) return;
  button.hidden = false;

  let client = null;
  let expanded = false;
  let builtKey = "";
  const prefs = readPrefs();

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    button.addEventListener("click", () => {
      dock.hidden = !dock.hidden;
    });
    const secureUrl = `https://${location.hostname}:${info.httpsPort}${location.pathname}${location.search}`;
    dock.innerHTML = `
      <div class="comms-bar">
        <strong>Comms</strong>
        <span class="comms-note">Talking needs the secure page (browsers only allow microphones there).</span>
        <a class="button-link" href="${escapeHtml(secureUrl)}">Open secure page</a>
      </div>`;
    return;
  }

  button.addEventListener("click", () => {
    dock.hidden = !dock.hidden;
    if (!dock.hidden) render();
  });

  dock.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-comms]");
    if (!target) return;
    const action = target.dataset.comms;
    if (action === "join") {
      client = new CommsClient({ mode: "user", getTicket: fetchComms, onChange: () => update(), echoCancellation: Boolean(prefs.noHeadphones) });
      for (const id of prefs.listen || []) client.listen.add(id);
      Object.assign(client.volumes, prefs.volumes || {});
      client.feedOn = Boolean(prefs.feed);
      await client.start();
      render();
    } else if (action === "leave") {
      client?.stop();
      client = null;
      render();
    } else if (action === "expand") {
      expanded = !expanded;
      render();
    }
  });
  dock.addEventListener("change", (event) => {
    if (!client) return;
    const listen = event.target.closest("[data-listen]");
    if (listen) client.setListen(listen.dataset.listen, listen.checked);
    if (event.target.closest("[data-feed]")) client.setFeed(event.target.checked);
    if (event.target.closest("[data-no-headphones]")) {
      // Echo cancelling is set when the mic opens: rejoin to apply it.
      prefs.noHeadphones = event.target.checked;
      savePrefs();
      client.stop();
      client = new CommsClient({ mode: "user", getTicket: fetchComms, onChange: () => update(), echoCancellation: prefs.noHeadphones });
      for (const id of prefs.listen || []) client.listen.add(id);
      Object.assign(client.volumes, prefs.volumes || {});
      client.feedOn = Boolean(prefs.feed);
      client.start().then(render);
      return;
    }
    savePrefs();
  });
  dock.addEventListener("input", (event) => {
    const slider = event.target.closest("[data-volume]");
    if (slider && client) {
      client.setVolume(slider.dataset.volume, Number(slider.value));
      savePrefs();
    }
  });

  // Hold to talk; double-tap to latch.
  const lastTap = new Map();
  dock.addEventListener("pointerdown", (event) => {
    const talk = event.target.closest("[data-talk]");
    if (!talk || !client) return;
    event.preventDefault();
    talk.setPointerCapture?.(event.pointerId);
    const channel = talk.dataset.talk;
    const now = Date.now();
    if (client.latched.has(channel)) {
      client.stopTalking(channel, true);
      lastTap.delete(channel);
      return;
    }
    if (now - (lastTap.get(channel) || 0) < DOUBLE_TAP_MS) {
      client.toggleLatch(channel);
      lastTap.delete(channel);
      return;
    }
    lastTap.set(channel, now);
    client.startTalking(channel);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    dock.addEventListener(type, (event) => {
      const talk = event.target.closest("[data-talk]");
      if (talk && client) client.stopTalking(talk.dataset.talk);
    });
  }
  // Right-click / long-press menus would steal the press.
  dock.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-talk]")) event.preventDefault();
  });

  function render() {
    builtKey = "";
    update();
  }

  // Build the controls once per layout, then only update them, so a held TALK button is never
  // replaced mid-press.
  function update() {
    if (dock.hidden) return;
    const joined = Boolean(client);
    const channels = client?.channels?.length ? client.channels : info.channels;
    const allTalk = info.allTalk;
    const key = JSON.stringify([joined, expanded, channels.map((channel) => channel.id), allTalk]);
    if (key !== builtKey) {
      builtKey = key;
      dock.innerHTML = joined ? joinedHtml(channels, allTalk) : `
        <div class="comms-bar">
          <strong>Comms</strong>
          <span class="comms-note">Headphones on, then join. Keep this screen on while you use comms.</span>
          <button type="button" data-comms="join">Join comms</button>
        </div>`;
    }
    if (!joined) return;

    const primary = [...client.listen][0] || channels[0]?.id;
    const talkers = client.peers.filter((peer) => peer.kind === "user" && peer.talking.length);
    const heard = talkers.filter((peer) => client.levelFor(peer) > 0);
    setText(".comms-who", heard.length ? `🔊 ${heard.map((peer) => peer.name).join(", ")}` : `${client.peers.filter((peer) => peer.kind === "user").length} others on comms`);
    setText(".comms-state", client.status === "on"
      ? (client.latencyMs ? `≈${client.latencyMs} ms` : "Connected")
      : client.status === "reconnecting" ? "Reconnecting…" : "Starting…");
    dock.querySelector(".comms-state").dataset.state = client.status;
    const primaryTalk = dock.querySelector(".comms-bar [data-talk]");
    if (primaryTalk) {
      primaryTalk.dataset.talk = primary;
      primaryTalk.textContent = client.latched.has(primary) ? "TALKING (latched)" : `TALK · ${channels.find((channel) => channel.id === primary)?.name || ""}`;
    }
    for (const talk of dock.querySelectorAll("[data-talk]")) {
      talk.classList.toggle("talking", client.talking.has(talk.dataset.talk));
      talk.classList.toggle("latched", client.latched.has(talk.dataset.talk));
      talk.disabled = !client.micTrack;
    }
    for (const row of dock.querySelectorAll("[data-channel-row]")) {
      const id = row.dataset.channelRow;
      row.querySelector("[data-listen]").checked = client.listen.has(id);
      const names = client.talkersOn(id).map((peer) => peer.name);
      row.querySelector(".comms-talkers").textContent = names.length ? `🔊 ${names.join(", ")}` : "";
      row.classList.toggle("active", names.length > 0);
    }
    const feedRow = dock.querySelector("[data-feed-row]");
    if (feedRow) {
      const source = client.feedSource();
      feedRow.querySelector("[data-feed]").checked = client.feedOn;
      feedRow.querySelector(".comms-talkers").textContent = source ? "Live" : "Not being sent right now";
      feedRow.classList.toggle("active", Boolean(source && client.feedOn));
    }
    setText(".comms-error", client.error);
    const parts = client.latencyParts;
    setText(".comms-breakdown", parts
      ? `${parts.fast ? "⚡ Fast comms (app). " : ""}Delay ≈${client.latencyMs} ms: network ${parts.network} ms · buffer ${parts.buffer} ms · devices ${parts.device} ms${parts.buffer > 80 ? " (a big buffer means an uneven connection: move closer to the router or use 5 GHz Wi-Fi)" : ""}`
      : "");
    const meter = dock.querySelector(".comms-mic-level");
    if (meter) meter.style.setProperty("--level", String(Math.min(1, (client.micLevel || 0) * 3)));
  }

  function joinedHtml(channels, allTalk) {
    const primary = [...(client?.listen || [])][0] || channels[0]?.id;
    return `
      <div class="comms-bar">
        <span class="comms-state" data-state="starting"></span>
        <span class="comms-who"></span>
        <span class="comms-mic-level" title="Your microphone"></span>
        <button type="button" class="comms-talk" data-talk="${escapeHtml(primary)}">TALK</button>
        <button type="button" class="tool-button" data-comms="expand" aria-expanded="${expanded}">${expanded ? "Less" : "Channels"}</button>
      </div>
      <div class="comms-body" ${expanded ? "" : "hidden"}>
        ${channels.map((channel) => `
          <div class="comms-row" data-channel-row="${escapeHtml(channel.id)}">
            <label class="comms-listen"><input type="checkbox" data-listen="${escapeHtml(channel.id)}"><span>${escapeHtml(channel.name)}</span></label>
            <span class="comms-talkers"></span>
            <input type="range" min="0" max="1" step="0.05" value="${client?.volumes[channel.id] ?? 0.9}" data-volume="${escapeHtml(channel.id)}" aria-label="${escapeHtml(channel.name)} volume">
            <button type="button" class="comms-talk small" data-talk="${escapeHtml(channel.id)}">TALK</button>
          </div>`).join("")}
        ${allTalk ? `
          <div class="comms-row comms-all">
            <span><strong>All channels</strong></span>
            <span class="comms-talkers"></span>
            <span></span>
            <button type="button" class="comms-talk small" data-talk="*">TALK ALL</button>
          </div>` : ""}
        <div class="comms-row" data-feed-row>
          <label class="comms-listen"><input type="checkbox" data-feed><span>${escapeHtml(client?.feedName || info.feedName)}</span></label>
          <span class="comms-talkers"></span>
          <input type="range" min="0" max="1" step="0.05" value="${client?.volumes.feed ?? 0.8}" data-volume="feed" aria-label="Show feed volume">
          <span></span>
        </div>
        <p class="comms-breakdown quiet"></p>
        <label class="comms-listen comms-option"><input type="checkbox" data-no-headphones ${prefs.noHeadphones ? "checked" : ""}><span>Not using headphones (turns on echo cancelling, adds a little delay)</span></label>
        <p class="comms-error"></p>
        <p class="comms-help quiet">Hold TALK to talk, or double-tap it to stay on (tap again to stop). Use headphones, and keep this screen on.</p>
        <button type="button" class="secondary small-button" data-comms="leave">Leave comms</button>
      </div>`;
  }

  function setText(selector, text) {
    const element = dock.querySelector(selector);
    if (element && element.textContent !== text) element.textContent = text;
  }

  function savePrefs() {
    if (!client) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ listen: [...client.listen], volumes: client.volumes, feed: client.feedOn, noHeadphones: Boolean(prefs.noHeadphones) }));
    } catch {
      // Not remembered in private browsing.
    }
  }

  // Keep the mic level moving smoothly.
  setInterval(() => {
    if (client && !dock.hidden) {
      const meter = dock.querySelector(".comms-mic-level");
      if (meter) meter.style.setProperty("--level", String(Math.min(1, (client.micLevel || 0) * 3)));
    }
  }, 100);

  // For testing.
  window.__comms = () => client;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}
