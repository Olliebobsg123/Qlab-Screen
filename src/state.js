import { APP_VERSION } from "./config.js";
import { publicPage } from "./paging.js";
import { controlSettings } from "./settings.js";
import { publicShowState } from "./show.js";

export const state = {
  connected: false,
  host: "",
  workspaceId: "",
  workspaceName: "",
  lastError: "",
  lastMessageAt: null,
  cues: [],
  running: [],
  time: {},
  standbyId: "",
  notes: {},
  polling: false
};

let cuesVersion = 0;
let cuesSignature = "";
let runningSignature = "";
let timeSignature = "";
let metaSignature = "";
let cuesDirty = false;

export function setDisconnected(next = {}) {
  Object.assign(state, {
    connected: false,
    host: next.host ?? state.host,
    workspaceId: "",
    workspaceName: "",
    lastError: next.lastError || "",
    cues: [],
    running: [],
    time: {},
    standbyId: "",
    notes: {}
  });
  cuesSignature = JSON.stringify(state.cues);
  cuesVersion += 1;
  cuesDirty = true;
}

// Only a real change bumps the version, so screens don't redraw the whole list on every QLab update.
export function markCuesIfChanged(nextCues) {
  const nextSignature = JSON.stringify(nextCues);
  if (nextSignature !== cuesSignature) {
    state.cues = nextCues;
    cuesSignature = nextSignature;
    cuesVersion += 1;
    cuesDirty = true;
    return true;
  }
  return false;
}

export function publicStateSnapshot() {
  return {
    ...publicStatePatch(),
    cues: state.cues
  };
}

export function publicStatePatch() {
  return {
    ...publicStateMeta(),
    running: state.running,
    time: state.time,
    cuesVersion,
    // Lets browsers correct for clock drift when showing the show clock and countdowns.
    serverTime: Date.now()
  };
}

export function publicStateMeta() {
  return {
    appVersion: APP_VERSION,
    connected: state.connected,
    host: state.host,
    workspaceId: state.workspaceId,
    workspaceName: state.workspaceName,
    lastError: state.lastError,
    lastMessageAt: state.lastMessageAt,
    polling: state.polling,
    standbyId: state.standbyId,
    notes: state.notes,
    show: publicShowState(),
    page: publicPage(),
    controlEnabled: controlSettings().enabled
  };
}

export function syncSignatures() {
  cuesSignature = JSON.stringify(state.cues);
  runningSignature = JSON.stringify(state.running);
  timeSignature = JSON.stringify(state.time);
  metaSignature = JSON.stringify(publicStateMeta());
}

export function clearCuesDirty() {
  cuesDirty = false;
}

export function consumeChangeType() {
  const nextRunningSignature = JSON.stringify(state.running);
  const nextTimeSignature = JSON.stringify(state.time);
  const nextMetaSignature = JSON.stringify(publicStateMeta());
  const changed = cuesDirty ||
    nextRunningSignature !== runningSignature ||
    nextTimeSignature !== timeSignature ||
    nextMetaSignature !== metaSignature;

  if (!changed) return null;

  if (cuesDirty) {
    cuesDirty = false;
    syncSignatures();
    return "snapshot";
  }

  runningSignature = nextRunningSignature;
  timeSignature = nextTimeSignature;
  metaSignature = nextMetaSignature;
  return "patch";
}
