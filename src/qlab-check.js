import { connectionInfo, rawQuery, sendWorkspaceCommand } from "./qlab.js";
import { getSettings, updateSettings } from "./settings.js";
import { state } from "./state.js";

// "Check QLab" in Admin: works out what this QLab (version, passcode, workspace) supports.
// The standard checks only read from QLab. The optional cue test plays one cue the admin chooses
// for a few seconds to check start-from, jumping while playing, pause and stop, and switches the
// app to a backup method for anything that doesn't work.
export async function runQlabCheck({ testCueId = "" } = {}) {
  const results = [];
  const add = (label, status, detail = "") => results.push({ label, status, detail });

  if (!state.connected) {
    add("Connected to QLab", "fail", state.lastError || "Not connected. Check the address and passcode in the QLab tab.");
    return { results };
  }
  add("Connected to QLab", "ok", `Workspace “${state.workspaceName}”`);

  const version = await rawQuery("/version", [], 1500).then((reply) => String(reply.data || "")).catch(() => "");
  add("QLab version", version ? "ok" : "warn", version || "QLab didn't say which version it is.");

  const info = connectionInfo();
  const reply = info.reply.toLowerCase();
  if (reply.includes("control")) add("Passcode can control cues", "ok", `QLab allows: ${reply.replace(/^ok:?/, "").replaceAll("|", ", ")}`);
  else if (reply.includes(":")) add("Passcode can control cues", "fail", `This passcode only allows: ${reply.replace(/^ok:?/, "").replaceAll("|", ", ")}. Give it Control access in QLab → Workspace Settings → OSC.`);
  else add("Passcode can control cues", "warn", "QLab didn't say what the passcode allows (older QLab, or no passcode). If buttons don't fire cues, give the passcode Control access.");

  const times = [];
  for (let index = 0; index < 3; index += 1) {
    const started = Date.now();
    await rawQuery("/runningOrPausedCues", [], 2000).then(() => times.push(Date.now() - started)).catch(() => {});
  }
  if (times.length) {
    const average = Math.round(times.reduce((sum, value) => sum + value, 0) / times.length);
    add("Response time", average < 150 ? "ok" : "warn", `${average} ms on average${average >= 150 ? ". That's slow; check the network between this server and the QLab Mac." : ""}`);
  } else {
    add("Response time", "fail", "QLab didn't answer.");
  }

  const lists = state.cues.filter((cue) => cue.depth === 0);
  const carts = lists.filter((list) => list.type === "Cue Cart").length;
  add("Cue lists", lists.length ? "ok" : "warn", `${lists.length - carts} cue list${lists.length - carts === 1 ? "" : "s"}${carts ? `, ${carts} cart${carts === 1 ? "" : "s"}` : ""}, ${state.cues.length - lists.length} cues`);

  const firstList = lists.find((list) => list.type !== "Cue Cart");
  if (firstList) {
    let field = "";
    for (const candidate of ["playheadId", "playbackPositionId"]) {
      const answer = await rawQuery(`/cue_id/${firstList.uniqueID}/${candidate}`, [], 1500).catch(() => null);
      if (answer && (!answer.status || answer.status === "ok")) {
        field = candidate;
        break;
      }
    }
    add("Reading the playhead (next cue)", field ? "ok" : "fail", field ? `Using ${field}` : "QLab didn't answer. The next cue will only update when QLab announces changes.");
  }

  const sample = state.cues.find((cue) => ["Audio", "Video", "Mic"].includes(cue.type)) || state.cues.find((cue) => cue.depth > 0);
  if (sample) {
    const [duration, notes] = await Promise.all([
      rawQuery(`/cue_id/${sample.uniqueID}/duration`, [], 1500).catch(() => null),
      rawQuery(`/cue_id/${sample.uniqueID}/notes`, [], 1500).catch(() => null)
    ]);
    add("Reading cue lengths", duration ? "ok" : "warn", duration ? `e.g. ${sample.number || sample.name}: ${Number(duration.data || 0).toFixed(1)} s` : "Durations aren't available, so remaining times won't show.");
    add("Reading cue notes", notes ? "ok" : "warn", notes ? "Notes show on screens" : "Notes aren't available.");
  }

  const connectedFor = (Date.now() - info.connectedAt) / 1000;
  add("QLab announces changes", info.updates > 0 ? "ok" : "warn", info.updates > 0
    ? `${info.updates} change messages so far`
    : `None yet after ${Math.round(connectedFor)} s. That's fine if nothing changed; the app also checks every half second.`);

  if (testCueId) await testWithCue(testCueId, add);
  else add("Start from / skip / pause", "skipped", "Pick a cue below to test these. It plays for a few seconds.");

  return { results, qlabCaps: getSettings().qlabCaps };
}

async function testWithCue(cueId, add) {
  const cue = state.cues.find((entry) => entry.uniqueID === cueId);
  if (!cue) {
    add("Cue test", "fail", "That cue isn't in the workspace any more.");
    return;
  }
  const label = `${cue.number ? `${cue.number} ` : ""}${cue.name || cue.type}`;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const elapsed = async () => Number((await rawQuery(`/cue_id/${cueId}/actionElapsed`, [], 1500).catch(() => ({ data: -1 }))).data);
  const paused = async () => Boolean(Number((await rawQuery(`/cue_id/${cueId}/isPaused`, [], 1500).catch(() => ({ data: 0 }))).data));
  const running = async () => {
    const reply = await rawQuery("/runningOrPausedCues", [], 1500).catch(() => ({ data: [] }));
    const list = Array.isArray(reply.data) ? reply.data : [];
    const found = (cues) => cues.some((entry) => entry.uniqueID === cueId || (Array.isArray(entry.cues) && found(entry.cues)));
    return found(list);
  };

  try {
    // Start part-way through.
    await sendWorkspaceCommand(`/cue_id/${cueId}/loadActionAt`, [2]);
    await sendWorkspaceCommand(`/cue_id/${cueId}/start`);
    await wait(700);
    const afterStart = await elapsed();
    add(`Start from a point (${label})`, afterStart >= 1.9 ? "ok" : "fail",
      afterStart >= 1.9 ? `Started at 2 s, now at ${afterStart.toFixed(1)} s` : `Asked to start at 2 s but it's at ${afterStart.toFixed(1)} s. “Start from here” won't work on this QLab.`);

    // Jump while playing, directly.
    await sendWorkspaceCommand(`/cue_id/${cueId}/loadActionAt`, [6]);
    await wait(500);
    let seekMode = "direct";
    let afterJump = await elapsed();
    if (afterJump < 5.8 || !(await running())) {
      // Backup: stop, move, start again (a tiny gap, but it works everywhere).
      await sendWorkspaceCommand(`/cue_id/${cueId}/stop`).catch(() => {});
      await wait(150);
      await sendWorkspaceCommand(`/cue_id/${cueId}/loadActionAt`, [6]);
      await sendWorkspaceCommand(`/cue_id/${cueId}/start`);
      await wait(500);
      afterJump = await elapsed();
      seekMode = afterJump >= 5.8 ? "restart" : "none";
    }
    add("Jump while playing", seekMode === "direct" ? "ok" : seekMode === "restart" ? "warn" : "fail",
      seekMode === "direct" ? "Jumps smoothly"
        : seekMode === "restart" ? "QLab can't jump a playing cue, so the app will stop, move and restart it (a very short gap)."
          : "Couldn't jump the cue. Skip buttons won't work on this QLab.");
    const settings = getSettings();
    await updateSettings({ ...settings, qlabCaps: { seek: seekMode === "restart" ? "restart" : "direct", checkedAt: new Date().toISOString() } });

    // Pause and resume.
    await sendWorkspaceCommand(`/cue_id/${cueId}/pause`);
    await wait(300);
    const didPause = await paused();
    await sendWorkspaceCommand(`/cue_id/${cueId}/resume`);
    await wait(300);
    const didResume = !(await paused());
    add("Pause and resume a cue", didPause && didResume ? "ok" : "fail", didPause && didResume ? "Works" : "QLab didn't report the cue as paused and resumed.");
  } catch (error) {
    add("Cue test", "fail", error.message);
  } finally {
    await sendWorkspaceCommand(`/cue_id/${cueId}/stop`).catch(() => {});
    await wait(400);
    const stopped = !(await running());
    add("Stop a cue", stopped ? "ok" : "warn", stopped ? "Stopped again at the end of the test" : "The test cue may still be playing. Stop it in QLab.");
  }
}
