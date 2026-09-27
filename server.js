import { HTTP_PORT, HTTPS_PORT } from "./src/config.js";
import { createHttpServer, createHttpsServer, startHeartbeat } from "./src/http-server.js";
import { networkUrls } from "./src/network.js";
import { connectToQlab } from "./src/qlab.js";
import { getSettings } from "./src/settings.js";
import { state } from "./src/state.js";
import { broadcastSnapshot } from "./src/events.js";
import { attachMidiSocket, initMidiOutput } from "./src/midi-out.js";
import { startRtpMidi } from "./src/rtp-midi.js";
import { loadTlsCredentials } from "./src/tls.js";

export function startServer() {
  const server = createHttpServer();
  attachMidiSocket(server);
  initMidiOutput();
  startRtpMidi();

  server.listen(HTTP_PORT, () => {
    console.log(`QLab Screen is running at http://localhost:${HTTP_PORT}`);
    startHeartbeat();
    startHttpsServer().finally(printNetworkUrls);

    const settings = getSettings();
    if (settings.autoConnect && settings.host) {
      connectToQlab(settings).catch((error) => {
        state.lastError = error.message;
        broadcastSnapshot();
      });
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
    await new Promise((resolve, reject) => {
      httpsServer.once("error", reject);
      httpsServer.listen(HTTPS_PORT, resolve);
    });
    console.log(`HTTPS (for MIDI + audio meters) at https://localhost:${HTTPS_PORT}${credentials.selfSigned ? " (self-signed certificate)" : ""}`);
  } catch (error) {
    console.warn(`HTTPS server not started: ${error.message}`);
  }
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
