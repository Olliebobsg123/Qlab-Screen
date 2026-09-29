import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
export const PUBLIC_DIR = join(ROOT_DIR, "public");
export const SETTINGS_PATH = process.env.QLAB_SETTINGS_PATH || join(ROOT_DIR, "settings.json");
export const SETTINGS_DIR = dirname(SETTINGS_PATH);
export const APP_VERSION = readAppVersion();
const SAVED_SERVER_CONFIG = readSavedServerConfig();

export const HTTP_PORT = readNumber(process.env.PORT, SAVED_SERVER_CONFIG.httpPort, 3030);
// HTTPS is needed for Web MIDI and audio input on devices other than the server. Set to 0 to disable.
export const HTTPS_PORT = readOptionalPort(process.env.HTTPS_PORT, SAVED_SERVER_CONFIG.httpsPort, 3443);
// Network MIDI (RTP-MIDI / AppleMIDI) session for iPhones and other devices. Uses this port and the next. 0 disables.
export const RTP_MIDI_PORT = readOptionalPort(process.env.RTP_MIDI_PORT, SAVED_SERVER_CONFIG.rtpMidiPort, 5004);
export const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
export const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
export const QLAB_TCP_PORT = readNumber(process.env.QLAB_TCP_PORT, SAVED_SERVER_CONFIG.qlabTcpPort, 53000);
export const ADMIN_USER = process.env.ADMIN_USER || SAVED_SERVER_CONFIG.adminUser || "admin";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || SAVED_SERVER_CONFIG.adminPassword || "thomas";
export const MAC_OWNER_TOKEN = process.env.MAC_OWNER_TOKEN || "";

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function readAppVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
    return String(packageJson.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function readSavedServerConfig() {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return settings.server && typeof settings.server === "object" ? settings.server : {};
  } catch {
    return {};
  }
}

function readNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function readOptionalPort(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isInteger(number) && number >= 0) return number;
  }
  return 0;
}
