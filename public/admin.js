const form = document.querySelector("#adminForm");
const connectSavedButton = document.querySelector("#connectSavedButton");
const message = document.querySelector("#adminMessage");

const hostInput = form.elements.host;
const passcodeInput = form.elements.passcode;
const workspaceInput = form.elements.workspaceId;
const autoConnectInput = form.elements.autoConnect;

let savedWorkspace = "";

loadSettings().then(loadQlabInfo);
setInterval(loadQlabInfo, 5000);

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
  savedWorkspace = settings.workspaceId || "";
  setWorkspaceOptions([]);
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
    ["Departments", (url) => `${url.http}/login.html`],
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

// --- Departments ---

const deptEditor = document.querySelector("#deptEditor");
const deptMessage = document.querySelector("#deptMessage");
const DEPT_COLORS = ["blue", "red", "orange", "yellow", "green", "purple", "magenta", "gray"];
const CUE_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "magenta", "gray"];
// Every QLab cue type (QLab 5, plus QLab 4's OSC cue). Types in the current show are listed first with counts.
const QLAB_CUE_TYPES = [
  "Audio", "Mic", "Video", "Camera", "Text", "Light", "Fade", "Network", "OSC", "MIDI", "MIDI File", "Timecode",
  "Group", "Start", "Stop", "Pause", "Load", "Reset", "Devamp", "GoTo", "Target", "Arm", "Disarm", "Wait", "Memo", "Script"
];
let typeCounts = {};
const PERMISSIONS = [
  ["showGo", "Show GO", "GO, next and previous for the whole show"],
  ["transport", "Stop & panic", "Pause, resume, stop all, panic and hard stop"],
  ["anyCue", "Any cue", "See the whole show and start, stop or standby any cue"],
  ["paging", "Backstage calls", "Send calls to screens"],
  ["showClock", "Show clock", "Start and end the show and intervals"],
  ["scrub", "Start from / skip", "Choose where audio and video cues start, pause them, and skip or scrub while they play"]
];
const CALL_TARGETS = [["all", "Every screen"], ["dashboard", "TV dashboards"], ["monitor", "Monitors"]];
let departments = [];
let cueListOptions = [];

loadDepartments();
document.querySelector("#addDeptButton").addEventListener("click", () => {
  readDepartmentEdits();
  departments.push({ id: `dept${Date.now().toString(36)}`, name: "", color: DEPT_COLORS[departments.length % DEPT_COLORS.length], cueListIds: [], cueTypes: [], cueColors: [], namePrefixes: [], permissions: [], hasPassword: false, isNew: true });
  renderDepartments();
  deptEditor.querySelector(".dept-card:last-child input[name=name]")?.focus();
});
document.querySelector("#saveDeptButton").addEventListener("click", saveDepartments);
// Only show "Can send calls to" for departments allowed to send calls.
deptEditor.addEventListener("change", (event) => {
  if (event.target.name !== "permission" || event.target.value !== "paging") return;
  event.target.closest(".dept-card").querySelector(".call-targets").hidden = !event.target.checked;
});
deptEditor.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove-dept]");
  if (!remove) return;
  readDepartmentEdits();
  const department = departments.find((entry) => entry.id === remove.dataset.removeDept);
  if (!window.confirm(`Remove ${department?.name || "this department"}? Its login stops working once you save.`)) return;
  departments = departments.filter((entry) => entry.id !== remove.dataset.removeDept);
  renderDepartments();
});

async function loadDepartments() {
  const data = await fetch("/api/admin/departments", { cache: "no-store" }).then((response) => response.json());
  departments = data.departments;
  cueListOptions = data.cueLists;
  typeCounts = data.typeCounts || {};
  renderDepartments();
}

function renderDepartments() {
  if (!departments.length) {
    deptEditor.innerHTML = `<p class="quiet">No departments yet. Press “Add department”.</p>`;
    return;
  }
  deptEditor.innerHTML = departments.map((department) => `
    <div class="dept-card ${department.role === "stageManager" ? "is-stage-manager" : ""}" data-dept-id="${escapeText(department.id)}">
      ${department.role === "stageManager" ? `<div class="dept-card-badge">Built in · runs the whole show${department.hasPassword ? "" : " · <strong>set a password so your stage manager can log in</strong>"}</div>` : ""}
      <div class="dept-card-row">
        <label class="grow">
          <span>Name</span>
          <input name="name" value="${escapeText(department.name)}" placeholder="e.g. Lighting" maxlength="40">
        </label>
        <label>
          <span>Colour</span>
          <select name="color">
            ${DEPT_COLORS.map((color) => `<option value="${color}" ${color === department.color ? "selected" : ""}>${color}</option>`).join("")}
          </select>
        </label>
        <label class="grow">
          <span>${department.hasPassword ? "New password (blank = keep)" : "Password"}</span>
          <input name="password" type="password" autocomplete="new-password" placeholder="${department.hasPassword ? "••••••" : "Set a password"}">
        </label>
      </div>
      <div class="dept-card-row">
        <fieldset class="chip-set">
          <legend>Powers <span class="quiet">(on top of firing its own cues)</span></legend>
          ${PERMISSIONS.map(([id, label, help]) => `
            <label class="chip-check" title="${escapeText(help)}"><input type="checkbox" name="permission" value="${id}" ${(department.permissions || []).includes(id) ? "checked" : ""}><span>${escapeText(label)}</span></label>`).join("")}
        </fieldset>
      </div>
      ${department.role === "stageManager" ? "" : `
      <label class="toggle-row follow-standby">
        <input type="checkbox" name="followStandby" ${department.followStandby ? "checked" : ""}>
        <span><strong>Follow standbys</strong> <span class="quiet">When the stage manager calls a standby for one of its cues, that cue becomes its next cue and opens on its screen, ready to play.</span></span>
      </label>
      <label class="auto-standby-row">
        <span><strong>Automatic standby</strong> <span class="quiet">Its standby light comes on by itself as its next cue gets close, then shows GO when the cue plays.</span></span>
        <select name="autoStandby">
          ${[[-1, "Off"], [0, "When its cue is the next GO"], [1, "1 cue before"], [2, "2 cues before"], [3, "3 cues before"], [5, "5 cues before"]]
            .map(([value, text]) => `<option value="${value}" ${Number(department.autoStandby ?? -1) === value ? "selected" : ""}>${text}</option>`).join("")}
        </select>
      </label>`}
      <div class="dept-card-row call-targets" ${(department.permissions || []).includes("paging") ? "" : "hidden"}>
        <fieldset class="chip-set">
          <legend>Can send calls to <span class="quiet">(tick none = anywhere)</span></legend>
          ${[...CALL_TARGETS, ...departments.filter((other) => other.id !== department.id).map((other) => [other.id, other.name || "New department"])].map(([id, label]) => `
            <label class="chip-check"><input type="checkbox" name="pageTarget" value="${escapeText(id)}" ${(department.pageTargets || []).includes(id) ? "checked" : ""}><span>${escapeText(label)}</span></label>`).join("")}
        </fieldset>
      </div>
      <div class="dept-card-row">
        <fieldset class="chip-set">
          <legend>Cue types it runs <span class="quiet">(numbers = how many are in this show)</span></legend>
          ${cueTypeOptions(department).map((type) => `
            <label class="chip-check ${typeCounts[type] ? "" : "chip-unused"}"><input type="checkbox" name="cueType" value="${escapeText(type)}" ${(department.cueTypes || []).includes(type) ? "checked" : ""}><span>${escapeText(type)}${typeCounts[type] ? ` <b>${typeCounts[type]}</b>` : ""}</span></label>`).join("")}
        </fieldset>
      </div>
      <details class="dept-more" ${department.cueListIds.length || department.cueColors.length || department.namePrefixes.length ? "open" : ""}>
      <summary>More ways to choose cues: cue lists, colours, name prefixes</summary>
      <div class="dept-card-row">
        <fieldset class="chip-set">
          <legend>Cue lists <span class="quiet">(optional: whole lists, or limit the types above to these lists)</span></legend>
          ${cueListOptions.length
            ? cueListOptions.map((list) => `
              <label class="chip-check"><input type="checkbox" name="list" value="${escapeText(list.id)}" ${department.cueListIds.includes(list.id) ? "checked" : ""}><span>${escapeText(list.name)}</span></label>`).join("")
            : `<span class="quiet">Connect to QLab to choose cue lists.</span>`}
          ${department.cueListIds.filter((id) => !cueListOptions.some((list) => list.id === id)).map((id) => `
              <label class="chip-check"><input type="checkbox" name="list" value="${escapeText(id)}" checked><span>Missing list</span></label>`).join("")}
        </fieldset>
      </div>
      <div class="dept-card-row">
        <fieldset class="chip-set">
          <legend>Cue colours (optional)</legend>
          ${CUE_COLORS.map((color) => `
            <label class="chip-check" data-color="${color}"><input type="checkbox" name="cueColor" value="${color}" ${department.cueColors.includes(color) ? "checked" : ""}><span>${color}</span></label>`).join("")}
        </fieldset>
        <label class="grow">
          <span>Name/number starts with (optional, comma separated)</span>
          <input name="prefixes" value="${escapeText(department.namePrefixes.join(", "))}" placeholder="e.g. LX, LQ">
        </label>
      </div>
      </details>
      <div class="dept-card-actions">
        ${department.isNew ? "" : `<a class="tool-button" href="/dept.html?dept=${encodeURIComponent(department.id)}" target="_blank" rel="noopener">Open as admin</a>`}
        ${department.role === "stageManager" ? "" : `<button type="button" class="danger-outline small-button" data-remove-dept="${escapeText(department.id)}">Remove</button>`}
      </div>
    </div>`).join("");
}

// Copy what's in the form back into `departments`, returning new passwords by id.
function readDepartmentEdits() {
  const passwords = {};
  for (const card of deptEditor.querySelectorAll(".dept-card")) {
    const department = departments.find((entry) => entry.id === card.dataset.deptId);
    if (!department) continue;
    department.name = card.querySelector("[name=name]").value.trim();
    department.color = card.querySelector("[name=color]").value;
    department.cueListIds = Array.from(card.querySelectorAll("[name=list]:checked")).map((input) => input.value);
    department.cueColors = Array.from(card.querySelectorAll("[name=cueColor]:checked")).map((input) => input.value);
    department.cueTypes = Array.from(card.querySelectorAll("[name=cueType]:checked")).map((input) => input.value);
    department.permissions = Array.from(card.querySelectorAll("[name=permission]:checked")).map((input) => input.value);
    department.pageTargets = department.permissions.includes("paging")
      ? Array.from(card.querySelectorAll("[name=pageTarget]:checked")).map((input) => input.value)
      : [];
    department.followStandby = Boolean(card.querySelector("[name=followStandby]")?.checked);
    department.autoStandby = Number(card.querySelector("[name=autoStandby]")?.value ?? -1);
    department.namePrefixes = card.querySelector("[name=prefixes]").value.split(",").map((value) => value.trim()).filter(Boolean);
    const password = card.querySelector("[name=password]").value;
    if (password) passwords[department.id] = password;
  }
  return passwords;
}

async function saveDepartments() {
  const passwords = readDepartmentEdits();
  deptMessage.textContent = "";
  const missing = departments.find((department) => !department.name);
  if (missing) {
    deptMessage.textContent = "Every department needs a name.";
    return;
  }
  const noPassword = departments.find((department) => department.role !== "stageManager" && !department.hasPassword && !passwords[department.id]);
  if (noPassword) {
    deptMessage.textContent = `Set a password for ${noPassword.name}.`;
    return;
  }
  try {
    const response = await fetch("/api/admin/departments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ departments, passwords })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save departments.");
    departments = data.departments;
    renderDepartments();
    deptMessage.textContent = "Departments saved.";
  } catch (error) {
    deptMessage.textContent = error.message;
  }
}


// --- What QLab is sending: open workspaces and cue counts ---

const qlabInfo = document.querySelector("#qlabInfo");

function setWorkspaceOptions(workspaces) {
  const current = workspaceInput.value || savedWorkspace;
  const options = [["", "First open workspace"], ...workspaces.map((workspace) => [workspace.id, workspace.name])];
  if (current && !options.some(([id, name]) => id === current || name === current)) options.push([current, `${current} (not open)`]);
  const html = options.map(([id, name]) => `<option value="${escapeText(id)}">${escapeText(name)}</option>`).join("");
  if (workspaceInput.dataset.rendered === html) return;
  workspaceInput.innerHTML = html;
  workspaceInput.dataset.rendered = html;
  const match = options.find(([id, name]) => id === current || name === current);
  workspaceInput.value = match ? match[0] : "";
}

async function loadQlabInfo() {
  let info;
  try {
    info = await fetch("/api/admin/qlab-info", { cache: "no-store" }).then((response) => response.json());
  } catch {
    return;
  }
  if (document.activeElement !== workspaceInput) setWorkspaceOptions(info.openWorkspaces || []);

  if (!info.connected) {
    qlabInfo.innerHTML = `<p class="quiet">Not connected to QLab.</p>`;
    return;
  }
  const others = (info.openWorkspaces || []).filter((workspace) => workspace.id !== info.workspaceId);
  const lists = info.lists.map((list) => {
    const types = Object.entries(list.types).sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `<span class="type-chip">${escapeText(type)} ${count}</span>`).join("");
    return `<div class="qlab-list"><strong>${escapeText(list.name)}</strong><span class="quiet">${list.count} cue${list.count === 1 ? "" : "s"}${list.type === "Cue Cart" ? " · cart" : ""}</span><div class="type-chips">${types || '<span class="quiet">empty</span>'}</div></div>`;
  }).join("");
  qlabInfo.innerHTML = `
    <p><strong>Connected to “${escapeText(info.workspaceName)}”.</strong> This is everything the app receives from it:</p>
    <div class="qlab-lists">${lists || '<p class="quiet">No cue lists.</p>'}</div>
    ${others.length ? `<p class="notice">Other workspaces are open in QLab too: ${others.map((workspace) => `<strong>${escapeText(workspace.name)}</strong>`).join(", ")}.
      The app only shows one workspace. If cues are missing, pick the right one in <em>Workspace</em> above and press <em>Connect Saved</em>.</p>` : ""}`;
}

// --- Tabs (the URL hash picks the tab, e.g. /admin.html#departments) ---

const adminTabs = Array.from(document.querySelectorAll("[data-tab]"));
function showAdminTab(name) {
  const target = adminTabs.some((tab) => tab.dataset.tab === name) ? name : "qlab";
  for (const tab of adminTabs) {
    const selected = tab.dataset.tab === target;
    tab.setAttribute("aria-selected", String(selected));
    document.querySelector(`#tab-${tab.dataset.tab}`).hidden = !selected;
  }
}
for (const tab of adminTabs) {
  tab.addEventListener("click", () => {
    history.replaceState(null, "", `#${tab.dataset.tab}`);
    showAdminTab(tab.dataset.tab);
  });
}
window.addEventListener("hashchange", () => showAdminTab(location.hash.slice(1)));
showAdminTab(location.hash.slice(1));

// --- Backup and restore ---

const restoreFile = document.querySelector("#restoreFile");
const restoreButton = document.querySelector("#restoreButton");
const restorePreview = document.querySelector("#restorePreview");
const backupMessage = document.querySelector("#backupMessage");
let pendingRestore = null;

document.querySelector("#backupDownload").addEventListener("click", () => {
  const secrets = document.querySelector("#backupSecrets").checked ? "1" : "0";
  try {
    localStorage.setItem("qlab-last-backup", new Date().toISOString());
  } catch {
    // Only used for the Start page checklist.
  }
  window.location.href = `/api/admin/backup?secrets=${secrets}`;
});

restoreFile.addEventListener("change", async () => {
  pendingRestore = null;
  restoreButton.disabled = true;
  restorePreview.hidden = true;
  backupMessage.textContent = "";
  const file = restoreFile.files[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.format !== "qlab-connect-setup") throw new Error("This isn't a QLab Connect setup file.");
    pendingRestore = backup;
    const setup = backup.setup || {};
    const departmentsInFile = setup.departments || [];
    restorePreview.innerHTML = `
      <strong>${escapeText(file.name)}</strong>
      <span>Saved ${escapeText(new Date(backup.exportedAt).toLocaleString())}${backup.includesSecrets ? " · includes passwords" : " · no passwords (current ones are kept)"}</span>
      <span>QLab: ${escapeText(setup.qlab?.host || "not set")}${setup.qlab?.workspaceName ? ` · ${escapeText(setup.qlab.workspaceName)}` : ""}</span>
      <span>${departmentsInFile.length} department${departmentsInFile.length === 1 ? "" : "s"}${departmentsInFile.length ? `: ${departmentsInFile.map((department) => escapeText(department.name)).join(", ")}` : ""}</span>
      <span>Control ${setup.control?.enabled ? "on" : "off"} · ${(setup.control?.midiMappings || []).length} MIDI mappings</span>`;
    restorePreview.hidden = false;
    restoreButton.disabled = false;
  } catch (error) {
    backupMessage.textContent = error instanceof SyntaxError ? "That file couldn't be read." : error.message;
  }
});

restoreButton.addEventListener("click", async () => {
  if (!pendingRestore) return;
  if (!window.confirm("Replace the current setup with the one in this file?")) return;
  restoreButton.disabled = true;
  try {
    const response = await fetch("/api/admin/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pendingRestore)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the setup.");
    backupMessage.textContent = data.restartRequired
      ? "Setup loaded. Restart the app to apply the changed ports or admin login."
      : "Setup loaded.";
    loadSettings();
    loadControl();
    loadDepartments();
  } catch (error) {
    backupMessage.textContent = error.message;
    restoreButton.disabled = false;
  }
});

function cueTypeOptions(department) {
  const inShow = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a]);
  const all = [...inShow, ...QLAB_CUE_TYPES.filter((type) => !inShow.includes(type))];
  // Keep any saved type that isn't in either list (e.g. from a newer QLab).
  for (const type of department.cueTypes || []) if (!all.includes(type)) all.push(type);
  return all;
}


// --- Server: admin login and running as a service ---

const adminLoginForm = document.querySelector("#adminLoginForm");
const adminLoginMessage = document.querySelector("#adminLoginMessage");
const testingToggle = document.querySelector("#testingMode");

testingToggle.addEventListener("change", async () => {
  const message = document.querySelector("#testingMessage");
  const response = await fetch("/api/admin/testing-mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: testingToggle.checked })
  }).catch(() => null);
  if (!response?.ok) {
    testingToggle.checked = !testingToggle.checked;
    message.textContent = "Could not change testing mode.";
    return;
  }
  message.textContent = testingToggle.checked
    ? "On. Log in again in each tab: every tab now has its own department login."
    : "Off. Department logins are shared by the whole browser again; log in again on each device.";
});

loadServerInfo();

async function loadServerInfo() {
  const info = await fetch("/api/admin/server", { cache: "no-store" }).then((response) => response.json()).catch(() => null);
  if (!info) return;
  document.querySelector("#defaultPasswordNotice").hidden = !info.defaultPassword;
  adminLoginForm.elements.user.value = info.adminUser;
  if (info.fromEnvironment) {
    for (const element of adminLoginForm.elements) element.disabled = true;
    adminLoginMessage.textContent = "The admin login is set by ADMIN_USER / ADMIN_PASSWORD when the app starts, so it can't be changed here.";
  }
  testingToggle.checked = Boolean(info.testingMode);
  document.querySelector("#serviceStatus").textContent = info.runningAsService
    ? "✓ Running as a background service. It will start by itself after a restart."
    : info.platform === "darwin"
      ? "Not running as a service yet: it stops when its Terminal window closes."
      : "The service commands below are for macOS. On Ubuntu use scripts/install-ubuntu.sh.";
}

adminLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminLoginMessage.textContent = "";
  const response = await fetch("/api/admin/admin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: adminLoginForm.elements.user.value, password: adminLoginForm.elements.password.value })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    adminLoginMessage.textContent = data.error || "Could not change the admin login.";
    return;
  }
  adminLoginForm.elements.password.value = "";
  adminLoginMessage.textContent = "Saved. Your browser will ask you to log in again with the new details.";
  document.querySelector("#defaultPasswordNotice").hidden = true;
});


// --- Check QLab ---

const checkCue = document.querySelector("#checkCue");
const checkButton = document.querySelector("#checkButton");
const checkResults = document.querySelector("#checkResults");

async function loadCheckCues() {
  const data = await fetch("/api/state", { cache: "no-store" }).then((response) => response.json()).catch(() => ({}));
  const playable = (data.cues || []).filter((cue) => ["Audio", "Video", "Mic"].includes(cue.type));
  const current = checkCue.value;
  checkCue.innerHTML = `<option value="">Don't play anything</option>` + playable
    .map((cue) => `<option value="${escapeText(cue.uniqueID)}">${escapeText(`${cue.number ? `${cue.number} · ` : ""}${cue.name || cue.type} (${cue.type})`)}</option>`)
    .join("");
  checkCue.value = current;
}
checkCue.addEventListener("focus", loadCheckCues);
loadCheckCues();

checkButton.addEventListener("click", async () => {
  if (checkCue.value && !window.confirm("The chosen cue will play for a few seconds (through your speakers or screens). Continue?")) return;
  checkButton.disabled = true;
  checkButton.textContent = "Checking…";
  checkResults.innerHTML = "";
  try {
    const response = await fetch("/api/admin/qlab-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testCueId: checkCue.value })
    });
    const data = await response.json();
    const icons = { ok: "✓", warn: "!", fail: "✕", skipped: "–" };
    checkResults.innerHTML = (data.results || []).map((result) => `
      <li class="check-item" data-status="${escapeText(result.status)}">
        <span class="check-icon" aria-hidden="true">${icons[result.status] || "?"}</span>
        <span><strong>${escapeText(result.label)}</strong>${result.detail ? `<em>${escapeText(result.detail)}</em>` : ""}</span>
      </li>`).join("");
  } catch (error) {
    checkResults.innerHTML = `<li class="check-item" data-status="fail"><span class="check-icon">✕</span><span>${escapeText(error.message)}</span></li>`;
  } finally {
    checkButton.disabled = false;
    checkButton.textContent = "Check QLab";
  }
});


// --- Lighting desk (QLab cues tagged "LX 5" send the desk an OSC GO) ---

const deskForm = document.querySelector("#deskForm");
const deskMessage = document.querySelector("#deskMessage");

loadDesk();

async function loadDesk() {
  const desk = await fetch("/api/admin/lighting-desk", { cache: "no-store" }).then((response) => response.json()).catch(() => null);
  if (!desk) return;
  deskForm.elements.enabled.checked = desk.enabled;
  deskForm.elements.host.value = desk.host;
  deskForm.elements.port.value = desk.port;
  deskForm.elements.prefix.value = desk.prefix;
  deskForm.elements.command.value = desk.command;
  deskForm.elements.transport.value = desk.transport;
  renderDesk(desk);
}

// Keep the connection light live while the Lighting desk tab is open.
setInterval(async () => {
  if (document.querySelector("#tab-desk").hidden || document.hidden) return;
  const desk = await fetch("/api/admin/lighting-desk", { cache: "no-store" }).then((response) => response.json()).catch(() => null);
  if (desk) renderDesk(desk);
}, 2000);

function renderDesk(desk) {
  const on = desk.enabled && desk.host;
  document.querySelector("#deskState").textContent = on ? `On · ${desk.host}:${desk.port} ${desk.transport.toUpperCase()}` : "Off";
  document.querySelector("#deskLink").dataset.online = String(Boolean(on && desk.link?.online));
  document.querySelector("#deskLinkText").textContent = on ? desk.link?.detail || "Checking…" : "Off: tick “Send GOs to the lighting desk” and enter its IP address.";
  renderDeskTagged(desk);
  const recent = desk.recent || [];
  const element = document.querySelector("#deskRecent");
  element.innerHTML = recent.length
    ? recent.map((entry) => `
      <div class="desk-entry ${entry.ok ? "" : "failed"}">
        <strong>${entry.ok ? (entry.delivered ? "✓ Delivered" : "Sent") : "✕ Failed"} · cue ${escapeText(entry.cue)}</strong>
        <code>${escapeText(entry.address)}</code>
        <span class="quiet">${escapeText(entry.source)} · ${new Date(entry.at).toLocaleTimeString()}</span>
      </div>`).join("")
    : "Nothing sent yet.";
}

function renderDeskTagged(desk) {
  const tagged = desk.tagged || [];
  const element = document.querySelector("#deskTagged");
  const html = tagged.length
    ? tagged.map((cue) => `
      <div class="desk-entry ${cue.instant ? "warn" : ""}">
        <strong>Desk cue ${escapeText(cue.deskCue)}</strong>
        <span>QLab ${escapeText(cue.number)} ${escapeText(cue.name)} <span class="quiet">(${escapeText(cue.type)})</span></span>
        ${cue.instant ? `<span class="desk-warning">A ${escapeText(cue.type)} cue ends instantly: it fires the desk when GO'd from QLab Connect, but not when GO'd in QLab itself. Use a Wait cue of 0.5 s, or tag the sound cue.</span>` : ""}
      </div>`).join("")
    : `No cues in this workspace are tagged. Name a cue <strong>${escapeText(desk.prefix)} 5</strong> or add <strong>[${escapeText(desk.prefix)} 5]</strong> to its name.`;
  if (element.dataset.html !== html) {
    element.dataset.html = html;
    element.innerHTML = html;
  }
}

deskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/admin/lighting-desk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: deskForm.elements.enabled.checked,
      host: deskForm.elements.host.value,
      port: Number(deskForm.elements.port.value),
      prefix: deskForm.elements.prefix.value,
      command: deskForm.elements.command.value,
      transport: deskForm.elements.transport.value
    })
  });
  const data = await response.json().catch(() => ({}));
  deskMessage.textContent = response.ok ? "Saved. Checking the connection…" : data.error || "Could not save.";
  if (response.ok) {
    setTimeout(loadDesk, 1500);
    deskForm.elements.command.value = data.command;
    deskForm.elements.prefix.value = data.prefix;
    deskForm.elements.port.value = data.port;
    renderDesk(data);
  }
});

document.querySelector("#deskTestButton").addEventListener("click", async () => {
  const response = await fetch("/api/admin/lighting-desk/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cue: document.querySelector("#deskTestCue").value })
  });
  const data = await response.json().catch(() => ({}));
  deskMessage.textContent = response.ok
    ? (data.entry.delivered
      ? `Delivered ${data.entry.address} to the desk. Check it ran that cue.`
      : `Sent ${data.entry.address} over UDP (can't be confirmed). Check the desk ran that cue.`)
    : data.error || "Could not send.";
  loadDesk();
});
