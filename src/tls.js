import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import selfsigned from "selfsigned";
import { SETTINGS_DIR, TLS_CERT_PATH, TLS_KEY_PATH } from "./config.js";
import { lanAddresses } from "./network.js";

const TLS_DIR = join(SETTINGS_DIR, "tls");
const CERT_FILE = join(TLS_DIR, "cert.pem");
const KEY_FILE = join(TLS_DIR, "key.pem");
const META_FILE = join(TLS_DIR, "meta.json");

// Uses TLS_CERT_PATH/TLS_KEY_PATH when set, otherwise a self-signed certificate that covers
// localhost and this machine's LAN addresses. It is regenerated when those addresses change.
export async function loadTlsCredentials() {
  if (TLS_CERT_PATH && TLS_KEY_PATH) {
    return {
      cert: await readFile(TLS_CERT_PATH),
      key: await readFile(TLS_KEY_PATH),
      selfSigned: false
    };
  }

  const names = ["localhost", hostname(), `${hostname().replace(/\.local$/, "")}.local`];
  const ips = ["127.0.0.1", ...lanAddresses().map((entry) => entry.address)];
  const existing = await readExisting();
  if (existing && ips.every((ip) => existing.meta.ips.includes(ip)) && Date.parse(existing.meta.expiresAt) > Date.now() + 86400000) {
    return { cert: existing.cert, key: existing.key, selfSigned: true };
  }

  const notAfterDate = new Date(Date.now() + 825 * 86400000);
  const pems = await selfsigned.generate([{ name: "commonName", value: "QLab Connect" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          ...Array.from(new Set(names)).map((value) => ({ type: 2, value })),
          ...ips.map((ip) => ({ type: 7, ip }))
        ]
      }
    ]
  });

  await mkdir(TLS_DIR, { recursive: true });
  await writeFile(CERT_FILE, pems.cert, "utf8");
  await writeFile(KEY_FILE, pems.private, { encoding: "utf8", mode: 0o600 });
  await writeFile(META_FILE, JSON.stringify({ ips, expiresAt: notAfterDate.toISOString() }), "utf8");
  return { cert: pems.cert, key: pems.private, selfSigned: true };
}

async function readExisting() {
  try {
    return {
      cert: await readFile(CERT_FILE, "utf8"),
      key: await readFile(KEY_FILE, "utf8"),
      meta: JSON.parse(await readFile(META_FILE, "utf8"))
    };
  } catch {
    return null;
  }
}
