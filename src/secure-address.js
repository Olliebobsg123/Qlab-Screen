import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Resolver, promises as dnsPromises } from "node:dns";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import acme from "acme-client";
import { SETTINGS_DIR } from "./config.js";
import { configureDnsServer, dnsStatus, setDnsIpv6 } from "./dns-server.js";
import { primaryAddress, primaryIPv6 } from "./network.js";
import { getSettings } from "./settings.js";

// The secure address: a free name (a DuckDNS name like qlab-connect.duckdns.org) with a real,
// free Let's Encrypt certificate, so every browser opens the site with no "not secure" warning.
//   - The certificate is proved with a DNS record set through DuckDNS, so it needs the internet
//     only when it's fetched or renewed (every couple of months), never during a show.
//   - DuckDNS points the name at this computer's address on the show network, for devices that
//     look names up on the internet; the built-in name server (dns-server.js) answers it with no
//     internet at all.

const DIR = join(SETTINGS_DIR, "tls", "named");
const CERT_FILE = join(DIR, "cert.pem");
const KEY_FILE = join(DIR, "key.pem");
const ACCOUNT_FILE = join(DIR, "account.pem");
const META_FILE = join(DIR, "meta.json");
const RENEW_BEFORE_DAYS = 30;
const CHECK_EVERY_MS = 6 * 3600000;
const RETRY_MS = 3600000;
const ADDRESS_CHECK_MS = 60000;
const DIRECTORY = process.env.QLAB_ACME_STAGING === "1" ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;

export const secureEvents = new EventEmitter();

let credentials = null; // { cert, key, name, expiresAt, issuedAt }
let status = { busy: false, step: "", lastError: "", lastTryAt: "", publishedIp: "", address: "", publishedIpv6: "", ipv6: "" };
let retryTimer = null;
let securePort = 0;

// The https port people should use (443 when this computer allows it, so no ":port" in the address).
export function setSecurePort(port) {
  securePort = port;
}

export function normalizeSecureName(value) {
  const name = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.duckdns\.org$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : "";
}

function config() {
  const saved = getSettings().secureAddress;
  return { ...saved, fullName: saved.name ? `${saved.name}.duckdns.org` : "" };
}

// The certificate for the secure name, if there is a current one (for the https server).
export function namedCredentials() {
  const { enabled, fullName } = config();
  if (!enabled || !credentials || credentials.name !== fullName) return null;
  return Date.parse(credentials.expiresAt) > Date.now() ? credentials : null;
}

// "https://qlab-connect.duckdns.org[:port]" when it's ready to use, else "".
export function secureOrigin() {
  const named = namedCredentials();
  if (!named || !securePort) return "";
  return `https://${named.name}${securePort !== 443 ? `:${securePort}` : ""}`;
}

export function secureStatus() {
  const { enabled, name, fullName, dns, token } = config();
  const named = namedCredentials();
  return {
    enabled,
    name,
    fullName,
    dns,
    hasToken: Boolean(token),
    ready: Boolean(named),
    url: secureOrigin(),
    certificate: credentials && credentials.name === fullName ? { expiresAt: credentials.expiresAt, issuedAt: credentials.issuedAt } : null,
    ...status,
    dnsServer: dnsStatus()
  };
}

export async function startSecureAddress() {
  credentials = await readSaved();
  if (credentials) secureEvents.emit("certificate");
  applySecureSettings();
  setInterval(() => renewIfDue().catch(() => {}), CHECK_EVERY_MS).unref();
  setInterval(() => publishAddress().catch(() => {}), ADDRESS_CHECK_MS).unref();
}

// After the settings change: start/stop the name server, and fetch a certificate if needed.
export function applySecureSettings() {
  const { enabled, dns, fullName } = config();
  configureDnsServer(enabled && dns ? fullName : "");
  secureEvents.emit("certificate");
  if (enabled) {
    publishAddress().catch(() => {});
    renewIfDue().catch(() => {});
  }
}

export async function renewIfDue({ force = false } = {}) {
  const { enabled, fullName, token } = config();
  if (!enabled || !fullName || !token || status.busy) return secureStatus();
  const current = credentials?.name === fullName ? credentials : null;
  const due = !current || Date.parse(current.expiresAt) - Date.now() < RENEW_BEFORE_DAYS * 86400000;
  if (!due && !force) return secureStatus();
  clearTimeout(retryTimer);
  try {
    await fetchCertificate();
  } catch (error) {
    status = { ...status, lastError: error.message };
    // Probably no internet right now (fine during a show): try again later.
    retryTimer = setTimeout(() => renewIfDue().catch(() => {}), RETRY_MS);
    retryTimer.unref();
  }
  return secureStatus();
}

async function fetchCertificate() {
  const { name, fullName, token } = config();
  status = { ...status, busy: true, step: "Starting", lastError: "", lastTryAt: new Date().toISOString() };
  secureEvents.emit("status");
  try {
    // Checks the internet and the DuckDNS name/token first, with a clear message if either is off.
    status.step = "Checking DuckDNS";
    status.publishedIp = "";
    await publishAddress();
    await mkdir(DIR, { recursive: true });
    const accountKey = await readFile(ACCOUNT_FILE).catch(async () => {
      const key = await acme.crypto.createPrivateKey();
      await writeFile(ACCOUNT_FILE, key, { mode: 0o600 });
      return key;
    });
    const client = new acme.Client({ directoryUrl: DIRECTORY, accountKey });
    const [key, csr] = await acme.crypto.createCsr({ commonName: fullName });
    const cert = await orderCertificate(client, csr, name, fullName, token);
    const info = acme.crypto.readCertificateInfo(cert);
    credentials = {
      cert: String(cert),
      key: String(key),
      name: fullName,
      issuedAt: new Date(info.notBefore).toISOString(),
      expiresAt: new Date(info.notAfter).toISOString()
    };
    await writeFile(CERT_FILE, credentials.cert, "utf8");
    await writeFile(KEY_FILE, credentials.key, { encoding: "utf8", mode: 0o600 });
    await writeFile(META_FILE, JSON.stringify({ name: fullName, issuedAt: credentials.issuedAt, expiresAt: credentials.expiresAt }), "utf8");
    status = { ...status, lastError: "" };
    secureEvents.emit("certificate");
  } finally {
    status = { ...status, busy: false, step: "" };
    secureEvents.emit("status");
  }
}

async function orderCertificate(client, csr, name, fullName, token) {
  try {
    return await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ["dns-01"],
      skipChallengeVerification: true,
      challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
        status.step = "Proving the name is yours (DuckDNS)";
        await duckdns(name, token, { txt: keyAuthorization });
        status.step = "Waiting for DuckDNS to publish it";
        await waitForTxt(fullName, keyAuthorization);
        status.step = "Let's Encrypt is checking";
      },
      challengeRemoveFn: async () => {
        await duckdns(name, token, { txt: "removed", clear: "true" }).catch(() => {});
      }
    });
  } catch (error) {
    const message = String(error.message || error);
    if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|directory|socket|network/i.test(message)) {
      throw new Error("Couldn't reach Let's Encrypt. This needs an internet connection (only while getting or renewing the certificate).");
    }
    throw new Error(`Let's Encrypt said no: ${message}`);
  }
}

// Point the name at this computer's show-network address (for devices using internet DNS).
async function publishAddress() {
  const { enabled, name, token } = config();
  const [ip, ipv6] = await Promise.all([primaryAddress(), primaryIPv6()]);
  status.address = ip;
  status.ipv6 = ipv6;
  setDnsIpv6(ipv6);
  if (!enabled || !name || !token || !ip) return;
  if (ip === status.publishedIp && ipv6 === status.publishedIpv6) return;
  // An IPv6 address that's gone has to be cleared (DuckDNS keeps it otherwise).
  if (status.publishedIpv6 && !ipv6) await duckdns(name, token, { clear: "true" });
  await duckdns(name, token, ipv6 ? { ip, ipv6 } : { ip });
  status.publishedIp = ip;
  status.publishedIpv6 = ipv6;
}

async function duckdns(name, token, params) {
  const url = new URL("https://www.duckdns.org/update");
  url.search = new URLSearchParams({ domains: name, token, verbose: "true", ...params }).toString();
  let text;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    text = await response.text();
  } catch {
    throw new Error("Couldn't reach DuckDNS. This needs an internet connection (only while getting or renewing the certificate).");
  }
  if (!text.startsWith("OK")) throw new Error("DuckDNS said no: check the name is yours and the token is right (duckdns.org, top of the page).");
}

// Ask DuckDNS's own name servers until the record shows up, so Let's Encrypt sees it first time.
async function waitForTxt(fullName, value) {
  const servers = [];
  for (const ns of await dnsPromises.resolveNs("duckdns.org").catch(() => [])) {
    servers.push(...(await dnsPromises.resolve4(ns).catch(() => [])));
  }
  const resolver = new Resolver();
  if (servers.length) resolver.setServers(servers.slice(0, 4));
  const lookup = () => new Promise((resolve) => resolver.resolveTxt(`_acme-challenge.${fullName}`, (error, records) => resolve(error ? [] : records.flat())));
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if ((await lookup()).includes(value)) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

async function readSaved() {
  try {
    const meta = JSON.parse(await readFile(META_FILE, "utf8"));
    return { ...meta, cert: await readFile(CERT_FILE, "utf8"), key: await readFile(KEY_FILE, "utf8") };
  } catch {
    return null;
  }
}
