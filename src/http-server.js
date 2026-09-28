import http from "node:http";
import https from "node:https";
import { hasAdminAuth, isAdminPath, requestAdminAuth } from "./auth.js";
import { exportSetup, importSetup } from "./backup.js";
import { ADMIN_PASSWORD, ADMIN_USER, HTTP_PORT, HTTPS_PORT, QLAB_TCP_PORT, ROOT_DIR, SETTINGS_PATH } from "./config.js";
import { hasControlAuth, listControlActions, runControlAction } from "./control.js";
import { broadcastHeartbeat, broadcastMeters, broadcastPatch, handleEvents } from "./events.js";
import { sendJson, readBody, serveStatic } from "./http-utils.js";
import { denyMacOwnerAccess, hasMacOwnerAccess, isMacOwnerPath } from "./mac-owner.js";
import {
  adminDepartmentList,
  stageManagerId,
  departmentCueInfo,
  departmentCueMap,
  departmentView,
  login,
  loginDepartments,
  logout,
  requestDepartment,
  runDepartmentAction,
  updateDepartments
} from "./departments.js";
import { midiOutputStatus, selectMidiOutput, sendMidiBytes } from "./midi-out.js";
import { networkUrls, qrSvg } from "./network.js";
import { runQlabCheck } from "./qlab-check.js";
import { connectNetworkMidi, disconnectNetworkMidi, rtpMidiStatus } from "./rtp-midi.js";
import { connectToQlab, disconnectQlab, keepConnected, qlabDiagnostics } from "./qlab.js";
import {
  adminCredentials,
  createControlToken,
  getSettings,
  normalizeMidiMapping,
  publicControlSettings,
  publicServerSettings,
  publicSettings,
  updateControlSettings,
  updateServerSettings,
  updateSettings,
  usingDefaultAdminPassword
} from "./settings.js";
import { getShowReport, showReportCsv } from "./show.js";
import { publicStatePatch, publicStateSnapshot, state } from "./state.js";
import { listViewers, updateViewerPresence } from "./viewers.js";

export function createHttpServer() {
  return http.createServer(handleRequest);
}

export function createHttpsServer(credentials) {
  return https.createServer({ cert: credentials.cert, key: credentials.key }, handleRequest);
}

async function handleRequest(request, response) {
  try {
    // Awaited so errors from async route handlers are caught here instead of crashing the process.
    await routeRequest(request, response);
  } catch (error) {
    if (!error.status) console.error(error);
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(response, { error: error.message }, error.status || 500);
  }
}

async function routeRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (isMacOwnerPath(url.pathname) && !hasMacOwnerAccess(request, url)) {
    return denyMacOwnerAccess(response);
  }

  if (isAdminPath(url.pathname) && !hasAdminAuth(request)) {
    return requestAdminAuth(response);
  }

  // Connecting and disconnecting change what every screen (and control surface) talks to.
  if ((url.pathname === "/api/connect" || url.pathname === "/api/disconnect") &&
    !hasAdminAuth(request) && !hasMacOwnerAccess(request, url)) {
    return requestAdminAuth(response);
  }

  if (url.pathname === "/api/connect" && request.method === "POST") {
    return handleConnect(request, response);
  }

  if (url.pathname === "/api/disconnect" && request.method === "POST") {
    return handleDisconnect(response);
  }

  if (url.pathname === "/api/saved-settings" && request.method === "GET") {
    return sendJson(response, publicSettings());
  }

  if (url.pathname === "/api/admin/settings" && request.method === "POST") {
    return handleSaveSettings(request, response);
  }

  if (url.pathname === "/api/mac/settings" && request.method === "GET") {
    return handleMacSettings(response);
  }

  if (url.pathname === "/api/mac/settings" && request.method === "POST") {
    return handleSaveMacSettings(request, response);
  }

  if (url.pathname === "/api/admin/viewers" && request.method === "GET") {
    return sendJson(response, { viewers: listViewers() });
  }

  if (url.pathname === "/api/presence" && request.method === "POST") {
    return handlePresence(request, response);
  }

  // The old Control page is now the Stage Manager department (admin view; admin login checked above).
  if (url.pathname === "/control.html") {
    response.writeHead(302, { Location: `/dept.html?dept=${encodeURIComponent(stageManagerId())}` });
    return response.end();
  }

  if (url.pathname === "/api/departments" && request.method === "GET") {
    return sendJson(response, { departments: loginDepartments(), testingMode: getSettings().testingMode });
  }

  // Which cues each department owns, for the monitor/TV department filter (read-only).
  if (url.pathname === "/api/departments/cues" && request.method === "GET") {
    return sendJson(response, { departments: departmentCueMap() });
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await readBody(request);
    return sendJson(response, { ok: true, ...login(request, response, body) });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    logout(response);
    return sendJson(response, { ok: true });
  }

  if (url.pathname.startsWith("/api/dept/")) {
    // "Open as admin" (?dept=...) asks for the admin login rather than sending you to the department login.
    if (url.searchParams.get("dept") && !hasAdminAuth(request)) return requestAdminAuth(response);
    const department = requestDepartment(request, url);
    if (!department) return sendJson(response, { error: "Please log in." }, 401);
    if (url.pathname === "/api/dept/me" && request.method === "GET") {
      return sendJson(response, departmentView(department));
    }
    if (url.pathname === "/api/dept/cue" && request.method === "GET") {
      return sendJson(response, await departmentCueInfo(department, url.searchParams.get("cueId")));
    }
    if (url.pathname === "/api/dept/action" && request.method === "POST") {
      const result = await runDepartmentAction(department, await readBody(request));
      broadcastPatch();
      return sendJson(response, result);
    }
    return sendJson(response, { error: "Not found." }, 404);
  }

  if (url.pathname === "/api/admin/server" && request.method === "GET") {
    const credentials = adminCredentials();
    return sendJson(response, {
      adminUser: credentials.user,
      defaultPassword: usingDefaultAdminPassword(),
      fromEnvironment: credentials.fromEnvironment,
      platform: process.platform,
      appDir: ROOT_DIR,
      runningAsService: process.env.QLAB_CONNECT_SERVICE === "1",
      testingMode: getSettings().testingMode
    });
  }

  if (url.pathname === "/api/admin/testing-mode" && request.method === "POST") {
    const body = await readBody(request);
    await updateSettings({ ...getSettings(), testingMode: Boolean(body.enabled) });
    return sendJson(response, { ok: true, testingMode: getSettings().testingMode });
  }

  if (url.pathname === "/api/admin/admin-login" && request.method === "POST") {
    const body = await readBody(request);
    if (adminCredentials().fromEnvironment) {
      return sendJson(response, { error: "The admin login is set by ADMIN_USER / ADMIN_PASSWORD when the app starts. Remove those to change it here." }, 409);
    }
    const user = String(body.user || "").trim() || "admin";
    const password = String(body.password || "");
    if (password.length < 6) return sendJson(response, { error: "Use at least 6 characters for the admin password." }, 400);
    await updateServerSettings({ adminUser: user, adminPassword: password });
    return sendJson(response, { ok: true, adminUser: user });
  }

  if (url.pathname === "/api/admin/backup" && request.method === "GET") {
    const date = new Date().toISOString().slice(0, 10);
    const name = (state.workspaceName || "setup").replace(/\.qlab\d*$/i, "").replace(/[^\w -]+/g, "").trim() || "setup";
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name} ${date}.qlabconnect"`,
      "Cache-Control": "no-store"
    });
    return response.end(`${JSON.stringify(exportSetup({ includeSecrets: url.searchParams.get("secrets") === "1" }), null, 2)}\n`);
  }

  if (url.pathname === "/api/admin/restore" && request.method === "POST") {
    const { saved, restartRequired } = await importSetup(await readBody(request));
    if (saved.autoConnect && saved.host) keepConnected(saved);
    broadcastPatch();
    return sendJson(response, { ok: true, restartRequired });
  }

  if (url.pathname === "/api/admin/qlab-check" && request.method === "POST") {
    const body = await readBody(request).catch(() => ({}));
    return sendJson(response, await runQlabCheck({ testCueId: String(body.testCueId || "") }));
  }

  if (url.pathname === "/api/admin/qlab-info" && request.method === "GET") {
    return sendJson(response, await qlabDiagnostics());
  }

  if (url.pathname === "/api/admin/departments" && request.method === "GET") {
    const typeCounts = {};
    for (const cue of state.cues) {
      if (cue.depth > 0 && cue.type) typeCounts[cue.type] = (typeCounts[cue.type] || 0) + 1;
    }
    return sendJson(response, {
      departments: adminDepartmentList(),
      cueLists: state.cues.filter((cue) => cue.depth === 0).map((cue) => ({ id: cue.uniqueID, name: cue.name || cue.listName || "Cue list" })),
      typeCounts
    });
  }

  if (url.pathname === "/api/admin/departments" && request.method === "POST") {
    const body = await readBody(request);
    return sendJson(response, { departments: await updateDepartments(body.departments, body.passwords) });
  }

  if (url.pathname === "/api/state") {
    return sendJson(response, publicStateSnapshot());
  }

  if (url.pathname.startsWith("/api/control/")) {
    if (!hasControlAuth(request, url)) return requestAdminAuth(response);
    return handleControl(request, response, url.pathname.slice("/api/control/".length));
  }

  if (url.pathname === "/api/admin/control" && request.method === "GET") {
    return sendJson(response, { ...publicControlSettings(), actions: listControlActions() });
  }

  if (url.pathname === "/api/admin/control" && request.method === "POST") {
    return handleSaveControl(request, response);
  }

  if (url.pathname === "/api/admin/midi-output" && request.method === "GET") {
    return sendJson(response, { ...midiOutputStatus(), network: rtpMidiStatus() });
  }

  if (url.pathname === "/api/admin/midi-output" && request.method === "POST") {
    const body = await readBody(request);
    return sendJson(response, { ...(await selectMidiOutput(body.port)), network: rtpMidiStatus() });
  }

  if (url.pathname === "/api/admin/network-midi" && request.method === "POST") {
    const body = await readBody(request);
    const network = body.action === "disconnect"
      ? await disconnectNetworkMidi(body.name)
      : await connectNetworkMidi(body.name);
    return sendJson(response, { network });
  }

  if (url.pathname === "/api/admin/network" && request.method === "GET") {
    return sendJson(response, {
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      urls: networkUrls({ httpPort: HTTP_PORT, httpsPort: HTTPS_PORT })
    });
  }

  if (url.pathname === "/api/admin/qr.svg" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    return response.end(await qrSvg(url.searchParams.get("text") || ""));
  }

  if (url.pathname === "/api/admin/report" && request.method === "GET") {
    return sendJson(response, getShowReport());
  }

  if (url.pathname === "/api/admin/report.csv" && request.method === "GET") {
    const date = new Date().toISOString().slice(0, 10);
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="show-report-${date}.csv"`
    });
    return response.end(showReportCsv());
  }

  if (url.pathname === "/api/admin/meters" && request.method === "POST") {
    return handleMeters(request, response);
  }

  if (url.pathname === "/api/status") {
    return sendJson(response, publicStatePatch());
  }

  if (url.pathname === "/events") {
    return handleEvents(request, response);
  }

  return serveStatic(url.pathname, response);
}

export function startHeartbeat() {
  return setInterval(broadcastHeartbeat, 10000);
}

async function handleConnect(request, response) {
  const body = await readBody(request);
  const settings = getSettings();
  const host = String(body.host || "").trim();
  const workspaceId = String(body.workspaceId || "").trim();
  const requestedPasscode = String(body.passcode || "").trim();
  const canUseSavedPasscode = host === settings.host && (!workspaceId || workspaceId === settings.workspaceId);
  const passcode = requestedPasscode || (canUseSavedPasscode ? settings.passcode : "");

  if (!host) {
    return sendJson(response, { error: "QLab host is required." }, 400);
  }

  try {
    await connectToQlab({ host, passcode, workspaceId });
    sendJson(response, state);
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
    sendJson(response, { error: error.message }, 502);
  }
}

async function handleSaveSettings(request, response) {
  try {
    const body = await readBody(request);
    const previous = getSettings();
    const nextSettings = {
      ...previous,
      host: String(body.host || "").trim(),
      passcode: String(body.passcode || previous.passcode || "").trim(),
      workspaceId: String(body.workspaceId || "").trim(),
      autoConnect: Boolean(body.autoConnect)
    };

    if (!nextSettings.host) {
      return sendJson(response, { error: "QLab host is required." }, 400);
    }

    await updateSettings(nextSettings);

    if (nextSettings.autoConnect) {
      await connectToQlab(nextSettings);
    }

    sendJson(response, { ok: true, settings: publicSettings(), state });
  } catch (error) {
    sendJson(response, { error: error.message }, error.status || 500);
  }
}

function handleMacSettings(response) {
  sendJson(response, {
    qlab: publicSettings(),
    server: publicServerSettings(),
    active: {
      httpPort: HTTP_PORT,
      qlabTcpPort: QLAB_TCP_PORT,
      adminUser: ADMIN_USER,
      settingsPath: SETTINGS_PATH
    }
  });
}

async function handleSaveMacSettings(request, response) {
  const body = await readBody(request);
  const previous = getSettings();
  const qlab = body.qlab || {};
  const server = body.server || {};
  const nextSettings = {
    ...previous,
    host: String(qlab.host || "").trim(),
    passcode: String(qlab.passcode || previous.passcode || "").trim(),
    workspaceId: String(qlab.workspaceId || "").trim(),
    autoConnect: Boolean(qlab.autoConnect)
  };

  if (!nextSettings.host) {
    return sendJson(response, { error: "QLab host is required." }, 400);
  }

  await updateSettings(nextSettings);
  await updateServerSettings({
    httpPort: readPositiveNumber(server.httpPort, HTTP_PORT),
    qlabTcpPort: readPositiveNumber(server.qlabTcpPort, QLAB_TCP_PORT),
    adminUser: String(server.adminUser || ADMIN_USER).trim() || ADMIN_USER,
    adminPassword: String(server.adminPassword || previous.server.adminPassword || ADMIN_PASSWORD).trim()
  });

  sendJson(response, {
    ok: true,
    restartRequired: Number(server.httpPort) !== HTTP_PORT ||
      Number(server.qlabTcpPort) !== QLAB_TCP_PORT ||
      String(server.adminUser || "") !== ADMIN_USER ||
      Boolean(server.adminPassword),
    settings: publicSettings(),
    server: publicServerSettings()
  });
}

async function handleControl(request, response, action) {
  if (action === "actions" && request.method === "GET") {
    return sendJson(response, { actions: listControlActions(), enabled: getSettings().control.enabled });
  }

  if (action === "midi-mappings" && request.method === "GET") {
    return sendJson(response, { midiMappings: getSettings().control.midiMappings });
  }

  if (request.method !== "POST") {
    return sendJson(response, { error: "Use POST for control actions." }, 405);
  }

  // Raw MIDI pass-through for scripts; the MIDI page uses the /midi-ws socket instead.
  if (action === "midi") {
    const body = await readBody(request);
    sendMidiBytes(body.bytes);
    return sendJson(response, { ok: true });
  }

  const body = await readBody(request).catch(() => ({}));
  const result = await runControlAction(action, body, broadcastPatch);
  broadcastPatch();
  sendJson(response, { ok: true, action, ...result });
}

async function handleSaveControl(request, response) {
  const body = await readBody(request);
  const next = {};
  if (typeof body.enabled === "boolean") next.enabled = body.enabled;
  if (body.regenerateToken) next.token = createControlToken();
  if (Array.isArray(body.midiMappings)) {
    next.midiMappings = body.midiMappings.slice(0, 256).map(normalizeMidiMapping).filter(Boolean);
  }
  await updateControlSettings(next);
  broadcastPatch();
  sendJson(response, { ok: true, ...publicControlSettings(), actions: listControlActions() });
}

async function handleMeters(request, response) {
  const body = await readBody(request);
  const levels = Array.isArray(body.levels) ? body.levels.slice(0, 8) : [];
  broadcastMeters({
    label: String(body.label || "").slice(0, 60),
    at: Date.now(),
    levels: levels.map((level) => ({
      peak: clampLevel(level?.peak),
      rms: clampLevel(level?.rms)
    }))
  });
  response.writeHead(204);
  response.end();
}

function clampLevel(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
}

async function handleDisconnect(response) {
  await disconnectQlab();
  sendJson(response, state);
}

async function handlePresence(request, response) {
  const body = await readBody(request);
  updateViewerPresence(request, body);
  sendJson(response, { ok: true });
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
