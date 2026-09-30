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
