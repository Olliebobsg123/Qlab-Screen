import { HTTP_PORT, HTTPS_PORT } from "./src/config.js";
import { createHttpServer, createHttpsServer, startHeartbeat } from "./src/http-server.js";
import { networkUrls } from "./src/network.js";
import { keepConnected } from "./src/qlab.js";
import { getSettings } from "./src/settings.js";
import { attachMidiSocket, initMidiOutput } from "./src/midi-out.js";
import { attachCommsSocket } from "./src/comms.js";
import { startDiscovery } from "./src/discovery.js";
import { startRtpMidi } from "./src/rtp-midi.js";
import { loadTlsCredentials } from "./src/tls.js";
import { secureEvents, setSecurePort, startSecureAddress } from "./src/secure-address.js";

export function startServer() {
  const server = createHttpServer();
  attachMidiSocket(server);
  attachCommsSocket(server);
  initMidiOutput();
  startRtpMidi();
  startDiscovery();

  server.listen(HTTP_PORT, () => {
    console.log(`QLab Screen is running at http://localhost:${HTTP_PORT}`);
    startHeartbeat();
    startHttpsServer().then(startStandardPorts).finally(printNetworkUrls);

    const settings = getSettings();
    if (settings.autoConnect && settings.host) {
      // Keeps retrying if QLab isn't open yet.
      keepConnected(settings);
    }
  });

  return server;
}

// HTTPS lets other devices use Web MIDI and audio input, which browsers only allow on secure pages.
async function startHttpsServer() {
  if (!HTTPS_PORT) return;
  try {
    const credentials = await loadTlsCredentials();
    const httpsServer = createHttpsServer(credentials);
    attachMidiSocket(httpsServer);
    attachCommsSocket(httpsServer);
    await new Promise((resolve, reject) => {
      httpsServer.once("error", reject);
      httpsServer.listen(HTTPS_PORT, resolve);
    });
    console.log(`HTTPS (for MIDI + audio meters) at https://localhost:${HTTPS_PORT}${credentials.selfSigned ? " (self-signed certificate)" : ""}`);
    setSecurePort(HTTPS_PORT);
    await startSecureAddress();
    return credentials;
  } catch (error) {
    console.warn(`HTTPS server not started: ${error.message}`);
    return null;
  }
}

// The secure address reads best with no port: https://qlab-connect.duckdns.org. That needs the
// standard ports (443, plus 80 to send plain http there), which macOS and Windows allow; if
// they're taken, the address keeps its :port.
let standardPortsStarted = false;
function startStandardPorts(credentials) {
  if (!credentials || standardPortsStarted || HTTPS_PORT === 443) return;
  standardPortsStarted = true;
  const tryListen = (server, port) => new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, () => resolve(true));
  });
  const httpsServer = createHttpsServer(credentials);
  attachMidiSocket(httpsServer);
  attachCommsSocket(httpsServer);
  tryListen(httpsServer, 443).then((ok) => {
    if (!ok) return;
    setSecurePort(443);
    const redirect = createHttpServer();
    attachCommsSocket(redirect);
    if (HTTP_PORT !== 80) tryListen(redirect, 80);
    secureEvents.emit("status");
  });
}

function printNetworkUrls() {
  const urls = networkUrls({ httpPort: HTTP_PORT, httpsPort: HTTPS_PORT });
  if (!urls.length) return;
  console.log("Open from other devices on this network:");
  for (const url of urls) {
    console.log(`  ${url.http}${url.https ? `   (MIDI/control: ${url.https}/midi.html)` : ""}`);
  }
}

if (process.env.QLAB_ELECTRON !== "1") {
  startServer();
}
