// Comms engine: talkback channels (and an optional show feed) between browsers on the network.
// Audio goes straight from device to device over WebRTC (Opus). The server (src/comms.js) only
// introduces devices to each other and shares who listens to which channel and who is talking.
// Every device connects to every other one; each decides for itself which voices to play, so a
// voice on a channel you don't listen to stays silent. Your mic only sends while you hold TALK.

const VOICE_FMTP = "useinbandfec=1;usedtx=1";
const FEED_FMTP = "stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1;usedtx=0";

export class CommsClient {
  // mode: "user" (mic, talk/listen) or "feed" (sends one input to listeners, receives nothing).
  // getTicket(): Promise<{ ticket, channels, feedName }>. onChange(): called when anything changes.
  constructor({ mode = "user", getTicket, onChange = () => {}, feedStream = null }) {
    this.mode = mode;
    this.getTicket = getTicket;
    this.onChange = onChange;
    this.feedStream = feedStream;
    this.id = "";
    this.peers = [];
    this.channels = [];
    this.feedName = "Show feed";
    this.listen = new Set();
    this.talking = new Set();
    this.latched = new Set();
    this.feedOn = false;
    this.volumes = { feed: 0.8 };
    this.conns = new Map();
    this.micStream = null;
    this.micTrack = null;
    this.audioContext = null;
    this.ws = null;
    this.running = false;
    this.status = "off";
    this.error = "";
    this.latencyMs = null;
    this.wakeLock = null;
    this.onVisibility = () => {
      if (document.visibilityState === "visible" && this.running) this.keepAwake();
    };
  }

  // Must be called from a tap/click: browsers only allow audio to start after one.
  async start() {
    if (this.running) return;
    this.running = true;
    this.error = "";
    this.setStatus("starting");
    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    await this.audioContext.resume().catch(() => {});
    if (this.mode === "user") {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        this.micTrack = this.micStream.getAudioTracks()[0];
        this.micTrack.enabled = false;
        this.watchMicLevel();
      } catch (error) {
        // Still useful: you can listen without a mic.
        this.error = `No microphone (${error.message}). You can listen, but not talk.`;
      }
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.keepAwake();
    this.statsTimer = setInterval(() => this.measureLatency(), 2000);
    await this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.statsTimer);
    cancelAnimationFrame(this.levelFrame);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ws?.close();
    this.ws = null;
    for (const id of [...this.conns.keys()]) this.dropConn(id);
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.micTrack = null;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
    this.talking.clear();
    this.latched.clear();
    this.peers = [];
    this.setStatus("off");
  }

  async connect() {
    if (!this.running) return;
    try {
      const info = await this.getTicket();
      if (!info?.ticket) throw new Error(info?.error || "Comms is switched off.");
      this.channels = info.channels || [];
      this.feedName = info.feedName || this.feedName;
      if (!this.listen.size && this.mode === "user" && this.channels[0]) this.listen.add(this.channels[0].id);
      for (const channel of this.channels) this.volumes[channel.id] ??= 0.9;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/comms?ticket=${encodeURIComponent(info.ticket)}`);
      this.ws = ws;
      ws.onmessage = (event) => this.onMessage(JSON.parse(event.data));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        for (const id of [...this.conns.keys()]) this.dropConn(id);
        this.peers = [];
        if (this.running) {
          this.setStatus("reconnecting");
          this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        }
      };
    } catch (error) {
      this.error = error.message;
      this.setStatus("reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(), 4000);
    }
  }

  onMessage(message) {
    if (message.type === "welcome") {
      this.id = message.id;
      this.channels = message.channels || this.channels;
      this.feedName = message.feedName || this.feedName;
      this.setStatus("on");
      this.sendState();
    } else if (message.type === "peers") {
      this.peers = message.peers.filter((peer) => peer.id !== this.id);
      this.syncConns();
      this.applyGains();
      this.onChange();
    } else if (message.type === "signal") {
      this.onSignal(message.from, message.data);
    } else if (message.type === "ping") {
      this.send({ type: "pong" });
    }
  }

  send(message) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  sendState() {
    this.send({ type: "state", listen: [...this.listen], talking: [...this.talking], feed: this.feedOn });
  }

  // --- Talk and listen ---

  setListen(channelId, on) {
    if (on) this.listen.add(channelId);
    else {
      this.listen.delete(channelId);
      this.stopTalking(channelId, true);
    }
    this.sendState();
    this.applyGains();
    this.onChange();
  }

  setFeed(on) {
    this.feedOn = on;
    this.sendState();
    this.applyGains();
    this.onChange();
  }

  setVolume(key, value) {
    this.volumes[key] = Math.max(0, Math.min(1, value));
    this.applyGains();
  }

  startTalking(channelId) {
    if (!this.micTrack) return;
    if (channelId !== "*") this.listen.add(channelId);
    this.talking.add(channelId);
    this.updateMic();
  }

  stopTalking(channelId, force = false) {
    if (this.latched.has(channelId) && !force) return;
    this.latched.delete(channelId);
    this.talking.delete(channelId);
    this.updateMic();
  }

  toggleLatch(channelId) {
    if (this.latched.has(channelId)) {
      this.stopTalking(channelId, true);
    } else {
      this.latched.add(channelId);
      this.startTalking(channelId);
    }
  }

  updateMic() {
    if (this.micTrack) this.micTrack.enabled = this.talking.size > 0;
    this.sendState();
    this.applyGains();
    this.onChange();
  }

  // Who is talking on this channel right now (for the lights next to each channel).
  talkersOn(channelId) {
    return this.peers.filter((peer) => peer.kind === "user" && (peer.talking.includes(channelId) || peer.talking.includes("*")));
  }

  feedSource() {
    return this.peers.find((peer) => peer.kind === "feed");
  }

  // --- Connections ---

  wants(peer) {
    if (this.mode === "feed") return peer.kind === "user";
    return true;
  }

  syncConns() {
    const present = new Set(this.peers.map((peer) => peer.id));
    for (const id of [...this.conns.keys()]) if (!present.has(id)) this.dropConn(id);
    for (const peer of this.peers) {
      if (!this.wants(peer) || this.conns.has(peer.id)) continue;
      // The device with the lower number makes the offer; the other answers.
      if (idNumber(this.id) < idNumber(peer.id)) this.createConn(peer.id, true);
    }
  }

  createConn(peerId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    const conn = { pc, pending: [], gain: null, element: null, feed: false };
    this.conns.set(peerId, conn);
    const peer = this.peers.find((entry) => entry.id === peerId);
    conn.feed = this.mode === "feed" || peer?.kind === "feed";

    // The device making the offer sets up the audio now; the answering one uses the slot the
    // offer creates (see setupAnswer), so both ends agree on one audio line.
    if (initiator) {
      if (this.mode === "feed") {
        const track = this.feedStream?.getAudioTracks()[0];
        if (track) pc.addTransceiver(track, { direction: "sendonly", streams: [this.feedStream] });
      } else if (peer?.kind === "feed" || !this.micTrack) {
        pc.addTransceiver("audio", { direction: "recvonly" });
      } else {
        pc.addTransceiver(this.micTrack, { direction: "sendrecv", streams: [this.micStream] });
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ type: "signal", to: peerId, data: { candidate: event.candidate } });
    };
    pc.ontrack = (event) => this.playRemote(peerId, conn, event);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.dropConn(peerId);
        this.syncConns();
      }
      this.onChange();
    };
    if (initiator) this.makeOffer(peerId, conn);
    return conn;
  }

  async makeOffer(peerId, conn) {
    const offer = await conn.pc.createOffer();
    offer.sdp = tuneOpus(offer.sdp, conn.feed);
    await conn.pc.setLocalDescription(offer);
    this.send({ type: "signal", to: peerId, data: { description: conn.pc.localDescription } });
  }

  async onSignal(from, data) {
    let conn = this.conns.get(from);
    if (!conn) {
      if (!data.description || data.description.type !== "offer") return;
      conn = this.createConn(from, false);
    }
    const { pc } = conn;
    try {
      if (data.description) {
        const description = { type: data.description.type, sdp: tuneOpus(data.description.sdp, conn.feed) };
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await this.setupAnswer(from, pc);
          const answer = await pc.createAnswer();
          answer.sdp = tuneOpus(answer.sdp, conn.feed);
          await pc.setLocalDescription(answer);
          this.send({ type: "signal", to: from, data: { description: pc.localDescription } });
        }
        for (const candidate of conn.pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else conn.pending.push(data.candidate);
      }
    } catch (error) {
      console.warn("Comms connection problem:", error.message);
    }
  }

  async setupAnswer(peerId, pc) {
    const transceiver = pc.getTransceivers()[0];
    if (!transceiver) return;
    const peer = this.peers.find((entry) => entry.id === peerId);
    if (this.mode === "feed") {
      const track = this.feedStream?.getAudioTracks()[0];
      transceiver.direction = "sendonly";
      if (track) {
        await transceiver.sender.replaceTrack(track);
        transceiver.sender.setStreams?.(this.feedStream);
      }
    } else if (peer?.kind === "feed" || !this.micTrack) {
      transceiver.direction = "recvonly";
    } else {
      transceiver.direction = "sendrecv";
      await transceiver.sender.replaceTrack(this.micTrack);
      transceiver.sender.setStreams?.(this.micStream);
    }
  }

  playRemote(peerId, conn, event) {
    // Ask for the smallest safe buffer: lowest delay on a good network.
    if ("jitterBufferTarget" in event.receiver) event.receiver.jitterBufferTarget = 0;
    else if ("playoutDelayHint" in event.receiver) event.receiver.playoutDelayHint = 0;
    const stream = event.streams[0] || new MediaStream([event.track]);
    // Chrome only plays WebRTC audio through Web Audio if an audio element is also attached.
    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    element.play().catch(() => {});
    conn.element = element;
    try {
      const source = this.audioContext.createMediaStreamSource(stream);
      const gain = this.audioContext.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.audioContext.destination);
      conn.gain = gain;
    } catch {
      // No Web Audio for this stream: fall back to the element, switched on and off.
      conn.gain = null;
    }
    this.applyGains();
  }

  dropConn(peerId) {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    this.conns.delete(peerId);
    conn.gain?.disconnect();
    if (conn.element) conn.element.srcObject = null;
    conn.pc.close();
  }

  // How loud each device should be right now: a voice only if it's talking on a channel you listen
  // to; the show feed only if you've turned it on.
  levelFor(peer) {
    if (this.mode === "feed" || !peer) return 0;
    if (peer.kind === "feed") return this.feedOn ? this.volumes.feed : 0;
    const channels = peer.talking.includes("*") ? [...this.listen] : peer.talking.filter((id) => this.listen.has(id));
    return channels.length ? Math.max(...channels.map((id) => this.volumes[id] ?? 0.9)) : 0;
  }

  applyGains() {
    const now = this.audioContext?.currentTime || 0;
    for (const [peerId, conn] of this.conns) {
      const level = this.levelFor(this.peers.find((peer) => peer.id === peerId));
      if (conn.gain) conn.gain.gain.setTargetAtTime(level, now, 0.01);
      else if (conn.element) {
        conn.element.muted = level === 0;
        try { conn.element.volume = level || 1; } catch { /* iOS: fixed volume */ }
      }
    }
  }

  // --- Extras ---

  watchMicLevel() {
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 512;
    this.audioContext.createMediaStreamSource(this.micStream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value));
      this.micLevel = peak;
      this.levelFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  // Rough mouth-to-ear delay from the live connection stats: half the round trip, the receive
  // buffer, plus about 40 ms for recording, encoding and playing a 20 ms Opus frame.
  async measureLatency() {
    const samples = [];
    for (const conn of this.conns.values()) {
      if (conn.pc.connectionState !== "connected") continue;
      const stats = await conn.pc.getStats().catch(() => null);
      if (!stats) continue;
      let rtt = null;
      let buffer = null;
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.nominated && report.currentRoundTripTime != null) rtt = report.currentRoundTripTime * 1000;
        if (report.type === "inbound-rtp" && report.kind === "audio" && report.jitterBufferEmittedCount) {
          buffer = (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
        }
      });
      if (rtt != null) samples.push(rtt / 2 + (buffer ?? 20) + 40);
    }
    this.latencyMs = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null;
    this.onChange();
  }

  async keepAwake() {
    try {
      this.wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
      // Not supported: the page tells people to keep the screen on.
    }
  }

  connectedCount() {
    return [...this.conns.values()].filter((conn) => conn.pc.connectionState === "connected").length;
  }

  setStatus(status) {
    this.status = status;
    this.onChange();
  }
}

// Opus settings: voices in mono with packet-loss recovery; the show feed in stereo, higher quality.
function tuneOpus(sdp, feed) {
  const match = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!match) return sdp;
  const payload = match[1];
  const extra = feed ? FEED_FMTP : VOICE_FMTP;
  const fmtpLine = new RegExp(`a=fmtp:${payload} ([^\\r\\n]*)`);
  if (fmtpLine.test(sdp)) {
    return sdp.replace(fmtpLine, (line, params) => {
      const merged = new Map(params.split(";").filter(Boolean).map((part) => part.split("=")));
      for (const part of extra.split(";")) {
        const [key, value] = part.split("=");
        merged.set(key, value);
      }
      return `a=fmtp:${payload} ${[...merged].map(([key, value]) => `${key}=${value}`).join(";")}`;
    });
  }
  return sdp.replace(match[0], `${match[0]}\r\na=fmtp:${payload} ${extra}`);
}

function idNumber(id) {
  return Number(String(id).replace(/\D/g, "")) || 0;
}
