// Audio-thread half of fast comms (see fast-audio.js).
// "qc-capture": cuts the microphone into 5 ms frames for sending.
// "qc-mixer": plays everyone's incoming frames with a tiny per-person buffer that grows only if
// the network hiccups, and is trimmed back if it ever gets too long, so delay can't pile up.

const FRAME = 240; // 5 ms at 48 kHz
const MIN_TARGET = 2; // frames kept ready before playing: 10 ms
const MAX_TARGET = 8; // 40 ms at worst
const RELAX_MS = 5000; // shrink the buffer again after this long without a gap

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length) {
      const count = Math.min(FRAME - this.filled, input.length - offset);
      this.frame.set(input.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === FRAME) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME);
        this.filled = 0;
      }
    }
    return true;
  }
}

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = new Map(); // sender id -> voice
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.reportAt = 0;
  }

  voice(id) {
    let voice = this.voices.get(id);
    if (!voice) {
      voice = { frames: [], offset: 0, playing: false, target: MIN_TARGET, volume: 1, lastGap: currentTime, lastHeard: currentTime, gaps: 0 };
      this.voices.set(id, voice);
    }
    return voice;
  }

  onMessage(message) {
    if (message.type === "frame") {
      const voice = this.voice(message.id);
      voice.frames.push(message.samples);
      voice.lastHeard = currentTime;
      // Never let delay build up: if we're holding more than the worst case, drop the oldest.
      const limit = voice.target + 3;
      if (voice.frames.length > limit) {
        voice.frames.splice(0, voice.frames.length - voice.target);
        voice.offset = 0;
      }
    } else if (message.type === "volume") {
      this.voice(message.id).volume = message.value;
    } else if (message.type === "forget") {
      this.voices.delete(message.id);
    }
  }

  process(inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    for (const [id, voice] of this.voices) {
      if (!voice.playing) {
        if (voice.frames.length >= voice.target) voice.playing = true;
        else continue;
      }
      let written = 0;
      while (written < output.length) {
        const frame = voice.frames[0];
        if (!frame) {
          // Ran dry: the network was late. Wait for a slightly bigger cushion next time.
          voice.playing = false;
          voice.target = Math.min(MAX_TARGET, voice.target + 1);
          voice.lastGap = currentTime;
          voice.gaps += 1;
          break;
        }
        const count = Math.min(frame.length - voice.offset, output.length - written);
        for (let index = 0; index < count; index += 1) {
          output[written + index] += frame[voice.offset + index] * voice.volume;
        }
        written += count;
        voice.offset += count;
        if (voice.offset >= frame.length) {
          voice.frames.shift();
          voice.offset = 0;
        }
      }
      if (voice.target > MIN_TARGET && currentTime - voice.lastGap > RELAX_MS / 1000) {
        voice.target -= 1;
        voice.lastGap = currentTime;
      }
      if (currentTime - voice.lastHeard > 30) this.voices.delete(id);
    }
    // Copy to the other output channels (stereo headphones).
    for (let channel = 1; channel < outputs[0].length; channel += 1) outputs[0][channel].set(output);

    if (currentTime - this.reportAt > 1) {
      this.reportAt = currentTime;
      const buffered = [...this.voices.values()].map((voice) => (voice.frames.length * FRAME - voice.offset) / sampleRate * 1000);
      this.port.postMessage({
        type: "stats",
        bufferMs: buffered.length ? Math.max(...buffered) : 0,
        targetMs: Math.max(0, ...[...this.voices.values()].map((voice) => voice.target * FRAME / sampleRate * 1000)),
        gaps: [...this.voices.values()].reduce((total, voice) => total + voice.gaps, 0)
      });
    }
    return true;
  }
}

registerProcessor("qc-capture", CaptureProcessor);
registerProcessor("qc-mixer", MixerProcessor);
