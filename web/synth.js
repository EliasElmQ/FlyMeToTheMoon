// Web Audio polyphonic synthesizer with 8 selectable instruments modeled around
// \kbPiano and \kbBody from openspace_piano.scd (zero external assets).

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function midiToFreq(note) {
  return 440.0 * Math.pow(2.0, (note - 69) / 12.0);
}

export const INSTRUMENTS = [
  {
    id: "piano",
    name: "Acoustic Piano",
    category: "Keys",
    defaults: { bodyMix: 0.20, bodyRoom: 0.50, c1Scale: 1.0, c3Scale: 1.0, pos: 0.13, detune: 1.0 },
  },
  {
    id: "epiano",
    name: "Electric Piano (Tine)",
    category: "Keys",
    defaults: { bodyMix: 0.28, bodyRoom: 0.55, c1Scale: 0.85, c3Scale: 1.15, pos: 0.18, detune: 1.4 },
  },
  {
    id: "celesta",
    name: "Celesta / Starlight Bells",
    category: "Mallet",
    defaults: { bodyMix: 0.45, bodyRoom: 0.72, c1Scale: 0.75, c3Scale: 0.85, pos: 0.10, detune: 0.6 },
  },
  {
    id: "pad",
    name: "Cosmic Space Pad",
    category: "Pad",
    defaults: { bodyMix: 0.55, bodyRoom: 0.85, c1Scale: 0.70, c3Scale: 1.25, pos: 0.20, detune: 2.2 },
  },
  {
    id: "organ",
    name: "Cathedral Pipe Organ",
    category: "Organ",
    defaults: { bodyMix: 0.42, bodyRoom: 0.78, c1Scale: 1.0, c3Scale: 1.05, pos: 0.15, detune: 0.9 },
  },
  {
    id: "harpsichord",
    name: "Harpsichord",
    category: "Pluck",
    defaults: { bodyMix: 0.18, bodyRoom: 0.40, c1Scale: 1.35, c3Scale: 0.72, pos: 0.08, detune: 0.4 },
  },
  {
    id: "harp",
    name: "Concert Harp",
    category: "Pluck",
    defaults: { bodyMix: 0.36, bodyRoom: 0.68, c1Scale: 0.90, c3Scale: 1.10, pos: 0.19, detune: 0.5 },
  },
  {
    id: "synth",
    name: "Analog Poly Synth",
    category: "Synth",
    defaults: { bodyMix: 0.30, bodyRoom: 0.60, c1Scale: 0.95, c3Scale: 0.90, pos: 0.12, detune: 1.8 },
  },
];

export class PianoSynth {
  constructor(opts = {}) {
    this.instrument = opts.instrument ?? "piano";
    this.muted = Boolean(opts.muted ?? false);
    this.volume = opts.volume ?? 0.8;
    this.pos = opts.pos ?? 0.13;       // strike/pluck point (0.05..0.30)
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

  setInstrument(id, applyDefaults = true) {
    const preset = INSTRUMENTS.find((item) => item.id === id) || INSTRUMENTS[0];
    this.instrument = preset.id;
    if (applyDefaults && preset.defaults) {
      this.setTimbre(preset.defaults);
    }
    return preset;
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

    // Pre-generate 0.05s white-noise hammer/pluck transient buffer
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
    return clamp(4600 / Math.max(0.2, this.c3Scale), 700, 15000);
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

  _getWave(kind, pos) {
    const pKey = Math.round(clamp(pos, 0.03, 0.45) * 100);
    const key = `${kind}:${pKey}`;
    if (this.waveCache.has(key)) return this.waveCache.get(key);

    const real = new Float32Array(13);
    const imag = new Float32Array(13);
    const p = pKey / 100;

    if (kind === "organ") {
      // Pipe / drawbar harmonic blend (1, 2, 3, 4, 6, 8)
      const bright = clamp(1.2 - p * 3.0, 0.2, 1.0);
      imag[1] = 1.0;
      imag[2] = 0.72;
      imag[3] = 0.45 * bright;
      imag[4] = 0.38 * bright;
      imag[6] = 0.22 * bright;
      imag[8] = 0.16 * bright;
    } else if (kind === "harpsichord") {
      for (let n = 1; n <= 12; n++) {
        const pluck = 0.4 + 0.6 * Math.abs(Math.sin(Math.PI * n * p));
        imag[n] = (1 / Math.pow(n, 0.85)) * pluck;
      }
    } else if (kind === "harp") {
      for (let n = 1; n <= 10; n++) {
        const pluck = 0.45 + 0.55 * Math.abs(Math.sin(Math.PI * n * p));
        imag[n] = (1 / Math.pow(n, 1.55)) * pluck;
      }
    } else if (kind === "saw") {
      for (let n = 1; n <= 12; n++) {
        const edge = 0.55 + 0.45 * Math.abs(Math.sin(Math.PI * n * p));
        imag[n] = (1 / n) * edge;
      }
    } else if (kind === "pad") {
      for (let n = 1; n <= 10; n++) {
        imag[n] = (1 / Math.pow(n, 1.45)) * (n % 2 === 1 ? 1.0 : 0.55);
      }
    } else {
      // Default piano 11-partial strike spectrum
      for (let n = 1; n <= 11; n++) {
        const strike = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * n * p));
        imag[n] = (1 / Math.pow(n, 1.35)) * strike;
      }
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

  _addNoiseTransient(ctx, targetNode, now, filterType, filterFreq, gainAmt, durSec, allNodes, auxGains) {
    if (!this.noiseBuffer || gainAmt <= 0) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.setValueAtTime(gainAmt, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durSec);

    src.connect(flt);
    flt.connect(g);
    g.connect(targetNode);

    src.start(now);
    src.stop(now + durSec + 0.015);
    allNodes.push(src, flt, g);
    auxGains.push(g);
  }

  _buildVoiceGraph(ctx, num, freq, v, amp, now) {
    const baseDecay = (7.0 * clamp(400.0 / (freq + 120.0), 0.3, 3.5)) / Math.max(0.15, this.c1Scale);
    const brightScale = Math.max(0.2, this.c3Scale);

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 0.0001;

    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = "lowpass";

    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(clamp(((num - 60 + 39) / 87) * 1.2 - 0.6, -0.6, 0.6), now);

    toneFilter.connect(voiceGain);
    voiceGain.connect(panner);
    panner.connect(this.busIn);

    const oscNodes = [];
    const auxGains = [];
    const allNodes = [toneFilter, voiceGain, panner];

    const addOsc = ({ freqHz, detuneCents = 0, waveKind = null, type = "sine", gainAmt = 0.5 }) => {
      const osc = ctx.createOscillator();
      if (waveKind) {
        osc.setPeriodicWave(this._getWave(waveKind, this.pos));
      } else {
        osc.type = type;
      }
      osc.frequency.setValueAtTime(freqHz, now);
      if (detuneCents !== 0) {
        osc.detune.setValueAtTime(detuneCents, now);
      }
      const g = ctx.createGain();
      g.gain.value = gainAmt;
      osc.connect(g);
      g.connect(toneFilter);
      osc.start(now);
      oscNodes.push(osc);
      allNodes.push(osc, g);
      return osc;
    };

    let releaseSec = 0.35;
    let autoStopSec = baseDecay;
    let peakAmp = amp;

    if (this.instrument === "epiano") {
      // FM tine electric piano
      const decay = baseDecay * 1.15;
      autoStopSec = decay;
      releaseSec = 0.42;
      peakAmp = amp * 0.95;

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.005);
      voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0005, peakAmp * 0.25), now + decay * 0.4);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      toneFilter.frequency.setValueAtTime(clamp((freq * 7.5) / brightScale, 700, 14000), now);
      toneFilter.frequency.exponentialRampToValueAtTime(clamp(freq * 1.6, 260, 3600), now + Math.min(decay, 2.4));

      const carrier = addOsc({ freqHz: freq, type: "sine", gainAmt: 0.72 });
      addOsc({ freqHz: freq, detuneCents: this.detune * 2.4, type: "sine", gainAmt: 0.28 });

      // Decaying FM tine bell modulator
      const modOsc = ctx.createOscillator();
      modOsc.type = "sine";
      modOsc.frequency.setValueAtTime(freq * 7.0, now);
      const modGain = ctx.createGain();
      modGain.gain.value = 0.0001;
      const fmDepth = clamp(freq * (1.8 * v + 0.25) / brightScale, 20, 4500);
      modGain.gain.setValueAtTime(fmDepth, now);
      modGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22 / Math.max(0.2, this.c1Scale));
      modOsc.connect(modGain);
      modGain.connect(carrier.frequency);
      modOsc.start(now);
      oscNodes.push(modOsc);
      auxGains.push(modGain);
      allNodes.push(modOsc, modGain);

      this._addNoiseTransient(ctx, toneFilter, now, "bandpass", 850, 0.14 * v, 0.02, allNodes, auxGains);
    } else if (this.instrument === "celesta") {
      const decay = baseDecay * 0.9;
      autoStopSec = decay;
      releaseSec = 0.55;
      peakAmp = amp * 0.9;

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.004);
      voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0005, peakAmp * 0.22), now + decay * 0.35);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      toneFilter.frequency.setValueAtTime(clamp((freq * 10.0) / brightScale, 1200, 16000), now);
      toneFilter.frequency.exponentialRampToValueAtTime(clamp(freq * 2.2, 400, 6000), now + Math.min(decay, 2.0));

      addOsc({ freqHz: freq, type: "sine", gainAmt: 0.62 });
      addOsc({ freqHz: freq * 2.756, detuneCents: this.detune * 0.8, type: "sine", gainAmt: 0.24 });
      addOsc({ freqHz: freq * 4.0, detuneCents: -this.detune * 1.1, type: "sine", gainAmt: 0.14 });
      this._addNoiseTransient(ctx, toneFilter, now, "bandpass", 2400, 0.16 * v, 0.022, allNodes, auxGains);
    } else if (this.instrument === "pad") {
      autoStopSec = 25.0;
      releaseSec = 1.4;
      peakAmp = amp * 0.72;
      const atk = 0.38 / Math.max(0.35, this.c1Scale);

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + atk);

      toneFilter.frequency.setValueAtTime(clamp((freq * 2.2) / brightScale, 350, 5000), now);
      toneFilter.frequency.exponentialRampToValueAtTime(clamp((freq * 6.5) / brightScale, 600, 12000), now + atk * 1.8);

      addOsc({ freqHz: freq, waveKind: "pad", gainAmt: 0.40 });
      addOsc({ freqHz: freq, detuneCents: this.detune * 6.0, waveKind: "pad", gainAmt: 0.30 });
      addOsc({ freqHz: freq, detuneCents: -this.detune * 6.0, waveKind: "pad", gainAmt: 0.30 });
    } else if (this.instrument === "organ") {
      autoStopSec = 25.0;
      releaseSec = 0.18;
      peakAmp = amp * 0.74;

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.015);

      toneFilter.frequency.setValueAtTime(clamp((freq * 8.5) / brightScale, 900, 14000), now);

      addOsc({ freqHz: freq, waveKind: "organ", gainAmt: 0.52 });
      addOsc({ freqHz: freq * 0.5, type: "sine", gainAmt: 0.26 });
      addOsc({ freqHz: freq, detuneCents: this.detune * 2.2, waveKind: "organ", gainAmt: 0.22 });
    } else if (this.instrument === "harpsichord") {
      const decay = baseDecay * 0.65;
      autoStopSec = decay;
      releaseSec = 0.12;
      peakAmp = amp * 0.92;

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.002);
      voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0005, peakAmp * 0.22), now + decay * 0.4);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      toneFilter.frequency.setValueAtTime(clamp((freq * 12.0) / brightScale, 1500, 16500), now);
      toneFilter.frequency.exponentialRampToValueAtTime(clamp(freq * 2.0, 350, 5000), now + Math.min(decay * 0.55, 1.8));

      addOsc({ freqHz: freq, waveKind: "harpsichord", gainAmt: 0.76 });
      addOsc({ freqHz: freq * 2.0, detuneCents: this.detune * 1.5, waveKind: "harpsichord", gainAmt: 0.24 });
      this._addNoiseTransient(ctx, toneFilter, now, "bandpass", 2200, 0.25 * v, 0.018, allNodes, auxGains);
    } else if (this.instrument === "harp") {
      const decay = baseDecay * 0.95;
      autoStopSec = decay;
      releaseSec = 0.65;
      peakAmp = amp * 0.95;

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.006);
      voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0005, peakAmp * 0.20), now + decay * 0.42);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      toneFilter.frequency.setValueAtTime(clamp((freq * 7.0) / brightScale, 750, 12000), now);
      toneFilter.frequency.exponentialRampToValueAtTime(clamp(freq * 1.3, 220, 3200), now + Math.min(decay, 2.5));

      addOsc({ freqHz: freq, waveKind: "harp", gainAmt: 0.68 });
      addOsc({ freqHz: freq, detuneCents: this.detune * 1.1, waveKind: "harp", gainAmt: 0.32 });
      this._addNoiseTransient(ctx, toneFilter, now, "lowpass", 950, 0.14 * v, 0.024, allNodes, auxGains);
    } else if (this.instrument === "synth") {
      autoStopSec = 25.0;
      releaseSec = 0.35;
      peakAmp = amp * 0.85;
      const sustainAmp = Math.max(0.0005, peakAmp * 0.55);

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.008);
      voiceGain.gain.exponentialRampToValueAtTime(sustainAmp, now + 0.28 / Math.max(0.2, this.c1Scale));

      toneFilter.Q.value = 2.2;
      toneFilter.frequency.setValueAtTime(clamp((freq * (4.0 + 8.0 * v)) / brightScale, 700, 15000), now);
      toneFilter.frequency.exponentialRampToValueAtTime(clamp((freq * 2.8) / brightScale, 320, 4800), now + 0.45 / Math.max(0.2, this.c1Scale));

      addOsc({ freqHz: freq, detuneCents: -this.detune * 4.5, waveKind: "saw", gainAmt: 0.50 });
      addOsc({ freqHz: freq, detuneCents: this.detune * 4.5, waveKind: "saw", gainAmt: 0.50 });
    } else {
      // Acoustic Piano (default)
      autoStopSec = baseDecay;
      releaseSec = 0.35;
      peakAmp = amp;

      voiceGain.gain.setValueAtTime(0.0001, now);
      voiceGain.gain.linearRampToValueAtTime(peakAmp, now + 0.004);
      voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0005, peakAmp * 0.18), now + baseDecay * 0.45);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + baseDecay);

      const startCut = clamp((freq * 9.0) / brightScale, 800, 16000);
      const endCut = clamp(freq * 1.4, 220, 4000);
      toneFilter.frequency.setValueAtTime(startCut, now);
      toneFilter.frequency.exponentialRampToValueAtTime(endCut, now + Math.min(baseDecay, 3.0));

      addOsc({ freqHz: freq, waveKind: "piano", gainAmt: 0.65 });
      addOsc({ freqHz: freq, detuneCents: this.detune * 1.8, waveKind: "piano", gainAmt: 0.35 });
      this._addNoiseTransient(ctx, toneFilter, now, "highpass", 1400, 0.22 * v, 0.032, allNodes, auxGains);
    }

    return { voiceGain, oscNodes, auxGains, allNodes, releaseSec, autoStopSec, peakAmp };
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
    const amp = (v * v * 0.9 + 0.05) * 0.32;

    const { voiceGain, oscNodes, auxGains, allNodes, releaseSec, autoStopSec, peakAmp } =
      this._buildVoiceGraph(ctx, num, freq, v, amp, now);

    let stopped = false;
    let oscStopped = false;
    let autoStopTimer = null;

    const cleanup = () => {
      if (autoStopTimer !== null) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
      }
      for (const node of allNodes) {
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

    if (oscNodes[0]) {
      oscNodes[0].onended = cleanup;
    }

    const handle = {
      stop: (when = ctx.currentTime, fast = false) => {
        if (autoStopTimer !== null) {
          clearTimeout(autoStopTimer);
          autoStopTimer = null;
        }
        if (stopped) return;
        stopped = true;
        const stopAt = Math.max(ctx.currentTime, Number.isFinite(when) ? when : ctx.currentTime);
        const release = fast ? 0.025 : releaseSec;
        try {
          for (const g of auxGains) {
            g.gain.cancelScheduledValues(stopAt);
            g.gain.setValueAtTime(0.0001, stopAt);
          }

          if (typeof voiceGain.gain.cancelAndHoldAtTime === "function") {
            voiceGain.gain.cancelAndHoldAtTime(stopAt);
          } else {
            voiceGain.gain.cancelScheduledValues(stopAt);
            const safeCur = Math.min(peakAmp, Math.max(0.0001, voiceGain.gain.value));
            voiceGain.gain.setValueAtTime(safeCur, stopAt);
          }
          voiceGain.gain.setTargetAtTime(0.0001, stopAt, release / 4.5);

          if (!oscStopped) {
            oscStopped = true;
            const oscEnd = stopAt + release + 0.05;
            for (const osc of oscNodes) {
              osc.stop(oscEnd);
            }
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
    }, Math.ceil((autoStopSec + 0.08) * 1000));
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
