import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";

// IPv4 addresses other devices on the LAN can use to reach this server.
export function lanAddresses() {
  const addresses = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      addresses.push({ interface: name, address: entry.address });
    }
  }
  return addresses;
}

// The address this computer actually uses on its main network (the one its internet goes through),
// rather than whichever interface happens to be listed first (VPNs, a second adapter…).
// No packets are sent: "connecting" a UDP socket just asks the system which route it would use.
export function primaryAddress() {
  const fallback = lanAddresses()[0]?.address || "";
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let finished = false;
    const done = (address) => {
      if (finished) return;
      finished = true;
      socket.close();
      resolve(address && lanAddresses().some((entry) => entry.address === address) ? address : fallback);
    };
    socket.on("error", () => done(""));
    try {
      socket.connect(53, "1.1.1.1", () => done(socket.address().address));
    } catch {
      done("");
    }
  });
}

// This computer's public-style (global) IPv6 address, if the network has IPv6. Routers don't block
// names pointing at these the way they block names pointing at 192.168.x.x addresses, and
// devices on the same network reach it directly. Prefers the stable address over the
// temporary "privacy" ones macOS rotates.
export function primaryIPv6() {
  const isGlobal = (address) => /^[23][0-9a-f]{0,3}:/i.test(address);
  const fromNode = () => {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv6" && !entry.internal && isGlobal(entry.address)) return entry.address;
      }
    }
    return "";
  };
  if (process.platform !== "darwin") return Promise.resolve(fromNode());
  return new Promise((resolve) => {
    execFile("ifconfig", { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(fromNode());
      const lines = String(stdout).split("\n").filter((line) => /^\s*inet6\s/.test(line));
      const globals = lines
        .map((line) => ({ address: line.trim().split(/\s+/)[1] || "", temporary: /temporary|deprecated|detached/.test(line), secured: /secured/.test(line) }))
        .filter((entry) => isGlobal(entry.address) && !entry.address.includes("%"));
      const pick = globals.find((entry) => entry.secured && !entry.temporary) || globals.find((entry) => !entry.temporary) || globals[0];
      resolve(pick?.address || "");
    });
  });
}

// This computer's address on the same network as `clientIp` (a Mac on Ethernet and Wi-Fi has two).
export function addressFor(clientIp) {
  const toNumber = (ip) => ip.split(".").reduce((total, part) => total * 256 + Number(part), 0);
  const client = /^\d+\.\d+\.\d+\.\d+$/.test(clientIp || "") ? toNumber(clientIp) : null;
  let fallback = "";
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      fallback ||= entry.address;
      const mask = toNumber(entry.netmask);
      if (client !== null && Math.floor(toNumber(entry.address) / (2 ** 32 - mask)) === Math.floor(client / (2 ** 32 - mask))) {
        return entry.address;
      }
    }
  }
  return fallback;
}

export function networkUrls({ httpPort, httpsPort }) {
  return lanAddresses().map(({ interface: name, address }) => ({
    interface: name,
    address,
    http: `http://${address}:${httpPort}`,
    https: httpsPort ? `https://${address}:${httpsPort}` : ""
  }));
}

export function qrSvg(text) {
  return QRCode.toString(String(text).slice(0, 500), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}
