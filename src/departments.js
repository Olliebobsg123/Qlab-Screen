import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hasAdminAuth } from "./auth.js";
import { runControlAction } from "./control.js";
import { getCueLight, publicCueLights, setCueLight } from "./cuelights.js";
import { broadcastPatch } from "./events.js";
import { getClientIp } from "./http-utils.js";
import { listPlayhead, queryCueValue, registerNoteIds, sendWorkspaceCommand, setPlayhead, writeCueNotes } from "./qlab.js";
import { DEPARTMENT_PERMISSIONS, controlSettings, getDepartments, getSettings, saveDepartments, sessionSecret } from "./settings.js";
import { withDeskStart } from "./lighting-desk.js";
import { logEvent } from "./show.js";
import { registerMetaProvider, state } from "./state.js";

// Departments (lighting, video, stage...) log in with their own password and can control only
// their own cues: the cue lists assigned to them and/or cues with their colours or name prefixes.
const COOKIE = "qc_dept";
const SESSION_DAYS = 14;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();
// Departments that own cues by type/colour/prefix step through their own sequence: this is the
// cue each one will fire on its next GO.
const cursors = new Map();
const END = "__end__";

// Extra powers a department can be given, and the show-wide control actions each one unlocks.
// The Stage Manager department gets all of them.
const PERMISSION_ACTIONS = {
  showGo: ["go", "next", "previous"],
  transport: ["pause", "resume", "stop", "panic", "hardStop"],
  anyCue: ["startCue", "stopCue", "standby"],
  paging: ["page", "clearPage"],
  showClock: ["showStart", "showEnd", "intervalStart", "intervalEnd"]
};
const SCRUB_TYPES = new Set(["Audio", "Video", "Mic", "Fade", "MIDI File", "Group", "Text", "Camera", "Light"]);
const STAGE_MANAGER_ID = "stage-manager";

// The Stage Manager department always exists: create it on first run (and if it was lost).
ensureStageManager().catch((error) => console.warn(`Could not create the Stage Manager department: ${error.message}`));

async function ensureStageManager() {
  const departments = getDepartments();
  if (departments.some((department) => department.role === "stageManager")) return;
  await saveDepartments([{
    id: departments.some((department) => department.id === STAGE_MANAGER_ID) ? `${STAGE_MANAGER_ID}-${Date.now().toString(36)}` : STAGE_MANAGER_ID,
    name: "Stage Manager",
    color: "yellow",
    role: "stageManager",
    permissions: [...DEPARTMENT_PERMISSIONS],
    cueListIds: [],
    cueTypes: [],
    cueColors: [],
    namePrefixes: []
  }, ...departments]);
}

export function stageManagerId() {
  return getDepartments().find((department) => department.role === "stageManager")?.id || "";
}

// --- Automatic standbys ---
// A department can have its standby light come on by itself when its next cue is close in the
// show (the main cue list's playhead is N cues before it). When that cue plays, the light shows GO
// and clears; if the show moves past it without playing it, the light clears. Standbys the stage
// manager sets by hand are left alone.
const AUTO_STANDBY_TICK_MS = 250;
setInterval(runAutoStandbys, AUTO_STANDBY_TICK_MS).unref();

function departmentNextCue(department) {
  if (departmentMode(department) === "sequence") return sequenceNext(department);
  for (const listId of department.cueListIds) {
    const id = listPlayhead(listId);
    if (id) return id;
  }
  return "";
}

function runAutoStandbys() {
  const departments = getDepartments().filter((department) => department.autoStandby >= 0 && department.role !== "stageManager");
  if (!state.connected || !departments.length) return;
  const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
  const standby = cueMap.get(state.standbyId);
  const mainList = standby ? rootListId(standby, cueMap) : "";
  const position = new Map(state.cues.filter((cue) => cue.parentId === mainList).map((cue, index) => [cue.uniqueID, index]));
  // The top-level cue in the main list that holds this cue (itself, or the group it's in).
  const topOf = (id) => {
    let cue = cueMap.get(id);
    while (cue && cue.parentId !== mainList && cueMap.get(cue.parentId)) cue = cueMap.get(cue.parentId);
    return cue?.parentId === mainList ? cue.uniqueID : "";
  };
  const running = new Set(state.running.map((cue) => cue.uniqueID));
  const standbyPosition = position.get(topOf(state.standbyId));
  let changed = false;

  for (const department of departments) {
    const light = getCueLight(department.id);
    if (light?.auto && light.cueId && light.state !== "go" && running.has(light.cueId)) {
      setCueLight(department.id, "go", {}, broadcastPatch);
      changed = true;
      continue;
    }
    const next = departmentNextCue(department);
    const nextPosition = next && next !== END ? position.get(topOf(next)) : undefined;
    const distance = nextPosition != null && standbyPosition != null ? nextPosition - standbyPosition : null;
    const wanted = distance != null && distance >= 0 && distance <= department.autoStandby ? next : "";

    if (light && !light.auto) continue;
    if (light?.auto && light.state === "go") continue;
    if (light?.auto && light.cueId === wanted) continue;
    if (!wanted) {
      if (light?.auto) {
        setCueLight(department.id, "clear");
        changed = true;
      }
      continue;
    }
    const cue = cueMap.get(wanted);
    setCueLight(department.id, "standby", {
      cue: cue ? `${cue.number ? `${cue.number} ` : ""}${cue.name || cue.type || ""}`.trim() : "",
      cueId: wanted,
      by: "Auto standby",
      auto: true
    });
    logEvent("cue-light", `Auto standby → ${department.name}${cue ? `: ${cue.number || ""} ${cue.name || ""}`.trimEnd() : ""}`);
    changed = true;
  }
  if (changed) broadcastPatch();
}

// Every screen gets each department's next cue; department pages show their own.
registerMetaProvider(() => ({ deptNext: departmentNextIds(), cueLights: publicCueLights() }));
registerNoteIds(() => Object.values(departmentNextIds()));

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
  const submitted = Array.isArray(departments) ? departments : [];
  // The Stage Manager can be edited but not removed.
  const stageManager = getDepartments().find((department) => department.role === "stageManager");
  if (stageManager && !submitted.some((department) => department.id === stageManager.id)) submitted.unshift(stageManager);
  const next = submitted.map((department) => {
    const previous = existing.get(department.id) || {};
    const result = {
      ...department,
      // Only the built-in Stage Manager keeps its role; it can't be given to another department.
      role: previous.role || "",
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
    .map((department) => ({ id: department.id, name: department.name, color: department.color, role: department.role, followStandby: department.followStandby }));
}

export function login(request, response, { departmentId, password }) {
  const perTab = Boolean(getSettings().testingMode);
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
  const token = `${payload}.${sign(payload)}`;
  // In testing mode the login lives only in the tab that made it (the page sends it as a header);
  // otherwise it's a cookie shared by the whole browser.
  if (!perTab) {
    response.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  }
  return { department: publicDepartment(department), token: perTab ? token : "", perTab };
}

export function logout(response) {
  response.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// The department this request may act as: its login cookie, or any department for the admin.
export function requestDepartment(request, url) {
  const asAdmin = url.searchParams.get("dept");
  if (asAdmin && hasAdminAuth(request)) return findDepartment(asAdmin);

  // In testing mode each browser tab has its own login (sent as a header), so the shared cookie is ignored.
  const header = String(request.headers["x-dept-session"] || "");
  const value = getSettings().testingMode ? header : header || readCookie(request, COOKIE);
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

export function departmentCueMap() {
  return getDepartments().map((department) => ({
    id: department.id,
    name: department.name,
    color: department.color,
    cueIds: departmentCueIds(department)
  }));
}

export function departmentCueIds(department) {
  const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
  return state.cues.filter((cue) => ownsCue(department, cue, cueMap)).map((cue) => cue.uniqueID);
}

function ownsCue(department, cue, cueMap) {
  if (!cue?.uniqueID || cue.depth === 0) return false;
  if (cue.type === "Cue List" || cue.type === "Cue Cart") return false;
  const hasLists = department.cueListIds.length > 0;
  const hasFilters = hasCueFilters(department);
  if (!hasLists && !hasFilters) return false;

  if (hasLists && !department.cueListIds.includes(rootListId(cue, cueMap))) return false;
  if (!hasFilters) return true;

  // Any of type, colour or name prefix is enough (e.g. Audio and Mic cues both go to Sound).
  const typeMatch = department.cueTypes.includes(cue.type);
  const colorMatch = department.cueColors.includes(String(cue.colorName || "none").toLowerCase());
  const name = `${cue.number || ""} ${cue.name || ""}`.trim().toLowerCase();
  const prefixMatch = department.namePrefixes.some((prefix) => {
    const value = prefix.toLowerCase();
    return name.startsWith(value) || String(cue.name || "").toLowerCase().startsWith(value) ||
      String(cue.number || "").toLowerCase().startsWith(value);
  });
  return typeMatch || colorMatch || prefixMatch;
}

function hasCueFilters(department) {
  return department.cueTypes.length > 0 || department.cueColors.length > 0 || department.namePrefixes.length > 0;
}

// "list": the department owns whole cue lists, so GO uses QLab's own playhead for them.
// "sequence": it owns cues by type/colour/prefix, so GO steps through its own cues in show order.
function departmentMode(department) {
  return department.cueListIds.length && !hasCueFilters(department) ? "list" : "sequence";
}

// The department's cues in show order, leaving out cues inside a group it also owns
// (firing the group fires them).
function departmentSequence(department) {
  const owned = new Set(departmentCueIds(department));
  const cueMap = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
  return state.cues.filter((cue) => {
    if (!owned.has(cue.uniqueID)) return false;
    let parent = cueMap.get(cue.parentId);
    while (parent) {
      if (owned.has(parent.uniqueID)) return false;
      parent = cueMap.get(parent.parentId);
    }
    return true;
  });
}

// The next cue for a sequence department. It follows the show: if the main playhead has moved
// past the department's next cue, it jumps forward to the first of its cues from the playhead on.
function sequenceNext(department, sequence = departmentSequence(department)) {
  if (!sequence.length) return "";
  const order = new Map(state.cues.map((cue, index) => [cue.uniqueID, index]));
  const playheadIndex = order.get(state.standbyId) ?? -1;
  const fromPlayhead = sequence.find((cue) => order.get(cue.uniqueID) >= playheadIndex)?.uniqueID || "";

  const cursor = cursors.get(department.id);
  if (cursor?.cueId === END) {
    // Fired its last cue: nothing next until the show's playhead moves on.
    return cursor.playheadIndex !== playheadIndex && fromPlayhead ? fromPlayhead : "";
  }
  if (!cursor || !sequence.some((cue) => cue.uniqueID === cursor.cueId)) return fromPlayhead || sequence[0].uniqueID;
  // Only follow the show forwards, and only when the playhead actually moved since the cursor was set.
  if (cursor.playheadIndex !== playheadIndex && order.get(cursor.cueId) < playheadIndex && fromPlayhead) {
    return fromPlayhead;
  }
  return cursor.cueId;
}

function setCursor(department, cueId) {
  const order = new Map(state.cues.map((cue, index) => [cue.uniqueID, index]));
  cursors.set(department.id, { cueId, playheadIndex: order.get(state.standbyId) ?? -1 });
}

// For the pre-show check: where each department's GO starts, against its first cue.
export function departmentStarts() {
  return getDepartments()
    .filter((department) => department.role !== "stageManager" && departmentMode(department) === "sequence")
    .map((department) => {
      const sequence = departmentSequence(department);
      return { department, first: sequence[0]?.uniqueID || "", next: sequenceNext(department, sequence) };
    })
    .filter((entry) => entry.first);
}

// Put every department's GO back on its first cue (top of the show).
export function resetDepartmentStarts() {
  const moved = departmentStarts().filter((entry) => entry.next !== entry.first);
  for (const entry of moved) setCursor(entry.department, entry.first);
  return { reset: moved.length };
}

function departmentNextIds() {
  const result = {};
  for (const department of getDepartments()) {
    if (departmentMode(department) === "sequence") result[department.id] = sequenceNext(department);
  }
  return result;
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
  const mode = departmentMode(department);
  return {
    department: publicDepartment(department),
    mode,
    // Departments allowed to fire any cue see (and can control) the whole show.
    showAll: department.permissions.includes("anyCue"),
    cueIds: departmentCueIds(department),
    lists: mode === "list" ? lists : []
  };
}

// --- Actions ---

export async function runDepartmentAction(department, body = {}) {
  const { action, cueId, listId } = body;
  if (action === "control") return runShowAction(department, body);
  if (action === "cueLight") return runCueLightAction(department, body);
  if (action === "cueLightAck") {
    // The department answers its own standby.
    const light = getCueLight(department.id);
    if (!light || light.state !== "standby") throw httpError(409, "There's no standby to answer.");
    setCueLight(department.id, "ready");
    logEvent("cue-light", `${department.name}: standing by${light.cue ? ` for ${light.cue}` : ""}`);
    return { ok: true };
  }
  if (action === "addNote") return addRehearsalNote(department, body);
  if (!controlSettings().enabled) throw httpError(403, "QLab control is turned off. Ask the admin to turn it on.");
  const anyCue = department.permissions.includes("anyCue");
  const owned = new Set(anyCue ? state.cues.filter((cue) => cue.depth > 0).map((cue) => cue.uniqueID) : departmentCueIds(department));
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
  const sequenceMode = departmentMode(department) === "sequence";
  if (sequenceMode && (action === "go" || action === "next" || action === "previous")) {
    const sequence = departmentSequence(department);
    const current = sequenceNext(department, sequence);
    const index = sequence.findIndex((cue) => cue.uniqueID === current);
    if (index === -1) {
      if (action === "previous" && sequence.length) {
        setCursor(department, sequence[sequence.length - 1].uniqueID);
        return { ok: true };
      }
      throw httpError(409, sequence.length ? "You're at the end of your cues." : "This department has no cues.");
    }
    if (action === "go") {
      detail = `GO ${cueLabel(current)}`;
      // Move on before waiting for QLab, so the screen shows the next cue at once and a quick
      // second GO fires the next cue rather than this one again.
      const before = cursors.get(department.id);
      if (index < sequence.length - 1) setCursor(department, sequence[index + 1].uniqueID);
      else setCursor(department, END);
      broadcastPatch();
      try {
        await withDeskStart([current], department.name, () => sendWorkspaceCommand(`/cue_id/${current}/start`));
      } catch (error) {
        if (before) cursors.set(department.id, before);
        else cursors.delete(department.id);
        throw error;
      }
    } else {
      const step = action === "next" ? 1 : -1;
      const target = sequence[Math.max(0, Math.min(sequence.length - 1, index + step))];
      detail = `${action === "next" ? "Next" : "Previous"}: ${cueLabel(target.uniqueID)}`;
      setCursor(department, target.uniqueID);
    }
    logEvent("department", `${department.name}: ${detail}`);
    return { ok: true };
  }

  if (action === "go") {
    const id = requireList();
    const standby = listPlayhead(id);
    detail = `GO${standby ? ` ${cueLabel(standby)}` : ""}`;
    await withDeskStart([standby], department.name, () => goList(id));
  } else if (action === "start") {
    const id = requireCue();
    detail = `Start ${cueLabel(id)}`;
    await withDeskStart([id], department.name, () => sendWorkspaceCommand(`/cue_id/${id}/start`));
  } else if (action === "stop") {
    const id = requireCue();
    detail = `Stop ${cueLabel(id)}`;
    await sendWorkspaceCommand(`/cue_id/${id}/stop`);
  } else if (action === "standby" && sequenceMode && !anyCue) {
    const id = requireCue();
    detail = `Standby ${cueLabel(id)}`;
    setCursor(department, id);
  } else if (action === "standby") {
    const id = requireCue();
    const list = rootListId(cueMap.get(id), cueMap);
    if (!anyCue && !department.cueListIds.includes(list)) throw httpError(400, "Standby only works for cues in your own cue list.");
    detail = `Standby ${cueLabel(id)}`;
    await setPlayhead(list, id);
  } else if (action === "next" || action === "previous") {
    const id = requireList();
    detail = action === "next" ? "Playhead next" : "Playhead previous";
    await stepPlayhead(id, action === "next" ? 1 : -1);
  } else if (action === "pauseCue" || action === "resumeCue") {
    const id = requireCue();
    detail = `${action === "pauseCue" ? "Pause" : "Resume"} ${cueLabel(id)}`;
    await sendWorkspaceCommand(`/cue_id/${id}/${action === "pauseCue" ? "pause" : "resume"}`);
  } else if (action === "startAt" || action === "seek") {
    // Start a cue part-way through, or jump a running cue to a new time. Needs the "scrub" power.
    const id = requireCue();
    if (!department.permissions.includes("scrub")) throw httpError(403, "Your department can't choose start times. Ask the admin for the Start-from power.");
    const seconds = Number(body.time);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw httpError(400, "Choose a valid time.");
    const time = Math.round(seconds * 100) / 100;
    detail = `${action === "startAt" ? "Start" : "Jump"} ${cueLabel(id)} at ${formatSeconds(time)}`;
    if (action === "seek" && getSettings().qlabCaps.seek === "restart") {
      // This QLab can't jump a playing cue (found by the QLab check): stop, move, start again.
      await sendWorkspaceCommand(`/cue_id/${id}/stop`);
      await sendWorkspaceCommand(`/cue_id/${id}/loadActionAt`, [time]);
      await sendWorkspaceCommand(`/cue_id/${id}/start`);
    } else {
      await sendWorkspaceCommand(`/cue_id/${id}/loadActionAt`, [time]);
      if (action === "startAt") {
        await withDeskStart([id], department.name, () => sendWorkspaceCommand(`/cue_id/${id}/start`));
      }
    }
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

// Rehearsal notes: added to the end of the cue's notes in QLab, stamped with who and when, and
// kept in the show report either way (so a passcode without edit access doesn't lose them).
async function addRehearsalNote(department, body) {
  const id = String(body.cueId || "");
  const anyCue = department.permissions.includes("anyCue");
  if (!anyCue && !departmentCueIds(department).includes(id)) throw httpError(403, "That cue doesn't belong to your department.");
  const cue = state.cues.find((entry) => entry.uniqueID === id);
  if (!cue) throw httpError(404, "That cue isn't in the workspace any more.");
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) throw httpError(400, "Type a note first.");
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const stamped = `[${department.name} ${time}] ${text}`;
  const cueText = `${cue.number ? `${cue.number} ` : ""}${cue.name || cue.type || ""}`.trim();
  logEvent("note", `${cueText}: ${stamped}`);

  let savedToQlab = false;
  let reason = "";
  let notes = "";
  try {
    const current = String((await queryCueValue(id, "notes")) ?? "").trimEnd();
    notes = current ? `${current}\n${stamped}` : stamped;
    await writeCueNotes(id, notes);
    savedToQlab = true;
  } catch (error) {
    notes = "";
    reason = /denied/i.test(error.message)
      ? "QLab didn't allow it: give the OSC passcode edit access in QLab's Workspace Settings → Network."
      : error.message;
  }
  return { ok: true, savedToQlab, reason, notes };
}

// Details for the cue panel: how long it is, and whether this department may scrub it.
export async function departmentCueInfo(department, cueId) {
  const id = String(cueId || "");
  const anyCue = department.permissions.includes("anyCue");
  if (!anyCue && !departmentCueIds(department).includes(id)) throw httpError(403, "That cue doesn't belong to your department.");
  const cue = state.cues.find((entry) => entry.uniqueID === id);
  const running = state.time[id];
  let duration = Number(running?.duration || 0);
  if (!duration) duration = Number(await queryCueValue(id, "duration").catch(() => 0)) || 0;
  const notes = await queryCueValue(id, "notes").catch(() => null);
  return {
    cueId: id,
    notes: typeof notes === "string" ? notes.trim() : "",
    duration,
    canScrub: department.permissions.includes("scrub") && duration > 0 && SCRUB_TYPES.has(cue?.type)
  };
}

function formatSeconds(seconds) {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

// Standby / GO / clear another department's cue light. Uses the backstage-calls power and its
// "can send calls to" limits. A standby can name one of the target's cues; if the target has
// "follow standbys" on, that cue becomes its next cue (and its page opens it, ready to play).
async function runCueLightAction(department, body) {
  if (!department.permissions.includes("paging")) throw httpError(403, "Your department can't use cue lights.");
  const target = getDepartments().find((entry) => entry.id === String(body.target || ""));
  if (!target) throw httpError(404, "That department doesn't exist.");
  if (department.pageTargets.length && !department.pageTargets.includes(target.id)) {
    throw httpError(403, "Your department can't send cue lights there.");
  }
  const light = String(body.light || "");
  if (!["standby", "go", "clear"].includes(light)) throw httpError(400, "Unknown cue light.");

  let cueId = "";
  let cueText = String(body.cue || "");
  if (light === "standby" && body.cueId) {
    cueId = String(body.cueId);
    if (!departmentCueIds(target).includes(cueId)) throw httpError(400, `That cue isn't one of ${target.name}'s cues.`);
    const cue = state.cues.find((entry) => entry.uniqueID === cueId);
    if (!cueText && cue) cueText = `${cue.number ? `${cue.number} ` : ""}${cue.name || cue.type || ""}`.trim();
    if (target.followStandby) {
      if (departmentMode(target) === "sequence") {
        setCursor(target, cueId);
      } else {
        const cueMap = new Map(state.cues.map((entry) => [entry.uniqueID, entry]));
        await setPlayhead(rootListId(cue, cueMap), cueId).catch((error) => {
          console.warn(`Could not move ${target.name}'s playhead: ${error.message}`);
        });
      }
    }
  }
  setCueLight(target.id, light, { cue: cueText, cueId, by: department.name }, broadcastPatch);
  if (light !== "clear") {
    const current = getCueLight(target.id);
    logEvent("cue-light", `${department.name} → ${target.name}: ${light === "go" ? "GO" : "standby"}${current?.cue ? ` ${current.cue}` : ""}`);
  }
  return { ok: true };
}

// Show-wide actions (whole-show GO, panic, show clock, paging...) for departments with the power.
async function runShowAction(department, body) {
  const controlAction = String(body.control || "");
  const permission = Object.keys(PERMISSION_ACTIONS).find((key) => PERMISSION_ACTIONS[key].includes(controlAction));
  if (!permission) throw httpError(400, `Unknown action "${controlAction}".`);
  if (!department.permissions.includes(permission)) throw httpError(403, "Your department isn't allowed to do that.");
  if (controlAction === "page" && department.pageTargets.length &&
    !department.pageTargets.includes(String(body.target || "all").toLowerCase())) {
    throw httpError(403, "Your department can't send calls there.");
  }
  const result = await runControlAction(controlAction, { ...body, source: department.name }, broadcastPatch);
  return { ok: true, status: result?.status || "ok" };
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
    cueTypes: department.cueTypes,
    namePrefixes: department.namePrefixes,
    role: department.role,
    followStandby: department.followStandby,
    autoStandby: department.autoStandby,
    permissions: department.permissions,
    pageTargets: department.pageTargets
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
