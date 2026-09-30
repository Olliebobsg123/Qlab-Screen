import { clearCueLights, publicCueLights } from "./cuelights.js";
import { departmentCueIds, departmentStarts, resetDepartmentStarts } from "./departments.js";
import { deskCueFor, deskStatus, INSTANT_TYPES } from "./lighting-desk.js";
import { clearPage, publicPage } from "./paging.js";
import { presence } from "./presence.js";
import { secureStatus } from "./secure-address.js";
import { connectionInfo, queryCueValue } from "./qlab.js";
import { controlSettings, getSettings, usingDefaultAdminPassword } from "./settings.js";
import { publicShowState } from "./show.js";
import { state } from "./state.js";

// Pre-show check: one list of everything that should be right before the house opens.
// Each item: { id, group, status: "ok" | "warn" | "fail" | "info", title, detail, fix? }.
const MIN_DESK_WAIT = 0.15;
const MAX_CUE_QUERIES = 400;

export async function runPreshowCheck() {
  const items = [];
  // fix: what to do about it; action: a button that fixes it here.
  const add = (group, status, title, detail = "", fix = "", action = "") => items.push({ group, status, title, detail, fix, action });
  const settings = getSettings();
  const cues = state.cues.filter((cue) => cue.depth > 0 && cue.type !== "Cue List");

  // --- QLab ---
  if (!state.connected) {
    add("QLab", "fail", "QLab isn't connected", state.lastError || "Open the workspace in QLab and check Admin → QLab.");
  } else {
    add("QLab", "ok", `Connected to ${state.workspaceName}`, `${cues.length} cues`);
    const reply = connectionInfo().reply || "";
    if (reply.includes(":") && !reply.includes("control")) {
      add("QLab", "fail", "The OSC passcode can't control QLab", `QLab answered "${reply}". GO buttons won't work.`, "In QLab: Workspace Settings → Network, give the passcode control access.");
    }
  }
  if (!controlSettings().enabled) {
    add("QLab", "warn", "Cue control is switched off", "Departments and the Stage Manager can watch, but their buttons won't do anything.", "Admin → Control & API → Allow QLab control.");
  }
  if (state.connected) {
    const running = state.running.filter((cue) => cue.type !== "Cue List");
    if (running.length) add("QLab", "warn", `${running.length} cue${running.length === 1 ? " is" : "s are"} still playing`, running.slice(0, 5).map(label).join(", "));
    // Every department's GO should start the show on its first cue.
    const starts = departmentStarts();
    const cueById = new Map(state.cues.map((cue) => [cue.uniqueID, cue]));
    const moved = starts.filter((entry) => entry.next !== entry.first);
    const where = (entry, id) => `${entry.department.name}: ${id && cueById.get(id) ? label(cueById.get(id)) : "finished"}`;
    if (moved.length) {
      add("QLab", "warn", `${names(moved.map((entry) => entry.department.name))} ${moved.length === 1 ? "isn't" : "aren't"} on ${moved.length === 1 ? "its" : "their"} first cue`,
        `${moved.map((entry) => `${where(entry, entry.next)} (first is ${label(cueById.get(entry.first))})`).join(" · ")}`, "", "resetStarts");
    } else if (starts.length) {
      add("QLab", "ok", "Every department starts on its first cue", starts.map((entry) => where(entry, entry.first)).join(" · "));
    }

    const disarmed = cues.filter((cue) => cue.armed === 0);
    if (disarmed.length) add("QLab", "warn", `${disarmed.length} disarmed cue${disarmed.length === 1 ? "" : "s"}`, `These won't play: ${disarmed.slice(0, 8).map(label).join(", ")}${disarmed.length > 8 ? "…" : ""}`, "Re-arm them in QLab if that's left over from rehearsal.");

    const broken = await findBroken(cues);
    if (broken === null) add("QLab", "info", "Couldn't check for broken cues", "This QLab didn't answer the question.");
    else if (broken.length) add("QLab", "fail", `${broken.length} broken cue${broken.length === 1 ? "" : "s"}`, `Missing files or unpatched outputs: ${broken.slice(0, 8).map(label).join(", ")}${broken.length > 8 ? "…" : ""}`, "Look for the red ✕ next to them in QLab.");
    else add("QLab", "ok", "No broken cues");
  }

  // --- Lighting desk ---
  const desk = deskStatus();
  if (desk.enabled && desk.host) {
    if (desk.link.online) add("Lighting desk", "ok", "Desk connected", desk.link.detail);
    else add("Lighting desk", desk.transport === "tcp" ? "fail" : "warn", "Desk not connected", desk.link.detail, "Check the desk is on, on the network, with OSC on (Setup → Triggers).");
    const tagged = cues.filter((cue) => deskCueFor(cue));
    if (!tagged.length) {
      add("Lighting desk", "warn", "No cues are tagged for the desk", `Name a cue "${desk.prefix} 5" or add "[${desk.prefix} 5]" to its name.`);
    } else {
      add("Lighting desk", "ok", `${tagged.length} tagged cue${tagged.length === 1 ? "" : "s"}`);
      const unseen = await instantWithoutWait(tagged);
      if (unseen.length) {
        add("Lighting desk", "warn", `${unseen.length} tagged cue${unseen.length === 1 ? "" : "s"} end instantly`,
          `${unseen.slice(0, 8).map(label).join(", ")}. GO'd in QLab itself, these won't reach the desk.`,
          "Give each a pre-wait or post-wait of 0.2 s or more, or use a Wait cue.");
      }
      const numbers = new Map();
      for (const cue of tagged) {
        const key = deskCueFor(cue);
        numbers.set(key, [...(numbers.get(key) || []), cue]);
        // (keys are tag labels like "LX 5" or "LXM 3")
      }
      const repeated = [...numbers.entries()].filter(([, list]) => list.length > 1);
      if (repeated.length) {
        add("Lighting desk", "info", "Some desk commands are sent by more than one QLab cue",
          repeated.slice(0, 5).map(([number, list]) => `${number}: ${list.map(label).join(", ")}`).join("; "));
      }
    }
  }

  // --- Departments ---
  const online = presence();
  const group = "Departments";
  const here = [];
  const away = [];
  for (const department of settings.departments) {
    if (!department.passwordHash) {
      add(group, "warn", `${department.name} has no password`, "Nobody can log in to it.", "Admin → Departments → set a password.");
      continue;
    }
    const owned = department.role === "stageManager" ? cues.length : departmentCueIds(department).length;
    if (!owned) add(group, "warn", `${department.name} has no cues`, "Nothing in this workspace is assigned to it.", "Admin → Departments → choose its cue types or lists.");
    (online[department.id]?.online ? here : away).push(department.name);
  }
  // Departments come and go (phones sleep, people log in late), so this only needs someone on.
  if (here.length) add(group, "ok", `${names(here)} ${here.length === 1 ? "is" : "are"} logged in`, away.length ? `Not on yet: ${names(away)}.` : "");
  else if (away.length) add(group, "warn", "Nobody is logged in yet", `Departments: ${names(away)}.`);

  // --- Secure address ---
  const secure = secureStatus();
  if (secure.enabled) {
    const days = secure.certificate ? Math.floor((Date.parse(secure.certificate.expiresAt) - Date.now()) / 86400000) : 0;
    if (!secure.ready) add("Network", "warn", "The secure address isn't working yet", secure.lastError || "", "Admin → Share → Secure address.");
    else if (days < 14) add("Network", "warn", `The secure address's certificate runs out in ${days} day${days === 1 ? "" : "s"}`, "It renews by itself when this computer has internet.", "Connect to the internet for a minute, then Admin → Share → Get certificate.");
    else add("Network", "ok", `Secure address: ${secure.url}`, `Certificate good for ${days} more days.`);
    if (secure.dns && secure.dnsServer.error) add("Network", "warn", "The name server isn't running", secure.dnsServer.error);
  }

  // --- Leftovers from rehearsal ---
  const lights = Object.keys(publicCueLights());
  if (lights.length) add("Leftovers", "warn", `${lights.length} standby${lights.length === 1 ? " is" : "s are"} still showing`, "Clear them so departments start the show with no standby showing.", "", "clearStandbys");
  if (publicPage()) add("Leftovers", "warn", "A backstage call is still showing", `“${publicPage().text}”`, "", "clearPage");
  if (settings.testingMode) add("Leftovers", "warn", "Testing mode is on", "Logins only last until each tab closes.", "Admin → Server → turn off Testing mode.");
  const show = publicShowState();
  if (show.startedAt && !show.endedAt) add("Leftovers", "info", "The show clock is already running", "Start it again at the top of the show for accurate timings.");
  if (usingDefaultAdminPassword()) add("Leftovers", "warn", "The admin password is still the default", "Anyone on the network could change your setup.", "Admin → Server → change the admin login.");

  const failures = items.filter((item) => item.status === "fail").length;
  const warnings = items.filter((item) => item.status === "warn").length;
  return {
    checkedAt: new Date().toISOString(),
    verdict: failures ? "fail" : warnings ? "warn" : "ok",
    failures,
    warnings,
    items
  };
}

export function runPreshowFix(fix) {
  if (fix === "clearStandbys") return { cleared: clearCueLights() };
  if (fix === "clearPage") return clearPage();
  if (fix === "resetStarts") return resetDepartmentStarts();
  const error = new Error("Unknown fix.");
  error.status = 400;
  throw error;
}

async function findBroken(cues) {
  const results = await mapLimited(cues.slice(0, MAX_CUE_QUERIES), 12, async (cue) => {
    const value = await queryCueValue(cue.uniqueID, "isBroken").catch(() => undefined);
    return { cue, value };
  });
  if (results.length && results.every((result) => result.value == null)) return null;
  return results.filter((result) => result.value === true || Number(result.value) === 1).map((result) => result.cue);
}

// Tagged cues that end the moment they start (Memo...) with no pre/post-wait to make them visible.
async function instantWithoutWait(tagged) {
  const instant = tagged.filter((cue) => INSTANT_TYPES.has(cue.type));
  const results = await mapLimited(instant, 8, async (cue) => {
    const [pre, post] = await Promise.all([
      queryCueValue(cue.uniqueID, "preWait").catch(() => 0),
      queryCueValue(cue.uniqueID, "postWait").catch(() => 0)
    ]);
    return { cue, wait: Math.max(Number(pre) || 0, Number(post) || 0) };
  });
  return results.filter((result) => result.wait < MIN_DESK_WAIT).map((result) => result.cue);
}

async function mapLimited(list, limit, run) {
  const results = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const item = list[index++];
      results.push(await run(item));
    }
  }));
  return results;
}

function label(cue) {
  return `${cue.number ? `${cue.number} ` : ""}${cue.name || cue.type || ""}`.trim() || "(unnamed)";
}

function names(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list.join("");
}
