import { timingSafeEqual } from "node:crypto";
import { adminCredentials } from "./settings.js";

const ADMIN_PAGES = new Set([
  "/admin.html",
  "/admin.js",
  "/viewers.html",
  "/comms-feed.html",
  "/viewers.js",
  "/control.html",
  "/midi.html",
  "/midi.js",
  "/report.html",
  "/report.js",
  "/meter-source.html",
  "/meter-source.js"
]);

export function isAdminPath(pathname) {
  return ADMIN_PAGES.has(pathname) || pathname.startsWith("/api/admin/");
}

export function hasAdminAuth(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const splitAt = decoded.indexOf(":");
    const username = decoded.slice(0, splitAt);
    const password = decoded.slice(splitAt + 1);
    const expected = adminCredentials();
    return safeEqual(username, expected.user) && safeEqual(password, expected.password);
  } catch {
    return false;
  }
}

export function requestAdminAuth(response) {
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="QLab Screen Admin"',
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end("Authentication required.");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
