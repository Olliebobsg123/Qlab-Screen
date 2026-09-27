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
