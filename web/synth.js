// Web Audio polyphonic piano synthesizer modeled on \kbPiano and \kbBody
// in openspace_piano.scd (11-partial additive timbre + hammer click + soundboard EQ/reverb).

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function midiToFreq(note) {
  return 440.0 * Math.pow(2.0, (note - 69) / 12.0);
}

export class PianoSynth {
  constructor(opts = {}) {
    this.muted = Boolean(opts.muted ?? false);
    this.volume = opts.volume ?? 0.8;
    this.pos = opts.pos ?? 0.13;       // hammer strike point (0.06..0.25)
    this.c1Scale = opts.c1Scale ?? 1.0; // decay multiplier (below 1 = longer)
    this.c3Scale = opts.c3Scale ?? 1.0; // brightness multiplier (below 1 = brighter)
    this.detune = opts.detune ?? 1.0;   // unison detuning scale
    this.bodyMix = opts.bodyMix ?? 0.20;
    this.bodyRoom = opts.bodyRoom ?? 0.50;
    this.bodyDamp = opts.bodyDamp ?? 0.50;
    this.maxVoices = opts.maxVoices ?? 48;

    this.ctx = null;
    this.busIn = null;
    this.dryGain = null;
    this.wetGain = null;
    this.convolver = null;
    this.warmFilter = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    this.waveCache = new Map();

    this.keysDown = new Set();
    this.sustained = new Set();
    this.pedal = false;
    this.voices = new Map(); // note -> { stop(now, immediate) }
  }

  get available() {
    return (
      typeof window !== "undefined" &&
      Boolean(window.AudioContext || window.webkitAudioContext)
    );
  }

  ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }
    if (!this.available) return null;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx({ latencyHint: "interactive" });
    this.ctx = ctx;

    // Master soundboard chain mirroring \kbBody
    this.busIn = ctx.createGain();
    this.busIn.gain.value = 1.0;

    const hp30 = ctx.createBiquadFilter();
    hp30.type = "highpass";
    hp30.frequency.value = 30;

    const eq1 = ctx.createBiquadFilter();
    eq1.type = "peaking";
    eq1.frequency.value = 130;
    eq1.Q.value = 1.0;
    eq1.gain.value = 2.0;

    const eq2 = ctx.createBiquadFilter();
    eq2.type = "peaking";
    eq2.frequency.value = 400;
    eq2.Q.value = 0.9;
    eq2.gain.value = 1.2;

    const eq3 = ctx.createBiquadFilter();
    eq3.type = "peaking";
    eq3.frequency.value = 3000;
    eq3.Q.value = 1.2;
    eq3.gain.value = -1.5;

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this._rebuildReverbIR();

    this.warmFilter = ctx.createBiquadFilter();
    this.warmFilter.type = "lowpass";
    this.warmFilter.frequency.value = this._masterCutoff();

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    this.masterGain = ctx.createGain();
    this._applyMasterParams();

    this.busIn.connect(hp30);
    hp30.connect(eq1);
    eq1.connect(eq2);
    eq2.connect(eq3);

    eq3.connect(this.dryGain);
    eq3.connect(this.convolver);
    this.convolver.connect(this.wetGain);

    this.dryGain.connect(this.warmFilter);
    this.wetGain.connect(this.warmFilter);

    this.warmFilter.connect(limiter);
    limiter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Pre-generate 0.05s white-noise hammer transient buffer
    const nLen = Math.max(1, Math.floor(ctx.sampleRate * 0.05));
    const buf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < nLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buf;

    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  _masterCutoff() {
    return clamp(4200 / Math.max(0.2, this.c3Scale), 700, 14000);
  }

  _applyMasterParams() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const mix = clamp(this.bodyMix, 0, 1);
    this.dryGain.gain.setTargetAtTime(1 - mix, now, 0.02);
    this.wetGain.gain.setTargetAtTime(mix, now, 0.02);
    this.warmFilter.frequency.setTargetAtTime(this._masterCutoff(), now, 0.02);
    const outLevel = this.muted ? 0.0 : clamp(this.volume, 0, 1.5) * 0.9;
    this.masterGain.gain.setTargetAtTime(outLevel, now, 0.015);
  }

  _rebuildReverbIR() {
    if (!this.ctx || !this.convolver) return;
    const sr = this.ctx.sampleRate;
    const duration = clamp(0.4 + this.bodyRoom * 2.2, 0.3, 3.0);
    const len = Math.floor(sr * duration);
    const ir = this.ctx.createBuffer(2, len, sr);
    const dampAlpha = clamp(1.0 - this.bodyDamp * 0.7, 0.15, 0.95);

    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, 2.6);
        const white = Math.random() * 2 - 1;
        lp = lp + dampAlpha * (white - lp);
        data[i] = lp * env * 0.35;
      }
    }
    this.convolver.buffer = ir;
  }

  _getWave(pos) {
    const key = Math.round(clamp(pos, 0.03, 0.45) * 100);
    if (this.waveCache.has(key)) return this.waveCache.get(key);
    const real = new Float32Array(12);
    const imag = new Float32Array(12);
    const p = key / 100;
    for (let n = 1; n <= 11; n++) {
      const strike = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * n * p));
      imag[n] = (1 / Math.pow(n, 1.35)) * strike;
    }
    const wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this.waveCache.set(key, wave);
    return wave;
  }

  setTimbre(params = {}) {
    let rebuildIR = false;
    if (params.pos !== undefined) this.pos = Number(params.pos);
    if (params.c1Scale !== undefined) this.c1Scale = Number(params.c1Scale);
    if (params.c3Scale !== undefined) this.c3Scale = Number(params.c3Scale);
    if (params.detune !== undefined) this.detune = Number(params.detune);
    if (params.bodyMix !== undefined) this.bodyMix = Number(params.bodyMix);
    if (params.bodyRoom !== undefined) {
      const r = Number(params.bodyRoom);
      if (Math.abs(r - this.bodyRoom) > 0.01) rebuildIR = true;
      this.bodyRoom = r;
    }
    if (params.bodyDamp !== undefined) {
      const d = Number(params.bodyDamp);
      if (Math.abs(d - this.bodyDamp) > 0.01) rebuildIR = true;
      this.bodyDamp = d;
    }
    if (params.volume !== undefined) this.volume = Number(params.volume);
    if (params.muted !== undefined) this.muted = Boolean(params.muted);

    if (rebuildIR) this._rebuildReverbIR();
    this._applyMasterParams();
  }

  resume() {
    this.ensureContext();
  }

  noteOn(num, vel = 0.7) {
    const v = clamp(Number(vel) || 0, 0, 1);
    if (v <= 0) {
      this.noteOff(num);
      return;
    }
    // Re-strike damps existing voice cleanly
    const existing = this.voices.get(num);
    if (existing) {
      existing.stop(this.ctx ? this.ctx.currentTime : 0, true);
      this.voices.delete(num);
    }
    this.sustained.delete(num);
    this.keysDown.add(num);

    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    // Enforce voice cap
    if (this.voices.size >= this.maxVoices) {
      const oldestKey = this.voices.keys().next().value;
      const oldest = this.voices.get(oldestKey);
      if (oldest) oldest.stop(ctx.currentTime, true);
      this.voices.delete(oldestKey);
    }

    const now = ctx.currentTime;
    const freq = midiToFreq(num);
    const decay = (7.0 * clamp(400.0 / (freq + 120.0), 0.3, 3.5)) / Math.max(0.15, this.c1Scale);
    const amp = (v * v * 0.9 + 0.05) * 0.32;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 0.0001;
    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.linearRampToValueAtTime(amp, now + 0.004);
    voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0005, amp * 0.18), now + decay * 0.45);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = "lowpass";
    const startCut = clamp((freq * 9.0) / Math.max(0.2, this.c3Scale), 800, 16000);
    const endCut = clamp(freq * 1.4, 220, 4000);
    toneFilter.frequency.setValueAtTime(startCut, now);
    toneFilter.frequency.exponentialRampToValueAtTime(endCut, now + Math.min(decay, 3.0));

    const wave = this._getWave(this.pos);
    const osc1 = ctx.createOscillator();
    osc1.setPeriodicWave(wave);
    osc1.frequency.setValueAtTime(freq, now);

    const osc2 = ctx.createOscillator();
    osc2.setPeriodicWave(wave);
    osc2.frequency.setValueAtTime(freq, now);
    osc2.detune.setValueAtTime(this.detune * 1.8, now);

    const osc1Gain = ctx.createGain();
    osc1Gain.gain.value = 0.65;
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.35;

    // Hammer noise click
    const hammer = ctx.createBufferSource();
    hammer.buffer = this.noiseBuffer;
    const hammerHp = ctx.createBiquadFilter();
    hammerHp.type = "highpass";
    hammerHp.frequency.value = 1400;
    const hammerGain = ctx.createGain();
    hammerGain.gain.value = 0.0001;
    hammerGain.gain.setValueAtTime(0.22 * v, now);
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(clamp(((num - 60 + 39) / 87) * 1.2 - 0.6, -0.6, 0.6), now);

    osc1.connect(osc1Gain);
    osc2.connect(osc2Gain);
    osc1Gain.connect(toneFilter);
    osc2Gain.connect(toneFilter);

    hammer.connect(hammerHp);
    hammerHp.connect(hammerGain);
    hammerGain.connect(toneFilter);

    toneFilter.connect(voiceGain);
    voiceGain.connect(panner);
    panner.connect(this.busIn);

    osc1.start(now);
    osc2.start(now);
    hammer.start(now);
    hammer.stop(now + 0.045);

    let stopped = false;
    let oscStopped = false;
    let autoStopTimer = null;

    const cleanup = () => {
      if (autoStopTimer !== null) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
      }
      for (const node of [
        osc1,
        osc2,
        osc1Gain,
        osc2Gain,
        hammer,
        hammerHp,
        hammerGain,
        toneFilter,
        voiceGain,
        panner,
      ]) {
        try {
          node.disconnect();
        } catch {
          // already disconnected
        }
      }
      if (this.voices.get(num) === handle) {
        this.voices.delete(num);
      }
    };

    osc1.onended = cleanup;

    const handle = {
      stop: (when = ctx.currentTime, fast = false) => {
        if (autoStopTimer !== null) {
          clearTimeout(autoStopTimer);
          autoStopTimer = null;
        }
        if (stopped) return;
        stopped = true;
        const stopAt = Math.max(ctx.currentTime, Number.isFinite(when) ? when : ctx.currentTime);
        const release = fast ? 0.025 : 0.35;
        try {
          hammerGain.gain.cancelScheduledValues(stopAt);
          hammerGain.gain.setValueAtTime(0.0001, stopAt);

          if (typeof voiceGain.gain.cancelAndHoldAtTime === "function") {
            voiceGain.gain.cancelAndHoldAtTime(stopAt);
          } else {
            voiceGain.gain.cancelScheduledValues(stopAt);
            const safeCur = Math.min(amp, Math.max(0.0001, voiceGain.gain.value));
            voiceGain.gain.setValueAtTime(safeCur, stopAt);
          }
          voiceGain.gain.setTargetAtTime(0.0001, stopAt, release / 4.5);

          if (!oscStopped) {
            oscStopped = true;
            osc1.stop(stopAt + release + 0.05);
            osc2.stop(stopAt + release + 0.05);
          }
        } catch {
          cleanup();
        }
      },
    };

    autoStopTimer = setTimeout(() => {
      autoStopTimer = null;
      if (!stopped) {
        handle.stop(ctx.currentTime, true);
      }
    }, Math.ceil((decay + 0.08) * 1000));
    autoStopTimer?.unref?.();

    this.voices.set(num, handle);
  }

  noteOff(num) {
    this.keysDown.delete(num);
    if (this.pedal) {
      if (this.voices.has(num)) {
        this.sustained.add(num);
      }
      return;
    }
    const v = this.voices.get(num);
    if (v) {
      v.stop(this.ctx ? this.ctx.currentTime : 0, false);
      this.voices.delete(num);
    }
  }

  setPedal(down) {
    const wasDown = this.pedal;
    this.pedal = Boolean(down);
    if (wasDown && !this.pedal) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      for (const n of this.sustained) {
        if (!this.keysDown.has(n)) {
          const v = this.voices.get(n);
          if (v) {
            v.stop(now, false);
            this.voices.delete(n);
          }
        }
      }
      this.sustained.clear();
    }
  }

  panic() {
    this.keysDown.clear();
    this.sustained.clear();
    this.pedal = false;
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const v of this.voices.values()) {
      v.stop(now, true);
    }
    this.voices.clear();
  }
}
