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
let departments = [];
let cueListOptions = [];

loadDepartments();
document.querySelector("#addDeptButton").addEventListener("click", () => {
  readDepartmentEdits();
  departments.push({ id: `dept${Date.now().toString(36)}`, name: "", color: DEPT_COLORS[departments.length % DEPT_COLORS.length], cueListIds: [], cueTypes: [], cueColors: [], namePrefixes: [], hasPassword: false, isNew: true });
  renderDepartments();
  deptEditor.querySelector(".dept-card:last-child input[name=name]")?.focus();
});
document.querySelector("#saveDeptButton").addEventListener("click", saveDepartments);
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
    <div class="dept-card" data-dept-id="${escapeText(department.id)}">
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
          <legend>Cue types <span class="quiet">(numbers = how many are in this show)</span></legend>
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
        <button type="button" class="danger-outline small-button" data-remove-dept="${escapeText(department.id)}">Remove</button>
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
  const noPassword = departments.find((department) => !department.hasPassword && !passwords[department.id]);
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
