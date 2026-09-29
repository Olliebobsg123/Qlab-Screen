// Gives QLab Connect's own pages (loaded from the show server) the one thing browsers can't do:
// send and receive UDP on the local network, for fast comms (see public/fast-audio.js).
const { contextBridge } = require("electron");
const dgram = require("node:dgram");

let socket = null;
let listener = null;

contextBridge.exposeInMainWorld("qlabNative", {
  app: true,
  async openAudioSocket() {
    if (socket) return socket.address().port;
    socket = dgram.createSocket("udp4");
    socket.on("message", (message, remote) => {
      if (!listener) return;
      const buffer = message.buffer.slice(message.byteOffset, message.byteOffset + message.length);
      listener(buffer, remote.address, remote.port);
    });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.bind(0, resolve));
    return socket.address().port;
  },
  send(buffer, ip, port) {
    if (!socket) return;
    socket.send(Buffer.from(buffer), port, ip);
  },
  onPacket(callback) {
    listener = callback;
  },
  closeAudioSocket() {
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
    socket = null;
    listener = null;
  }
});
