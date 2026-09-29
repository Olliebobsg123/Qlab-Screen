// Fast comms: voices sent as raw 5 ms audio packets with a tiny playout buffer we control (see
// fast-audio-worklet.js), instead of WebRTC's own audio path, which buffers far more.
// Two ways to carry the packets:
//   - Browsers (Chromebooks, phones, any Chrome): a WebRTC data channel set to never resend
//     (unordered, no retransmits), which behaves like direct UDP between the two devices.
//   - The QLab Connect desktop app: real UDP (window.qlabNative), app to app.
// Browser packets are 24 kHz (half the data, plenty for speech); app packets are 48 kHz.
//
// Packet: "QC" | version (1 = 48 kHz, 2 = 24 kHz) | kind (0 audio, 1 ping, 2 pong) |
// sender id (uint32) | seq (uint16) | sample count (uint16) | 16-bit samples or a float64 time.

// Shown in the comms panel, so you can tell whether a device has the latest comms code.
export const COMMS_BUILD = 9;

const HEADER = 12;
const KIND_AUDIO = 0;
const KIND_PING = 1;
const KIND_PONG = 2;
const PING_MS = 1000;

export function nativeAvailable() {
  return Boolean(globalThis.qlabNative?.openAudioSocket);
}

export function fastSupported() {
  return typeof AudioWorkletNode !== "undefined";
}

export class FastAudio {
  constructor({ context, micStream, myId }) {
    this.native = nativeAvailable() ? globalThis.qlabNative : null;
    this.context = context;
    this.micStream = micStream;
    this.myId = myId;
    this.targets = [];
    this.everyone = [];
    this.seq = 0;
    this.rtt = new Map(); // target key -> ms
    this.stats = { bufferMs: 0, targetMs: 0, gaps: 0 };
  }

  // Returns the app's UDP port, or null in a browser.
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
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
    if (!this.native) return null;
    const port = await this.native.openAudioSocket();
    this.native.onPacket((buffer, ip, target) => this.receive(buffer, this.udpTarget({ ip, port: target })));
    return port;
  }

  stop() {
    clearInterval(this.pingTimer);
    this.capture?.disconnect();
    this.mixer?.disconnect();
    this.native?.closeAudioSocket?.();
  }

  setId(id) {
    this.myId = id;
  }

  // A place to send packets: { key, wide (48 kHz?), send(packet) }.
  udpTarget({ ip, port }) {
    return { key: `udp:${ip}:${port}`, wide: true, send: (packet) => this.native?.send(packet, ip, port) };
  }

  channelTarget(peerId, channel) {
    return {
      key: `dc:${peerId}`,
      wide: false,
      send: (packet) => {
        // Skip rather than queue if the channel is badly backed up (a Wi-Fi stall): past that,
        // late audio is worse than a gap, and the receiver covers a gap smoothly. Short stalls
        // are let through; the receiver catches up on them without skipping.
        if (channel.readyState === "open" && channel.bufferedAmount < 8192) channel.send(packet);
        else this.skipped = (this.skipped || 0) + 1;
      }
    };
  }

  // Who hears me right now, and everyone reachable this way (for delay checks).
  setTargets(targets, everyone) {
    this.targets = targets;
    this.everyone = everyone;
  }

  setVolume(senderId, value) {
    this.mixer?.port.postMessage({ type: "volume", id: senderId, value });
  }

  // frames: { wide: 48 kHz, narrow: filtered 24 kHz } from the capture worklet.
  sendFrame(frames) {
    // Every captured frame gets the next number, whether or not anyone hears it, so receivers
    // can spot a missing frame.
    this.seq = (this.seq + 1) & 0xffff;
    if (!this.targets.length) return;
    let wide = null;
    let narrow = null;
    for (const target of this.targets) {
      if (target.wide) target.send(wide ??= this.packAudio(frames.wide, 1));
      else target.send(narrow ??= this.packAudio(frames.narrow, 2));
    }
  }

  packAudio(frame, version) {
    const packet = new ArrayBuffer(HEADER + frame.length * 2);
    const view = new DataView(packet);
    this.writeHeader(view, version, KIND_AUDIO, frame.length, this.seq);
    const samples = new Int16Array(packet, HEADER);
    for (let index = 0; index < frame.length; index += 1) {
      const value = Math.max(-1, Math.min(1, frame[index]));
      samples[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return packet;
  }

  writeHeader(view, version, kind, count, seq = 0) {
    view.setUint8(0, 0x51);
    view.setUint8(1, 0x43);
    view.setUint8(2, version);
    view.setUint8(3, kind);
    view.setUint32(4, idNumber(this.myId), true);
    view.setUint16(8, seq, true);
    view.setUint16(10, count, true);
  }

  // A packet from a data channel or UDP. `from` is where to answer pings.
  receive(buffer, from) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER) return;
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 0x51 || view.getUint8(1) !== 0x43) return;
    const version = view.getUint8(2);
    const kind = view.getUint8(3);
    const sender = `p${view.getUint32(4, true)}`;
    if (kind === KIND_AUDIO) {
      const count = Math.min(view.getUint16(10, true), (buffer.byteLength - HEADER) / 2);
      const pcm = new Int16Array(buffer, HEADER, count);
      // 24 kHz frames are brought back to 48 kHz (filtered) in the mixer.
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) samples[index] = pcm[index] / 0x8000;
      const seq = view.getUint16(8, true);
      this.mixer?.port.postMessage({ type: "frame", id: sender, seq, samples, narrow: version === 2 }, [samples.buffer]);
    } else if (kind === KIND_PING && buffer.byteLength >= HEADER + 8) {
      const reply = buffer.slice(0);
      const replyView = new DataView(reply);
      replyView.setUint8(3, KIND_PONG);
      replyView.setUint32(4, idNumber(this.myId), true);
      from.send(reply);
    } else if (kind === KIND_PONG && buffer.byteLength >= HEADER + 8) {
      // Keep the last few round trips; the readout uses the middle one, so one slow Wi-Fi moment
      // doesn't make the number jump.
      const recent = [...(this.rtt.get(from.key) || []), performance.now() - view.getFloat64(HEADER, true)].slice(-5);
      this.rtt.set(from.key, recent);
    }
  }

  ping() {
    for (const target of this.everyone) {
      const packet = new ArrayBuffer(HEADER + 8);
      const view = new DataView(packet);
      this.writeHeader(view, 1, KIND_PING, 0);
      view.setFloat64(HEADER, performance.now(), true);
      target.send(packet);
    }
    const alive = new Set(this.everyone.map((target) => target.key));
    for (const key of this.rtt.keys()) if (!alive.has(key)) this.rtt.delete(key);
  }

  // Delay parts for the comms panel.
  latencyParts() {
    if (!this.rtt.size) return null;
    const medians = [...this.rtt.values()].map((list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]);
    const network = medians.reduce((a, b) => a + b, 0) / medians.length / 2;
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
