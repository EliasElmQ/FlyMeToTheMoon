// Real-time piano performance analyzer, ported from openspace_piano.scd.
// Produces normalized 0..1 musical features plus discrete bass & note events.

import {
  BAND_HIGH_MAX,
  BAND_LOW_MAX,
  BAND_MID_MAX,
  CHORD_WEIGHT,
  CHORD_WINDOW,
  DENSITY_MAX,
  ENERGY_SMOOTH,
  HIST_WINDOW,
  IC_WEIGHT,
  LOUD_DECAY,
  POLY_MAX,
  TREBLE_DECAY,
  TREBLE_SPLIT,
} from "./constants.js";

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function linlin(v, inMin, inMax, outMin, outMax) {
  const t = (v - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

export function chordTension(notes) {
  if (!notes || notes.length < 2) return 0.0;
  let pairs = 0;
  let total = 0.0;
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i];
    for (let j = i + 1; j < notes.length; j++) {
      const d = Math.abs(a - notes[j]) % 12;
      const ic = Math.min(d, 12 - d);
      total += IC_WEIGHT[ic];
      pairs += 1;
    }
  }
  return pairs > 0 ? clamp01(total / pairs) : 0.0;
}

export class PianoAnalyzer {
  constructor(opts = {}) {
    this.histWindow = opts.histWindow ?? HIST_WINDOW;
    this.densityMax = opts.densityMax ?? DENSITY_MAX;
    this.chordWindow = opts.chordWindow ?? CHORD_WINDOW;
    this.chordWeight = opts.chordWeight ?? CHORD_WEIGHT;
    this.loudDecay = opts.loudDecay ?? LOUD_DECAY;
    this.energySmooth = opts.energySmooth ?? ENERGY_SMOOTH;
    this.polyMax = opts.polyMax ?? POLY_MAX;
    this.trebleSplit = opts.trebleSplit ?? TREBLE_SPLIT;
    this.bandLowMax = opts.bandLowMax ?? BAND_LOW_MAX;
    this.bandMidMax = opts.bandMidMax ?? BAND_MID_MAX;
    this.bandHighMax = opts.bandHighMax ?? BAND_HIGH_MAX;
    this.trebleDecay = opts.trebleDecay ?? TREBLE_DECAY;

    this.keysDown = new Set();
    this.sustained = new Set();
    this.history = []; // { t, note, vel }
    this.pedal = false;

    this.loudAcc = 0.0;
    this.trebleAcc = 0.0;
    this.bandLowAcc = 0.0;
    this.bandMidAcc = 0.0;
    this.bandHighAcc = 0.0;

    this.density = 0.0;
    this.energy = 0.0;
    this.centroid = 0.5;
    this.spread = 0.0;
    this.tension = 0.0;
    this.poly = 0.0;
    this.bass = -1;
  }

  noteOn(num, vel, nowSec) {
    const v = clamp01(Number(vel) || 0);
    if (v <= 0) {
      this.noteOff(num);
      return;
    }
    this.sustained.delete(num);
    this.keysDown.add(num);
    this.history.push({ t: nowSec, note: num, vel: v });

    this.loudAcc = Math.max(this.loudAcc, v);
    if (num >= this.trebleSplit) {
      this.trebleAcc = Math.max(this.trebleAcc, v);
    }
    if (num <= this.bandLowMax) {
      this.bandLowAcc = Math.max(this.bandLowAcc, v);
    } else if (num <= this.bandMidMax) {
      this.bandMidAcc = Math.max(this.bandMidAcc, v);
    } else if (num <= this.bandHighMax) {
      this.bandHighAcc = Math.max(this.bandHighAcc, v);
    }
  }

  noteOff(num) {
    this.keysDown.delete(num);
    if (this.pedal) {
      this.sustained.add(num);
    }
  }

  setPedal(down) {
    const wasDown = this.pedal;
    this.pedal = Boolean(down);
    if (wasDown && !this.pedal) {
      this.sustained.clear();
    }
  }

  panic() {
    this.keysDown.clear();
    this.sustained.clear();
    this.history.length = 0;
    this.pedal = false;
    this.loudAcc = 0.0;
    this.trebleAcc = 0.0;
    this.bandLowAcc = 0.0;
    this.bandMidAcc = 0.0;
    this.bandHighAcc = 0.0;
    this.density = 0.0;
    this.energy = 0.0;
    this.spread = 0.0;
    this.tension = 0.0;
    this.poly = 0.0;
    this.bass = -1;
  }

  /**
   * Advance one analysis tick. `dtSec` defaults to 1/30s (matching ~sendRate = 30).
   * @param {number} nowSec
   * @param {number} [dtSec=1/30]
   */
  tick(nowSec, dtSec = 1 / 30) {
    const cutoff = nowSec - this.histWindow;
    let dropCount = 0;
    while (dropCount < this.history.length && this.history[dropCount].t < cutoff) {
      dropCount += 1;
    }
    if (dropCount > 0) {
      this.history.splice(0, dropCount);
    }

    // Sequential note density (chord-filtered)
    let count = 0.0;
    let lastOnset = -100.0;
    for (const e of this.history) {
      if (e.t - lastOnset > this.chordWindow) {
        count += 1.0;
        lastOnset = e.t;
      } else {
        count += this.chordWeight;
      }
    }
    this.density = clamp01(count / this.histWindow / this.densityMax);

    // Scale per-tick decays by dtSec * 30 so timing stays consistent if browser timer jitters.
    const stepScale = Math.max(0.0, Math.min(15.0, dtSec * 30.0));
    const loudFactor = Math.pow(this.loudDecay, stepScale);
    const bandFactor = Math.pow(this.trebleDecay, stepScale);

    this.loudAcc *= loudFactor;
    this.trebleAcc *= bandFactor;
    this.bandLowAcc *= bandFactor;
    this.bandMidAcc *= bandFactor;
    this.bandHighAcc *= bandFactor;

    let tCentroid = this.centroid;
    let tSpread = 0.0;
    if (this.history.length > 0) {
      let sum = 0;
      let minNote = 127;
      let maxNote = 0;
      for (const e of this.history) {
        sum += e.note;
        if (e.note < minNote) minNote = e.note;
        if (e.note > maxNote) maxNote = e.note;
      }
      tCentroid = clamp01(linlin(sum / this.history.length, 21, 108, 0, 1));
      if (this.history.length > 1) {
        tSpread = clamp01((maxNote - minNote) / 60);
      }
    }

    const downArr = Array.from(this.keysDown);
    const tTension = chordTension(downArr);
    const tPoly = clamp01(downArr.length / this.polyMax);
    const tBass = downArr.length > 0 ? Math.min(...downArr) : -1;

    const raw = 0.55 * this.density + 0.45 * this.loudAcc;

    const lagCoef = (coef) => 1.0 - Math.pow(1.0 - coef, stepScale);
    this.energy += (raw - this.energy) * lagCoef(this.energySmooth);
    this.centroid += (tCentroid - this.centroid) * lagCoef(0.06);
    this.spread += (tSpread - this.spread) * lagCoef(0.08);
    this.tension += (tTension - this.tension) * lagCoef(0.05);
    this.poly += (tPoly - this.poly) * lagCoef(0.15);
    this.bass = tBass;

    return {
      energy: this.energy,
      zoomSpeed: Math.pow(this.energy, 1.6),
      density: this.density,
      loudness: this.loudAcc,
      centroid: this.centroid,
      spread: this.spread,
      tension: this.tension,
      polyphony: this.poly,
      treble: this.trebleAcc,
      bandLow: this.bandLowAcc,
      bandMid: this.bandMidAcc,
      bandHigh: this.bandHighAcc,
      bass: this.bass,
    };
  }
}
