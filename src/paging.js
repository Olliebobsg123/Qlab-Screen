// Backstage paging: one active message that every connected screen shows full-screen.
const MAX_MESSAGE_LENGTH = 200;
const LEVELS = new Set(["info", "call", "urgent"]);

let current = null;
let clearTimer = null;

export function publicPage() {
  return current;
}

export function sendPage({ text, level = "call", durationSec = 0, target = "all" } = {}, onExpire = () => {}) {
  const message = String(text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!message) {
    const error = new Error("Page message is required.");
    error.status = 400;
    throw error;
  }

  const seconds = Number(durationSec);
  const sentAt = new Date();
  current = {
    id: `${sentAt.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: message,
    level: LEVELS.has(level) ? level : "call",
    target: String(target || "all").trim().toLowerCase() || "all",
    sentAt: sentAt.toISOString(),
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? new Date(sentAt.getTime() + seconds * 1000).toISOString() : null
  };

  clearTimeout(clearTimer);
  if (current.expiresAt) {
    const id = current.id;
    clearTimer = setTimeout(() => {
      if (current?.id === id) {
        current = null;
        onExpire();
      }
    }, seconds * 1000);
  }
  return current;
}

export function clearPage() {
  clearTimeout(clearTimer);
  current = null;
}
