// Audio-thread half of fast comms (see fast-audio.js).
//
// "qc-capture": cuts the microphone into 5 ms frames (48 kHz), and also a filtered 24 kHz copy for
// browsers (half the data).
// "qc-mixer": plays everyone's incoming frames through a small jitter buffer, like a hardware
// intercom:
//   - its size follows how uneven packet arrival actually is (measured), changing gradually;
//   - a late packet is covered by fading out the last sound instead of a hard gap;
//   - extra buffered audio is caught up by playing ~1.5% faster (inaudible) rather than skipping;
//   - it's capped, so the delay can't build up.

const FRAME = 240; // 5 ms at 48 kHz
const FRAME_MS = 5;
const MIN_TARGET_MS = 5; // on a steady network; grows automatically on uneven Wi-Fi
const MAX_TARGET_MS = 45;
const CONCEAL_FRAMES = 12; // cover up to ~30 ms (12 x 128 samples) of missing audio before going quiet
const HARD_LIMIT_MS = 90; // beyond this, jump straight back to the target
// Give up on a missing frame once this many later ones are waiting (~60 ms), or sooner if
// playback reaches the gap: the play queue is the real deadline.
const REORDER_WAIT_FRAMES = 12;

// Low-pass filter (windowed sinc, cut-off ~10 kHz at 48 kHz) for changing between 48 and 24 kHz.
const TAPS = 31;
const FILTER = (() => {
  const taps = new Float32Array(TAPS);
  const middle = (TAPS - 1) / 2;
  let sum = 0;
  for (let n = 0; n < TAPS; n += 1) {
    const x = n - middle;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x * 0.42) / (Math.PI * x * 0.42);
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1));
    taps[n] = sinc * window;
    sum += taps[n];
  }
  for (let n = 0; n < TAPS; n += 1) taps[n] /= sum;
  return taps;
})();

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
    this.history = new Float32Array(TAPS);
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
        const narrow = this.decimate(this.frame);
        this.port.postMessage({ wide: this.frame, narrow }, [this.frame.buffer, narrow.buffer]);
        this.frame = new Float32Array(FRAME);
        this.filled = 0;
      }
    }
    return true;
  }

  // 48 kHz -> 24 kHz: filter, then keep every other sample.
  decimate(frame) {
    const out = new Float32Array(frame.length / 2);
    const history = this.history;
    for (let index = 0; index < frame.length; index += 1) {
      history.copyWithin(1, 0, TAPS - 1);
      history[0] = frame[index];
      if (index % 2 === 1) {
        let sum = 0;
        for (let tap = 0; tap < TAPS; tap += 1) sum += FILTER[tap] * history[tap];
        out[(index - 1) / 2] = sum;
      }
    }
    return out;
  }
}

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // What the buffer has had to do (sent with the stats, for diagnosing bad connections).
    this.counts = { conceal: 0, resume: 0, trim: 0, fast: 0, reprime: 0, join: 0 };
    this.voices = new Map();
    this.port.onmessage = (event) => this.onMessage(event.data);
    this.reportAt = 0;
  }

  voice(id) {
    let voice = this.voices.get(id);
    if (!voice) {
      voice = {
        queue: [], // Float32Array chunks at 48 kHz
        queued: 0, // samples waiting
        offset: 0,
        playing: false,
        targetMs: MIN_TARGET_MS,
        jitterMs: 0,
        lastArrival: 0,
        volume: 1,
        last: new Float32Array(FRAME), // most recent 5 ms of audio (a ring), for covering gaps
        lastPos: 0,
        frozen: new Float32Array(FRAME),
        concealPos: 0,
        blend: 0,
        concealed: 0,
        fade: 1,
        frac: 0, // position between two samples, when speeding up slightly
        expected: null, // number of the next frame to queue
        pending: new Map(), // frames that arrived early, by number
        joins: new WeakSet(), // chunks that follow a lost frame
        history: new Float32Array(TAPS), // for 24 kHz -> 48 kHz
        lastHeard: currentTime
      };
      this.voices.set(id, voice);
    }
    return voice;
  }

  onMessage(message) {
    if (message.type === "frame") {
      const voice = this.voice(message.id);
      // Frames are numbered. On busy Wi-Fi they can overtake each other, so hold each one in its
      // numbered slot and queue them in order. Only a frame that turns up after its turn has
      // been played (or given up on) is thrown away.
      if (voice.expected === null || ((message.seq - voice.expected) & 0xffff) > 0x8000 && !voice.queued && !voice.pending.size) {
        voice.expected = message.seq; // first frame, or a fresh start after a pause
      }
      const ahead = (message.seq - voice.expected) & 0xffff;
      if (ahead > 0x8000) return; // too late: already played past it
      if (ahead > 200) {
        // A big jump (they stopped and started talking again): start from here.
        voice.pending.clear();
        voice.expected = message.seq;
      }
      voice.pending.set(message.seq, message);
      this.flush(voice, false);
      // How uneven arrivals are: compare each gap with the 5 ms it should be, and follow the
      // biggest recent differences (quick to rise, slow to fall).
      const now = currentTime * 1000;
      if (voice.lastArrival) {
        const deviation = Math.abs(now - voice.lastArrival - FRAME_MS);
        voice.jitterMs = deviation > voice.jitterMs ? voice.jitterMs * 0.7 + deviation * 0.3 : voice.jitterMs * 0.995 + deviation * 0.005;
      }
      voice.lastArrival = now;
      voice.lastHeard = currentTime;
      const wanted = Math.min(MAX_TARGET_MS, Math.max(MIN_TARGET_MS, voice.jitterMs * 2.5 + FRAME_MS));
      voice.targetMs += (wanted - voice.targetMs) * 0.02;
      // Far too much waiting (e.g. after the device slept): jump back to the target.
      if (voice.queued / sampleRate * 1000 > HARD_LIMIT_MS) {
        this.counts.trim += 1;
        this.trim(voice, voice.targetMs);
      }
    } else if (message.type === "volume") {
      this.voice(message.id).volume = message.value;
    }
  }

  // Move frames that are next in line from the waiting slots to the play queue. If the next one
  // hasn't come and later ones have been waiting a while (or playback is about to run dry), give
  // up on it: it was lost, and playback cross-fades over the join.
  flush(voice, starving) {
    for (;;) {
      const message = voice.pending.get(voice.expected);
      if (message) {
        voice.pending.delete(voice.expected);
        const samples = message.narrow ? this.interpolate(voice, message.samples) : message.samples;
        if (voice.skippedFrame) {
          voice.joins.add(samples);
          voice.skippedFrame = false;
        }
        voice.queue.push(samples);
        voice.queued += samples.length;
        voice.expected = (voice.expected + 1) & 0xffff;
        continue;
      }
      if (!voice.pending.size || (voice.pending.size < REORDER_WAIT_FRAMES && !starving)) return;
      // Skip to the oldest frame we do have.
      let oldest = null;
      for (const seq of voice.pending.keys()) {
        if (oldest === null || ((seq - voice.expected) & 0xffff) < ((oldest - voice.expected) & 0xffff)) oldest = seq;
      }
      voice.expected = oldest;
      voice.skippedFrame = true;
    }
  }

  // 24 kHz -> 48 kHz: put a zero between samples, then filter (x2 to keep the level).
  interpolate(voice, samples) {
    const out = new Float32Array(samples.length * 2);
    const history = voice.history;
    for (let index = 0; index < out.length; index += 1) {
      history.copyWithin(1, 0, TAPS - 1);
      history[0] = index % 2 === 0 ? samples[index / 2] : 0;
      let sum = 0;
      for (let tap = 0; tap < TAPS; tap += 1) sum += FILTER[tap] * history[tap];
      out[index] = sum * 2;
    }
    return out;
  }

  trim(voice, keepMs) {
    const keep = Math.round((keepMs / 1000) * sampleRate);
    while (voice.queued - voice.offset > keep && voice.queue.length > 1) {
      voice.queued -= voice.queue[0].length;
      voice.queue.shift();
      voice.offset = 0;
    }
  }

  // Copy the last 5 ms (oldest first) to cover a gap with.
  freeze(voice) {
    for (let index = 0; index < FRAME; index += 1) voice.frozen[index] = voice.last[(voice.lastPos + index) % FRAME];
    voice.fade = 1;
  }

  // The saved sound played backwards from the newest sample, then forwards, and so on (so it
  // never jumps), fading out.
  concealSample(voice) {
    const step = voice.concealPos % (2 * FRAME);
    const back = step < FRAME ? step : 2 * FRAME - 1 - step;
    voice.concealPos += 1;
    voice.fade *= 0.9985;
    return voice.frozen[FRAME - 1 - back] * voice.fade;
  }

  // The sample `ahead` places from the read position, or null if it hasn't arrived.
  peek(voice, ahead) {
    let index = voice.offset + ahead;
    for (const chunk of voice.queue) {
      if (index < chunk.length) return chunk[index];
      index -= chunk.length;
    }
    return null;
  }

  advance(voice) {
    voice.offset += 1;
    while (voice.queue.length && voice.offset >= voice.queue[0].length) {
      voice.queued -= voice.queue[0].length;
      voice.queue.shift();
      voice.offset = 0;
      // Starting a chunk that follows a lost frame: cross-fade from where the sound was heading.
      if (voice.queue.length && voice.joins.has(voice.queue[0]) && voice.blend <= 0) {
        this.freeze(voice);
        voice.concealPos = 1;
        voice.blend = 1;
        this.counts.join += 1;
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    for (const [id, voice] of this.voices) {
      const waitingMs = ((voice.queued - voice.offset) / sampleRate) * 1000;
      if (!voice.playing) {
        if (waitingMs < voice.targetMs) continue;
        voice.playing = true;
      }
      // More waiting than needed: play ~1.5% faster, blending between samples so it stays smooth.
      const rate = waitingMs > voice.targetMs + 2 * FRAME_MS ? 1.015625 : 1;
      if (rate > 1) this.counts.fast += 1;
      for (let index = 0; index < output.length; index += 1) {
        let current = this.peek(voice, 0);
        if (current === null && voice.pending.size) {
          // About to run dry while later frames are waiting: stop waiting for the missing one.
          this.flush(voice, true);
          current = this.peek(voice, 0);
        }
        let sample = null;
        if (current !== null) {
          const following = this.peek(voice, 1);
          sample = following === null ? current : current + (following - current) * voice.frac;
          voice.frac += rate;
          while (voice.frac >= 1) {
            this.advance(voice);
            voice.frac -= 1;
          }
        }
        if (sample === null) {
          // Late packet: keep the last sound going, fading out, rather than a click and a gap.
          if (!voice.concealPos) {
            this.freeze(voice);
            this.counts.conceal += 1;
          }
          sample = this.concealSample(voice);
          if (index === output.length - 1) voice.concealed += 1;
        } else {
          if (voice.concealPos && voice.blend <= 0) {
            // Real audio is back: cross-fade into it over ~1.3 ms instead of switching.
            voice.blend = 1;
            voice.concealed = 0;
            this.counts.resume += 1;
          }
          if (voice.blend > 0) {
            sample = sample * (1 - voice.blend) + this.concealSample(voice) * voice.blend;
            voice.blend -= 1 / 64;
            if (voice.blend <= 0) voice.concealPos = 0;
          } else {
            voice.fade = 1;
          }
          voice.last[voice.lastPos] = sample;
          voice.lastPos = (voice.lastPos + 1) % FRAME;
        }
        output[index] += sample * voice.volume;
      }
      if (voice.concealed > CONCEAL_FRAMES) {
        // Nothing for a while (they stopped talking, or the network dropped): wait to refill.
        voice.playing = false;
        this.counts.reprime += 1;
        voice.concealed = 0;
        voice.concealPos = 0;
        voice.blend = 0;
        voice.frac = 0;
        voice.last.fill(0);
      }
      if (currentTime - voice.lastHeard > 30) this.voices.delete(id);
    }
    for (let channel = 1; channel < outputs[0].length; channel += 1) outputs[0][channel].set(output);

    if (currentTime - this.reportAt > 1) {
      this.reportAt = currentTime;
      const voices = [...this.voices.values()].filter((voice) => currentTime - voice.lastHeard < 2);
      this.port.postMessage({
        type: "stats",
        targetMs: voices.length ? Math.max(...voices.map((voice) => voice.targetMs)) : MIN_TARGET_MS,
        jitterMs: voices.length ? Math.max(...voices.map((voice) => voice.jitterMs)) : 0,
        counts: this.counts
      });
    }
    return true;
  }
}

registerProcessor("qc-capture", CaptureProcessor);
registerProcessor("qc-mixer", MixerProcessor);
