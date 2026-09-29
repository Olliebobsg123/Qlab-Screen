import { broadcastPatch } from "./events.js";
import { registerMetaProvider } from "./state.js";

// Who's online: each open department page checks in every few seconds. A department is online
// while any of its pages has checked in recently (admin "Open as admin" views don't count).
const CHECK_IN_MS = 10_000;
const ONLINE_FOR_MS = CHECK_IN_MS * 2.5;
const pages = new Map(); // clientId -> { departmentId, seenAt, visible }
const lastSeen = new Map(); // departmentId -> last check-in time, kept after they leave
let lastOnlineKey = "";
// Pages that just closed: a "hidden" check-in sent as the page closes can arrive after "leaving".
const left = new Map();
const LEFT_FOR_MS = 5000;

export function checkIn(departmentId, { clientId, visible = true, leaving = false } = {}) {
  const id = String(clientId || "").slice(0, 80);
  if (!id) return;
  const now = Date.now();
  for (const [leftId, at] of left) if (now - at > LEFT_FOR_MS) left.delete(leftId);
  if (leaving) {
    pages.delete(id);
    left.set(id, now);
  } else if (left.has(id)) {
    return;
  } else {
    pages.set(id, { departmentId, seenAt: Date.now(), visible: visible !== false });
    lastSeen.set(departmentId, Date.now());
  }
  notifyIfChanged();
}

export function presence() {
  const now = Date.now();
  const result = {};
  for (const [clientId, page] of pages) {
    if (now - page.seenAt > ONLINE_FOR_MS) pages.delete(clientId);
  }
  for (const [departmentId, seenAt] of lastSeen) {
    const open = Array.from(pages.values()).filter((page) => page.departmentId === departmentId);
    result[departmentId] = {
      online: open.length > 0,
      screens: open.length,
      // Open, but the screen is locked or the tab is in the background.
      hidden: open.length > 0 && open.every((page) => !page.visible),
      lastSeenAt: new Date(seenAt).toISOString()
    };
  }
  return result;
}

function notifyIfChanged() {
  const key = JSON.stringify(Object.entries(presence()).map(([id, entry]) => [id, entry.online, entry.screens, entry.hidden]));
  if (key === lastOnlineKey) return;
  lastOnlineKey = key;
  broadcastPatch();
}

registerMetaProvider(() => ({ presence: presence() }));
setInterval(notifyIfChanged, 5000).unref();
