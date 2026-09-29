import dgram from "node:dgram";
import { hostname } from "node:os";
import { HTTP_PORT, HTTPS_PORT } from "./config.js";
import { state } from "./state.js";

// Lets the desktop app find this server on the network: it broadcasts "QLAB_CONNECT_DISCOVER" to
// this port and every server answers with its name and web ports.
export const DISCOVERY_PORT = 3031;
const QUESTION = "QLAB_CONNECT_DISCOVER";

export function startDiscovery() {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (message, remote) => {
    if (message.toString("utf8").trim() !== QUESTION) return;
    const answer = JSON.stringify({
      app: "qlab-connect",
      name: hostname().replace(/\.local$/, ""),
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      workspace: state.workspaceName || ""
    });
    socket.send(answer, remote.port, remote.address);
  });
  socket.on("error", (error) => console.warn(`Discovery not available: ${error.message}`));
  socket.bind(DISCOVERY_PORT);
  return socket;
}
