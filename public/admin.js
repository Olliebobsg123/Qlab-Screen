const form = document.querySelector("#adminForm");
const connectSavedButton = document.querySelector("#connectSavedButton");
const message = document.querySelector("#adminMessage");

const hostInput = form.elements.host;
const passcodeInput = form.elements.passcode;
const workspaceInput = form.elements.workspaceId;
const autoConnectInput = form.elements.autoConnect;

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings(false);
});

connectSavedButton.addEventListener("click", async () => {
  await saveSettings(true);
});

async function loadSettings() {
  const response = await fetch("/api/saved-settings");
  const settings = await response.json();
  hostInput.value = settings.host || "";
  workspaceInput.value = settings.workspaceId || "";
  autoConnectInput.checked = Boolean(settings.autoConnect);
  passcodeInput.placeholder = settings.hasPasscode ? "Saved passcode is set" : "QLab passcode";
}

async function saveSettings(connectAfterSave) {
  const payload = Object.fromEntries(new FormData(form));
  payload.autoConnect = autoConnectInput.checked || connectAfterSave;

  setBusy(true);
  message.textContent = "";

  try {
    const response = await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save settings.");

    passcodeInput.value = "";
    passcodeInput.placeholder = data.settings.hasPasscode ? "Saved passcode is set" : "QLab passcode";
    message.textContent = data.state?.connected ? "Saved and connected." : "Saved.";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  for (const element of form.elements) element.disabled = isBusy;
  connectSavedButton.disabled = isBusy;
}

// --- QLab control settings ---

const controlEnabled = document.querySelector("#controlEnabled");
const controlState = document.querySelector("#controlState");
const controlToken = document.querySelector("#controlToken");
const controlExample = document.querySelector("#controlExample");
const controlMessage = document.querySelector("#controlMessage");
const networkList = document.querySelector("#networkList");
let networkInfo = null;

loadControl();
loadNetwork();

controlEnabled.addEventListener("change", async () => {
  if (controlEnabled.checked && !window.confirm("Allow devices with the admin login or control token to send GO, stop and panic to QLab?")) {
    controlEnabled.checked = false;
    return;
  }
  await saveControl({ enabled: controlEnabled.checked });
});

document.querySelector("#regenerateTokenButton").addEventListener("click", async () => {
  if (!window.confirm("Create a new token? Stream Deck / Companion buttons using the old token will stop working.")) return;
  await saveControl({ regenerateToken: true });
});

document.querySelector("#copyTokenButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(controlToken.value);
    controlMessage.textContent = "Token copied.";
  } catch {
    controlToken.select();
    controlMessage.textContent = "Select the token and copy it manually.";
  }
});

async function loadControl() {
  const response = await fetch("/api/admin/control", { cache: "no-store" });
  renderControl(await response.json());
}

async function saveControl(changes) {
  controlMessage.textContent = "";
  try {
    const response = await fetch("/api/admin/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save control settings.");
    renderControl(data);
    controlMessage.textContent = "Saved.";
  } catch (error) {
    controlMessage.textContent = error.message;
  }
}

function renderControl(control) {
  controlEnabled.checked = Boolean(control.enabled);
  controlState.textContent = control.enabled ? "On" : "Off (read-only)";
  controlToken.value = control.token || "";
  const base = networkInfo?.urls?.[0]?.http || window.location.origin;
  controlExample.textContent = [
    "# Stream Deck (API Ninja / Web Requests) or Companion (Generic HTTP): POST with header",
    `X-Control-Token: ${control.token}`,
    "",
    `curl -X POST -H "X-Control-Token: ${control.token}" ${base}/api/control/go`,
    "",
    "# Actions: " + (control.actions || []).map((action) => action.id).join(", "),
    "# Cue actions take JSON, e.g. -H 'Content-Type: application/json' -d '{\"cue\":\"42\"}' .../api/control/startCue"
  ].join("\n");
}

async function loadNetwork() {
  try {
    networkInfo = await fetch("/api/admin/network", { cache: "no-store" }).then((response) => response.json());
  } catch {
    networkList.textContent = "Could not load network addresses.";
    return;
  }
  loadControl();

  if (!networkInfo.urls.length) {
    networkList.textContent = "No network connection found on the server.";
    return;
  }

  const pages = [
    ["Monitor", (url) => `${url.http}/`],
    ["TV dashboard", (url) => `${url.http}/dashboard.html`],
    ["Control", (url) => `${url.http}/control.html`],
    ["MIDI (HTTPS)", (url) => url.https ? `${url.https}/midi.html` : ""]
  ];

  networkList.innerHTML = networkInfo.urls.map((url) => `
    <div class="network-group">
      <strong>${escapeText(url.interface)} · ${escapeText(url.address)}</strong>
      <div class="qr-grid">
        ${pages.map(([label, build]) => {
          const link = build(url);
          if (!link) return "";
          return `
            <figure class="qr-card">
              <img src="/api/admin/qr.svg?text=${encodeURIComponent(link)}" alt="QR code for ${escapeText(label)}" width="160" height="160">
              <figcaption><span>${escapeText(label)}</span><a href="${escapeText(link)}">${escapeText(link)}</a></figcaption>
            </figure>`;
        }).join("")}
      </div>
    </div>
  `).join("");
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
