import { app, BrowserWindow, ipcMain, Menu, session, shell, systemPreferences } from "electron";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// QLab Connect desktop app (Mac and Windows). Two jobs:
//   server: this computer runs the show (QLab's computer). Starts the web server, as before.
//   client: this computer joins a show running elsewhere, as a department screen with fast comms
//           (voices sent directly between apps over the local network; see public/fast-audio.js).
// First launch shows a launcher to pick one; "Change what this computer does…" in the menu goes back.

const here = dirname(fileURLToPath(import.meta.url));
let server;
let mainWindow;
let ownerToken;
let httpPort;
let ownerUrl;
let isQuitting = false;

app.setName("QLab Connect");

const configPath = () => join(app.getPath("userData"), "app-config.json");
function readConfig() {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(config) {
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

const config = readConfig();

// Department pages are opened on the show computer's secure (https) address, so the microphone
// works. It uses a self-signed certificate: trust it, but only for that computer.
const secureUrl = config.mode === "client" && config.serverUrl
  ? `https://${new URL(config.serverUrl).hostname}:${Number(config.httpsPort) || 3443}`
  : "";
app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
  if (secureUrl && new URL(url).origin === secureUrl) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

ipcMain.handle("launcher:choose", (_event, choice) => {
  const next = choice?.mode === "client"
    ? { mode: "client", serverUrl: String(choice.serverUrl || ""), httpsPort: Number(choice.httpsPort) || 3443 }
    : { mode: "server" };
  writeConfig(next);
  // Restart so the secure-address setting above applies.
  app.relaunch();
  app.exit(0);
});
ipcMain.handle("launcher:current", () => ({ ...readConfig(), lastError: launcherMessage }));

let launcherMessage = "";

app.whenReady().then(async () => {
  trustShowComputer();
  allowMicrophone();
  buildMenu();
  if (config.mode === "server") await startServerMode();
  else if (config.mode === "client" && config.serverUrl) await startClientMode();
  else showLauncher();
});

// Trust the show computer's self-signed certificate for every connection to it (pages and the
// comms socket); everything else is checked normally.
function trustShowComputer() {
  if (!secureUrl) return;
  const host = new URL(secureUrl).hostname;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === host ? 0 : -3);
  });
}

function allowMicrophone() {
  const trusted = (url) => {
    try {
      const origin = new URL(url).origin;
      return origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost") ||
        origin.startsWith("https://127.0.0.1") || origin.startsWith("https://localhost") ||
        (secureUrl && origin === secureUrl);
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(["media", "audioCapture", "wakeLock", "notifications"].includes(permission) && trusted(details.requestingUrl || webContents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, origin) => ["media", "audioCapture"].includes(permission) && trusted(origin));
  if (process.platform === "darwin" && config.mode) systemPreferences.askForMediaAccess("microphone").catch(() => {});
}

function windowOptions(extra = {}) {
  return {
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: "QLab Connect",
    backgroundColor: "#0a0a0b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // The preload needs Node's UDP sockets for fast comms.
      sandbox: false,
      preload: join(here, "preload.cjs"),
      backgroundThrottling: false
    },
    ...extra
  };
}

function showLauncher(message = "") {
  launcherMessage = message;
  const launcher = new BrowserWindow({
    width: 780,
    height: 560,
    title: "QLab Connect",
    backgroundColor: "#0a0a0b",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: join(here, "launcher-preload.cjs") }
  });
  launcher.loadFile(join(here, "launcher.html"));
  mainWindow = launcher;
}

async function startClientMode() {
  mainWindow = new BrowserWindow(windowOptions());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    const failed = mainWindow;
    mainWindow = null;
    showLauncher(`Couldn't reach ${config.serverUrl} (${description}). Is QLab Connect running on the show computer?`);
    failed.destroy();
  });
  await mainWindow.loadURL(`${secureUrl}/login.html`).catch(() => {});
}

async function startServerMode() {
  const userData = app.getPath("userData");
  ownerToken = ownerToken || randomBytes(32).toString("hex");

  process.env.QLAB_ELECTRON = "1";
  process.env.QLAB_SETTINGS_PATH = join(userData, "settings.json");
  process.env.MAC_OWNER_TOKEN = ownerToken;

  if (!server) {
    const { HTTP_PORT } = await import("../src/config.js");
    const { startServer } = await import("../server.js");
    httpPort = HTTP_PORT;
    server = startServer();
    if (!server.listening) await once(server, "listening");
  }

  ownerUrl = `http://127.0.0.1:${httpPort}/mac-settings.html?token=${ownerToken}`;
  mainWindow = new BrowserWindow(windowOptions({ minWidth: 900, minHeight: 620 }));

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    injectMacNavigation();
  });

  await mainWindow.loadURL(ownerUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function changeMode() {
  writeConfig({});
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  const serverItems = config.mode === "server"
    ? [
      { label: "Owner Console", click: showOwnerConsole },
      { label: "Monitor", click: () => showPage(`http://127.0.0.1:${httpPort}/`) },
      { label: "TV Dashboard", click: () => showPage(`http://127.0.0.1:${httpPort}/dashboard.html`) },
      { label: "Departments", click: () => showPage(`http://127.0.0.1:${httpPort}/login.html`) },
      { type: "separator" }
    ]
    : config.mode === "client"
      ? [
        { label: "Departments", click: () => mainWindow?.loadURL(`${secureUrl}/login.html`) },
        { label: "Monitor", click: () => mainWindow?.loadURL(`${secureUrl}/`) },
        { type: "separator" }
      ]
      : [];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "QLab Connect",
      submenu: [
        { role: "about" },
        { type: "separator" },
        ...serverItems,
        { label: "Change what this computer does…", click: changeMode },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    }
  ]));
}

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else if (config.mode === "server") {
    startServerMode();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  server?.close();
});

app.on("window-all-closed", () => {
  if (config.mode !== "server") app.quit();
});

function showOwnerConsole() {
  showPage(ownerUrl);
}

function showPage(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.loadURL(url);
}

function injectMacNavigation() {
  const urls = {
    owner: ownerUrl,
    monitor: `http://127.0.0.1:${httpPort}/`,
    dashboard: `http://127.0.0.1:${httpPort}/dashboard.html`
  };
  const script = `
    (() => {
      const existing = document.querySelector("#qlabMacNav");
      if (existing) existing.remove();

      const nav = document.createElement("nav");
      nav.id = "qlabMacNav";
      nav.setAttribute("aria-label", "Mac app navigation");
      nav.style.cssText = [
        "position:fixed",
        "right:14px",
        "bottom:14px",
        "z-index:2147483647",
        "display:flex",
        "gap:8px",
        "padding:8px",
        "border:1px solid rgba(255,255,255,0.22)",
        "border-radius:8px",
        "background:rgba(5,5,5,0.88)",
        "box-shadow:0 10px 28px rgba(0,0,0,0.35)",
        "backdrop-filter:blur(12px)"
      ].join(";");

      const links = [
        ["Owner", ${JSON.stringify(urls.owner)}],
        ["Monitor", ${JSON.stringify(urls.monitor)}],
        ["Dashboard", ${JSON.stringify(urls.dashboard)}]
      ];

      for (const [label, href] of links) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.style.cssText = [
          "height:32px",
          "padding:0 10px",
          "border:1px solid rgba(255,255,255,0.24)",
          "border-radius:6px",
          "background:#fff",
          "color:#050505",
          "font:700 12px system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
          "cursor:pointer"
        ].join(";");
        button.addEventListener("click", () => {
          window.location.href = href;
        });
        nav.append(button);
      }

      document.body.append(nav);
    })();
  `;
  mainWindow.webContents.executeJavaScript(script).catch(() => {});
}
