// Fast comms for the desktop app: voices go straight between apps on the local network as raw
// 5 ms audio packets over UDP (no codec, no browser buffering), played through a tiny buffer we
// control. Typically 25-50 ms mouth to ear, versus 100+ ms through a browser.
// Only used when the page runs inside the QLab Connect app (window.qlabNative); browsers and
// phones keep using WebRTC (comms.js), and app <-> phone calls go that way too.
//
// Packet: "QC" | version | kind (0 audio, 1 ping, 2 pong) | sender id (uint32) | seq (uint16) |
// sample count (uint16) | 16-bit samples (audio) or a float64 timestamp (ping/pong).

const HEADER = 12;
const KIND_AUDIO = 0;
const KIND_PING = 1;
const KIND_PONG = 2;
const PING_MS = 2000;

export function nativeAvailable() {
  return Boolean(globalThis.qlabNative?.openAudioSocket);
}

export class FastAudio {
  constructor({ context, micStream, myId }) {
    this.native = globalThis.qlabNative;
    this.context = context;
    this.micStream = micStream;
    this.myId = myId;
    this.targets = [];
    this.everyone = [];
    this.seq = 0;
    this.rtt = new Map(); // "ip:port" -> ms
    this.stats = { bufferMs: 0, targetMs: 0, gaps: 0 };
  }

  async start() {
    await this.context.audioWorklet.addModule("/fast-audio-worklet.js");
    this.mixer = new AudioWorkletNode(this.context, "qc-mixer", { numberOfInputs: 0, outputChannelCount: [2] });
    this.mixer.connect(this.context.destination);
    this.mixer.port.onmessage = (event) => {
      if (event.data.type === "stats") this.stats = event.data;
    };
    if (this.micStream) {
      this.capture = new AudioWorkletNode(this.context, "qc-capture", { numberOfOutputs: 0 });
      this.context.createMediaStreamSource(this.micStream).connect(this.capture);
      this.capture.port.onmessage = (event) => this.sendFrame(event.data);
    }
    this.port = await this.native.openAudioSocket();
    this.native.onPacket((buffer, ip, port) => this.onPacket(buffer, ip, port));
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    return this.port;
  }

  stop() {
    clearInterval(this.pingTimer);
    this.capture?.disconnect();
    this.mixer?.disconnect();
    this.native.closeAudioSocket?.();
  }

  setId(id) {
    this.myId = id;
  }

  // Who hears me right now ([{ ip, port }]), and every app on comms (for delay checks).
  setTargets(targets, everyone) {
    this.targets = targets;
    this.everyone = everyone;
  }

  setVolume(senderId, value) {
    this.mixer?.port.postMessage({ type: "volume", id: senderId, value });
  }

  sendFrame(frame) {
    if (!this.targets.length) return;
    const packet = new ArrayBuffer(HEADER + frame.length * 2);
    const view = new DataView(packet);
    this.writeHeader(view, KIND_AUDIO, frame.length);
    const samples = new Int16Array(packet, HEADER);
    for (let index = 0; index < frame.length; index += 1) {
      const value = Math.max(-1, Math.min(1, frame[index]));
      samples[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    for (const target of this.targets) this.native.send(packet, target.ip, target.port);
  }

  writeHeader(view, kind, count) {
    view.setUint8(0, 0x51);
    view.setUint8(1, 0x43);
    view.setUint8(2, 1);
    view.setUint8(3, kind);
    view.setUint32(4, idNumber(this.myId), true);
    view.setUint16(8, this.seq = (this.seq + 1) & 0xffff, true);
    view.setUint16(10, count, true);
  }

  onPacket(buffer, ip, port) {
    if (buffer.byteLength < HEADER) return;
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 0x51 || view.getUint8(1) !== 0x43) return;
    const kind = view.getUint8(3);
    const sender = `p${view.getUint32(4, true)}`;
    if (kind === KIND_AUDIO) {
      const count = Math.min(view.getUint16(10, true), (buffer.byteLength - HEADER) / 2);
      const pcm = new Int16Array(buffer, HEADER, count);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) samples[index] = pcm[index] / 0x8000;
      this.mixer?.port.postMessage({ type: "frame", id: sender, samples }, [samples.buffer]);
    } else if (kind === KIND_PING && buffer.byteLength >= HEADER + 8) {
      // Send the timestamp straight back.
      const reply = buffer.slice(0);
      new DataView(reply).setUint8(3, KIND_PONG);
      new DataView(reply).setUint32(4, idNumber(this.myId), true);
      this.native.send(reply, ip, port);
    } else if (kind === KIND_PONG && buffer.byteLength >= HEADER + 8) {
      this.rtt.set(`${ip}:${port}`, performance.now() - view.getFloat64(HEADER, true));
    }
  }

  ping() {
    for (const target of this.everyone) {
      const packet = new ArrayBuffer(HEADER + 8);
      const view = new DataView(packet);
      this.writeHeader(view, KIND_PING, 0);
      view.setFloat64(HEADER, performance.now(), true);
      this.native.send(packet, target.ip, target.port);
    }
    const alive = new Set(this.everyone.map((target) => `${target.ip}:${target.port}`));
    for (const key of this.rtt.keys()) if (!alive.has(key)) this.rtt.delete(key);
  }

  // Delay parts for the comms panel.
  latencyParts() {
    if (!this.rtt.size) return null;
    const rtts = [...this.rtt.values()];
    const network = rtts.reduce((a, b) => a + b, 0) / rtts.length / 2;
    const output = ((this.context.baseLatency || 0) + (this.context.outputLatency || 0)) * 1000;
    const capture = (this.micStream?.getAudioTracks()[0]?.getSettings?.().latency || 0.005) * 1000;
    return {
      network: Math.round(network),
      buffer: Math.round(this.stats.targetMs || 10),
      device: Math.round(output + capture + 5)
    };
  }
}

function idNumber(id) {
  return Number(String(id).replace(/\D/g, "")) || 0;
}
