import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SETTINGS_DIR, SETTINGS_PATH } from "./config.js";

// Declared before loadSettings() runs below, which uses them.
export const DEPARTMENT_PERMISSIONS = ["showGo", "transport", "anyCue", "paging", "showClock", "scrub"];
const DEPARTMENT_COLORS = new Set(["red", "orange", "yellow", "green", "blue", "purple", "magenta", "gray", "none"]);

let settings = await loadSettings();

export function getSettings() {
  return settings;
}

export async function updateSettings(nextSettings) {
  settings = normalizeSettings(nextSettings);
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

export function publicSettings() {
  return {
    host: settings.host,
    workspaceId: settings.workspaceId,
    autoConnect: settings.autoConnect,
    hasPasscode: Boolean(settings.passcode)
  };
}

export function controlSettings() {
  return settings.control;
}

export function publicControlSettings() {
  return {
    enabled: settings.control.enabled,
    token: settings.control.token,
    midiMappings: settings.control.midiMappings
  };
}

export async function updateControlSettings(nextControlSettings) {
  return updateSettings({
    ...settings,
    control: {
      ...settings.control,
      ...nextControlSettings
    }
  });
}

export function createControlToken() {
  return randomBytes(18).toString("base64url");
}

export function getDepartments() {
  return settings.departments;
}

export async function saveDepartments(departments) {
  return updateSettings({ ...settings, departments });
}

export function sessionSecret() {
  return settings.sessionSecret;
}

// The admin login. ADMIN_USER / ADMIN_PASSWORD environment variables win; otherwise it's the one
// saved in settings (changeable in Admin, takes effect straight away).
export function adminCredentials() {
  return {
    user: process.env.ADMIN_USER || settings.server.adminUser || "admin",
    password: process.env.ADMIN_PASSWORD || settings.server.adminPassword || "thomas",
    fromEnvironment: Boolean(process.env.ADMIN_USER || process.env.ADMIN_PASSWORD)
  };
}

export function usingDefaultAdminPassword() {
  return adminCredentials().password === "thomas";
}

export function serverSettings() {
  return settings.server;
}

export function publicServerSettings() {
  return {
    httpPort: settings.server.httpPort,
    qlabTcpPort: settings.server.qlabTcpPort,
    adminUser: settings.server.adminUser,
    hasAdminPassword: Boolean(settings.server.adminPassword)
  };
}

export async function updateServerSettings(nextServerSettings) {
  return updateSettings({
    ...settings,
    server: {
      ...settings.server,
      ...nextServerSettings
    }
  });
}

async function loadSettings() {
  try {
    const content = await readFile(SETTINGS_PATH, "utf8");
    const saved = JSON.parse(content);
    return normalizeSettings(saved);
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Could not read ${SETTINGS_PATH}: ${error.message}. Using defaults.`);
    return normalizeSettings({});
  }
}

function normalizeSettings(saved) {
  const server = saved.server && typeof saved.server === "object" ? saved.server : {};
  return {
    host: String(saved.host || ""),
    passcode: String(saved.passcode || ""),
    workspaceId: String(saved.workspaceId || ""),
    autoConnect: Boolean(saved.autoConnect),
    control: normalizeControl(saved.control),
    // What the last QLab check found this QLab version can do (see src/qlab-check.js).
    qlabCaps: {
      seek: saved.qlabCaps?.seek === "restart" ? "restart" : "direct",
      checkedAt: String(saved.qlabCaps?.checkedAt || "")
    },
    // Testing mode: each browser tab logs in to a department separately (for trying several
    // departments on one computer). Normally a login is shared by the whole browser.
    testingMode: Boolean(saved.testingMode),
    lightingDesk: normalizeLightingDesk(saved.lightingDesk),
    departments: Array.isArray(saved.departments) ? saved.departments.map(normalizeDepartment).filter(Boolean).slice(0, 24) : [],
    // Signs department login cookies; kept so a server restart doesn't log everyone out.
    sessionSecret: String(saved.sessionSecret || "") || randomBytes(32).toString("hex"),
    server: {
      httpPort: readPositiveNumber(server.httpPort, 3030),
      qlabTcpPort: readPositiveNumber(server.qlabTcpPort, 53000),
      adminUser: String(server.adminUser || "admin"),
      adminPassword: String(server.adminPassword || "thomas")
    }
  };
}

function normalizeDepartment(saved) {
  if (!saved || typeof saved !== "object") return null;
  const name = String(saved.name || "").trim().slice(0, 40);
  if (!name) return null;
  const list = (value) => (Array.isArray(value) ? value : []).map((entry) => String(entry).trim()).filter(Boolean);
  return {
    id: String(saved.id || randomBytes(5).toString("hex")).replace(/[^\w-]/g, "").slice(0, 32) || randomBytes(5).toString("hex"),
    name,
    color: DEPARTMENT_COLORS.has(saved.color) ? saved.color : "blue",
    // Which cues belong to this department: cue lists (by unique ID), and/or cue colours and name prefixes.
    cueListIds: list(saved.cueListIds).slice(0, 20),
    cueColors: list(saved.cueColors).filter((color) => DEPARTMENT_COLORS.has(color)),
    cueTypes: list(saved.cueTypes).slice(0, 40).map((type) => type.slice(0, 30)),
    namePrefixes: list(saved.namePrefixes).slice(0, 10).map((prefix) => prefix.slice(0, 20)),
    // "stageManager" marks the built-in Stage Manager department (always exists, can't be removed).
    role: saved.role === "stageManager" ? "stageManager" : "",
    // When the stage manager sends this department a standby for one of its cues, move its next
    // cue there and open that cue ready to play.
    followStandby: Boolean(saved.followStandby),
    // Automatic standby: -1 off, 0 when its next cue is the show's next GO, N when it's N cues away.
    autoStandby: Number.isInteger(Number(saved.autoStandby)) && Number(saved.autoStandby) >= 0 && Number(saved.autoStandby) <= 20
      ? Number(saved.autoStandby) : -1,
    // Extra powers beyond firing its own cues (see DEPARTMENT_PERMISSIONS).
    permissions: list(saved.permissions).filter((permission) => DEPARTMENT_PERMISSIONS.includes(permission)),
    // Who this department may send backstage calls to ("all", "dashboard", "monitor" or department
    // ids). Empty means anyone.
    pageTargets: list(saved.pageTargets).slice(0, 40).map((target) => target.slice(0, 40)),
    passwordHash: String(saved.passwordHash || ""),
    passwordSalt: String(saved.passwordSalt || "")
  };
}

// Lighting desk link (src/lighting-desk.js): QLab cues tagged "LX 5" send the desk an OSC GO.
function normalizeLightingDesk(saved) {
  const desk = saved && typeof saved === "object" ? saved : {};
  const port = Number(desk.port);
  const command = String(desk.command || "").trim();
  return {
    enabled: Boolean(desk.enabled),
    host: String(desk.host || "").trim().slice(0, 100),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8830,
    prefix: String(desk.prefix ?? "LX").trim().slice(0, 12) || "LX",
    // "tcp" keeps a connection open, so we know the desk is listening and got each GO.
    transport: desk.transport === "udp" ? "udp" : "tcp",
    // Listen to the desk's Art-Net / sACN output to see whether the lights changed after a GO.
    watchOutput: Boolean(desk.watchOutput),
    watchUniverses: (Array.isArray(desk.watchUniverses) ? desk.watchUniverses : String(desk.watchUniverses ?? "1").split(/[\s,]+/))
      .map(Number).filter((universe) => Number.isInteger(universe) && universe >= 0 && universe <= 63999).slice(0, 8),
    // Zero 88 ZerOS: GO a cue on the master playback. {cue} is the desk cue number.
    command: command.startsWith("/") && command.includes("{cue}") ? command.slice(0, 120) : "/zeros/cue/go/{cue}"
  };
}

function normalizeControl(saved) {
  const control = saved && typeof saved === "object" ? saved : {};
  return {
    // Control is off until an admin turns it on: the app stays read-only by default.
    enabled: Boolean(control.enabled),
    token: String(control.token || "") || createControlToken(),
    // "virtual" = a virtual MIDI port QLab can listen to; otherwise the name of a MIDI output.
    midiOutput: String(control.midiOutput || "virtual"),
    // Network MIDI sessions (e.g. an iPhone running midimittr) to connect to automatically.
    networkMidiAuto: Array.isArray(control.networkMidiAuto) ? control.networkMidiAuto.map(String).slice(0, 20) : [],
    midiMappings: Array.isArray(control.midiMappings) ? control.midiMappings.map(normalizeMidiMapping).filter(Boolean) : []
  };
}

export function normalizeMidiMapping(mapping) {
  if (!mapping || typeof mapping !== "object") return null;
  const type = ["note", "cc", "program"].includes(mapping.type) ? mapping.type : null;
  const channel = Number(mapping.channel);
  const number = Number(mapping.number);
  if (!type || !Number.isInteger(channel) || channel < 0 || channel > 16) return null;
  if (!Number.isInteger(number) || number < 0 || number > 127) return null;
  return {
    id: String(mapping.id || randomBytes(6).toString("hex")),
    type,
    // 0 means "any channel".
    channel,
    number,
    action: String(mapping.action || ""),
    arg: String(mapping.arg ?? "").slice(0, 200),
    label: String(mapping.label || "").slice(0, 80)
  };
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
