import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hasAdminAuth } from "./auth.js";
import { getClientIp } from "./http-utils.js";
import { listPlayhead, sendWorkspaceCommand, setPlayhead } from "./qlab.js";
import { controlSettings, getDepartments, saveDepartments, sessionSecret } from "./settings.js";
import { logEvent } from "./show.js";
import { state } from "./state.js";

// Departments (lighting, video, stage...) log in with their own password and can control only
// their own cues: the cue lists assigned to them and/or cues with their colours or name prefixes.
const COOKIE = "qc_dept";
const SESSION_DAYS = 14;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();

// --- Admin management ---

export function adminDepartmentList() {
  return getDepartments().map((department) => ({
    ...publicDepartment(department),
    hasPassword: Boolean(department.passwordHash)
  }));
}

// `departments` is the full edited list; `passwords` maps department id -> new password (optional).
export async function updateDepartments(departments, passwords = {}) {
  const existing = new Map(getDepartments().map((department) => [department.id, department]));
  const next = (Array.isArray(departments) ? departments : []).map((department) => {
    const previous = existing.get(department.id) || {};
    const result = {
      ...department,
      passwordHash: previous.passwordHash || "",
      passwordSalt: previous.passwordSalt || ""
    };
    const password = passwords?.[department.id];
    if (typeof password === "string" && password.length) {
      if (password.length < 4) throw httpError(400, `The password for ${department.name || "a department"} must be at least 4 characters.`);
      result.passwordSalt = randomBytes(16).toString("hex");
      result.passwordHash = hashPassword(password, result.passwordSalt);
    }
    return result;
  });
  await saveDepartments(next);
  return adminDepartmentList();
}

// --- Login sessions (signed cookie, no server-side session store) ---

export function loginDepartments() {
  return getDepartments()
    .filter((department) => department.passwordHash)
    .map((department) => ({ id: department.id, name: department.name, color: department.color }));
}

export function login(request, response, { departmentId, password }) {
  const ip = getClientIp(request);
  const failures = (loginFailures.get(ip) || []).filter((at) => at > Date.now() - LOGIN_WINDOW_MS);
  if (failures.length >= LOGIN_MAX_FAILURES) throw httpError(429, "Too many attempts. Wait a minute and try again.");

  const department = findDepartment(departmentId);
  const valid = department?.passwordHash &&
    safeEqualHex(hashPassword(String(password || ""), department.passwordSalt), department.passwordHash);
  if (!valid) {
    failures.push(Date.now());
    loginFailures.set(ip, failures);
    throw httpError(401, "Wrong password.");
  }
  loginFailures.delete(ip);

  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${department.id}.${expires}.${department.passwordHash.slice(0, 12)}`;
  const cookie = `${payload}.${sign(payload)}`;
  response.setHeader("Set-Cookie", `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  return publicDepartment(department);
}

export function logout(response) {
  response.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// The department this request may act as: its login cookie, or any department for the admin.
export function requestDepartment(request, url) {
  const asAdmin = url.searchParams.get("dept");
  if (asAdmin && hasAdminAuth(request)) return findDepartment(asAdmin);

  const value = readCookie(request, COOKIE);
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [id, expires, passwordTag, signature] = parts;
  const payload = `${id}.${expires}.${passwordTag}`;
  if (!safeEqualHex(sign(payload), signature) || Number(expires) < Date.now()) return null;
  const department = findDepartment(id);
  // Changing a department's password signs everyone out of it.
  if (!department || department.passwordHash.slice(0, 12) !== passwordTag) return null;
  return department;
}

// --- Which cues a department owns ---

export function departmentCueIds(department) {
  const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
  return state.cues.filter((cue) => ownsCue(department, cue, cueMap)).map((cue) => cue.uniqueID);
}

function ownsCue(department, cue, cueMap) {
  if (!cue?.uniqueID || cue.depth === 0) return false;
  const hasLists = department.cueListIds.length > 0;
  const hasFilters = department.cueColors.length > 0 || department.namePrefixes.length > 0;
  if (!hasLists && !hasFilters) return false;

  if (hasLists && !department.cueListIds.includes(rootListId(cue, cueMap))) return false;
  if (!hasFilters) return true;

  const colorMatch = department.cueColors.includes(String(cue.colorName || "none").toLowerCase());
  const name = `${cue.number || ""} ${cue.name || ""}`.trim().toLowerCase();
  const prefixMatch = department.namePrefixes.some((prefix) => {
    const value = prefix.toLowerCase();
    return name.startsWith(value) || String(cue.name || "").toLowerCase().startsWith(value) ||
      String(cue.number || "").toLowerCase().startsWith(value);
  });
  return colorMatch || prefixMatch;
}

function rootListId(cue, cueMap) {
  let current = cue;
  while (current?.parentId && cueMap.get(current.parentId)) current = cueMap.get(current.parentId);
  return current?.depth === 0 ? current.uniqueID : "";
}

export function departmentView(department) {
  const lists = state.cues
    .filter((cue) => cue.depth === 0 && department.cueListIds.includes(cue.uniqueID))
    .map((list) => ({ id: list.uniqueID, name: list.name || list.listName || "Cue list", playheadId: listPlayhead(list.uniqueID) }));
  return {
    department: publicDepartment(department),
    cueIds: departmentCueIds(department),
    lists
  };
}

// --- Actions ---

export async function runDepartmentAction(department, { action, cueId, listId }) {
  if (!controlSettings().enabled) throw httpError(403, "QLab control is turned off. Ask the admin to turn it on.");
  const owned = new Set(departmentCueIds(department));
  const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
  const cueLabel = (id) => {
    const cue = cueMap.get(id);
    return cue ? `${cue.number ? `${cue.number} ` : ""}${cue.name || cue.type || ""}`.trim() : id;
  };
  const requireCue = () => {
    if (!owned.has(String(cueId || ""))) throw httpError(403, "That cue doesn't belong to your department.");
    return String(cueId);
  };
  const requireList = () => {
    if (!department.cueListIds.includes(String(listId || ""))) throw httpError(403, "That cue list doesn't belong to your department.");
    return String(listId);
  };

  let detail = "";
  if (action === "go") {
    const id = requireList();
    detail = `GO${listPlayhead(id) ? ` ${cueLabel(listPlayhead(id))}` : ""}`;
    await goList(id);
  } else if (action === "start") {
    const id = requireCue();
    detail = `Start ${cueLabel(id)}`;
    await sendWorkspaceCommand(`/cue_id/${id}/start`);
  } else if (action === "stop") {
    const id = requireCue();
    detail = `Stop ${cueLabel(id)}`;
    await sendWorkspaceCommand(`/cue_id/${id}/stop`);
  } else if (action === "standby") {
    const id = requireCue();
    const list = rootListId(cueMap.get(id), cueMap);
    if (!department.cueListIds.includes(list)) throw httpError(400, "Standby only works for cues in your own cue list.");
    detail = `Standby ${cueLabel(id)}`;
    await setPlayhead(list, id);
  } else if (action === "next" || action === "previous") {
    const id = requireList();
    detail = action === "next" ? "Playhead next" : "Playhead previous";
    await stepPlayhead(id, action === "next" ? 1 : -1);
  } else if (action === "stopAll") {
    const running = state.running.filter((cue) => owned.has(cue.uniqueID));
    detail = `Stop all (${running.length})`;
    await Promise.all(running.map((cue) => sendWorkspaceCommand(`/cue_id/${cue.uniqueID}/stop`)));
  } else {
    throw httpError(400, `Unknown action "${action}".`);
  }

  logEvent("department", `${department.name}: ${detail}`);
  return { ok: true };
}

// GO a specific cue list: start the cue at its playhead and move the playhead on.
async function goList(listId) {
  try {
    await sendWorkspaceCommand(`/cue_id/${listId}/go`);
    return;
  } catch (error) {
    if (error.status !== 502 || /denied/.test(error.message)) throw error;
  }
  // Fallback for QLab versions without list-level GO.
  const standby = listPlayhead(listId);
  if (!standby) throw httpError(409, "Nothing is on standby in this cue list.");
  await sendWorkspaceCommand(`/cue_id/${standby}/start`);
  await stepPlayhead(listId, 1);
}

async function stepPlayhead(listId, direction) {
  const topLevel = state.cues.filter((cue) => cue.parentId === listId && cue.depth === 1);
  if (!topLevel.length) return;
  const index = topLevel.findIndex((cue) => cue.uniqueID === listPlayhead(listId));
  const nextIndex = index === -1 ? 0 : Math.max(0, Math.min(topLevel.length - 1, index + direction));
  await setPlayhead(listId, topLevel[nextIndex].uniqueID);
}

// --- Helpers ---

function publicDepartment(department) {
  return {
    id: department.id,
    name: department.name,
    color: department.color,
    cueListIds: department.cueListIds,
    cueColors: department.cueColors,
    namePrefixes: department.namePrefixes
  };
}

function findDepartment(id) {
  return getDepartments().find((department) => department.id === String(id || "")) || null;
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 32).toString("hex");
}

function sign(payload) {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(request, name) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
