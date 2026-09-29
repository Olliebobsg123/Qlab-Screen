// The launcher (choose "run the show here" or "join a show"): find servers on the network.
const { contextBridge, ipcRenderer } = require("electron");
const dgram = require("node:dgram");

const DISCOVERY_PORT = 3031;

contextBridge.exposeInMainWorld("launcher", {
  discover(waitMs = 1500) {
    return new Promise((resolve) => {
      const found = new Map();
      const socket = dgram.createSocket("udp4");
      socket.on("message", (message, remote) => {
        try {
          const answer = JSON.parse(message.toString("utf8"));
          if (answer.app !== "qlab-connect") return;
          // One entry per server, preferring its network address over this computer's own (127.0.0.1).
          const key = `${answer.name}:${answer.httpPort}`;
          const existing = found.get(key);
          if (!existing || existing.ip === "127.0.0.1") found.set(key, { ...answer, ip: remote.address });
        } catch {
          // Not ours.
        }
      });
      socket.on("error", () => resolve([]));
      socket.bind(0, () => {
        socket.setBroadcast(true);
        const question = Buffer.from("QLAB_CONNECT_DISCOVER");
        socket.send(question, DISCOVERY_PORT, "255.255.255.255");
        socket.send(question, DISCOVERY_PORT, "127.0.0.1");
      });
      setTimeout(() => {
        socket.close();
        resolve([...found.values()]);
      }, waitMs);
    });
  },
  choose(choice) {
    return ipcRenderer.invoke("launcher:choose", choice);
  },
  current() {
    return ipcRenderer.invoke("launcher:current");
  }
});
