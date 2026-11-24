// Interactive 88-key visual piano & scrolling piano-roll canvas,
// ported from piano_view.scd with pointer/touch glissando and zone markers.

import {
  BAND_HIGH_MAX,
  BAND_LOW_MAX,
  BAND_MID_MAX,
  BASS_SPLIT,
  TREBLE_SPLIT,
  noteName,
} from "./constants.js";

const LO = 21;  // A0
const HI = 108; // C8
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);

const IS_BLACK = new Array(128).fill(false);
const WHITE_BELOW = new Array(128).fill(0);
let nWhite = 0;
for (let n = LO; n <= HI; n++) {
  const black = !WHITE_PCS.has(n % 12);
  IS_BLACK[n] = black;
  WHITE_BELOW[n] = nWhite;
  if (!black) nWhite += 1;
}
const N_WHITE = nWhite; // 52

function parseRgb(r, g, b) {
  return [r, g, b];
}

function blendRgb(base, accent, t) {
  const f = Math.min(1, Math.max(0, t));
  const r = Math.round(base[0] + (accent[0] - base[0]) * f);
  const g = Math.round(base[1] + (accent[1] - base[1]) * f);
  const b = Math.round(base[2] + (accent[2] - base[2]) * f);
  return `rgb(${r},${g},${b})`;
}

const COL_BG = "#141513";
const COL_WHITE = parseRgb(234, 232, 226);
const COL_BLACK = parseRgb(28, 28, 26);
const COL_EDGE = "#0a0a09";
const COL_HELD = parseRgb(25, 158, 112);  // #199e70
const COL_PED = parseRgb(57, 135, 229);   // #3987e5
const COL_GRID = "#262623";
const COL_INK = "rgba(160, 158, 150, 0.72)";

export class PianoView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {(note: number, vel: number) => void} [opts.onUserNoteOn]
   * @param {(note: number) => void} [opts.onUserNoteOff]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onUserNoteOn = opts.onUserNoteOn || (() => {});
    this.onUserNoteOff = opts.onUserNoteOff || (() => {});

    this.showRoll = true;
    this.rollSecs = 6.0;
    this.glowSecs = 0.45;
    this.labelCs = true;
    this.bassSplit = BASS_SPLIT;

    this.heldNotes = new Map();  // note -> velocity
    this.sustained = new Map();  // note -> velocity
    this.glowing = new Map();    // note -> { vel, releasedAt }
    this.pedalDown = false;
    this.roll = [];              // { note, vel, tOn, tOff }
    this.openBar = new Map();    // note -> bar object
    this.count = 0;
    this.lastName = "";

    this.activePointers = new Map(); // pointerId -> note
    this.width = 1000;
    this.height = 300;
    this.dpr = 1;

    this._bindEvents();
    this.resize();
  }

  setBassSplit(split) {
    this.bassSplit = Number(split);
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  _keyRect(num, x0, y0, w, h) {
    const ww = w / N_WHITE;
    if (IS_BLACK[num]) {
      const bw = ww * 0.64;
      return {
        x: x0 + WHITE_BELOW[num] * ww - bw * 0.5,
        y: y0,
        w: bw,
        h: h * 0.62,
      };
    }
    return {
      x: x0 + WHITE_BELOW[num] * ww,
      y: y0,
      w: Math.max(1, ww - 1),
      h,
    };
  }

  _layout(w, h) {
    const zoneH = 18;
    const keyH = this.showRoll ? Math.min(165, Math.max(96, h * 0.48)) : h - zoneH;
    const rollTop = 4;
    const rollH = this.showRoll ? Math.max(0, h - keyH - zoneH - rollTop) : 0;
    const zoneY = rollTop + rollH;
    const keyY = zoneY + zoneH;
    return { keyH, rollTop, rollH, zoneY, zoneH, keyY };
  }

  _hitTest(px, py) {
    const { keyH, keyY } = this._layout(this.width, this.height);
    if (py < keyY || py > keyY + keyH) return null;

    // Black keys sit on top, check them first
    for (let num = LO; num <= HI; num++) {
      if (!IS_BLACK[num]) continue;
      const r = this._keyRect(num, 0, keyY, this.width, keyH);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        const relY = Math.min(1, Math.max(0, (py - r.y) / r.h));
        return { note: num, vel: 0.42 + 0.53 * relY };
      }
    }
    for (let num = LO; num <= HI; num++) {
      if (IS_BLACK[num]) continue;
      const r = this._keyRect(num, 0, keyY, this.width, keyH);
      if (px >= r.x && px <= r.x + r.w + 1 && py >= r.y && py <= r.y + r.h) {
        const relY = Math.min(1, Math.max(0, (py - r.y) / r.h));
        return { note: num, vel: 0.38 + 0.57 * relY };
      }
    }
    return null;
  }

  _bindEvents() {
    if (!this.canvas) return;
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.canvas);
    }

    const posFromEvent = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      return [ev.clientX - rect.left, ev.clientY - rect.top];
    };

    this.canvas.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 && ev.pointerType === "mouse") return;
      ev.preventDefault();
      this.canvas.setPointerCapture(ev.pointerId);
      const [px, py] = posFromEvent(ev);
      const hit = this._hitTest(px, py);
      if (hit) {
        this.activePointers.set(ev.pointerId, hit.note);
        this.onUserNoteOn(hit.note, hit.vel);
      }
    });

    this.canvas.addEventListener("pointermove", (ev) => {
      if (!this.activePointers.has(ev.pointerId)) return;
      const prev = this.activePointers.get(ev.pointerId);
      const [px, py] = posFromEvent(ev);
      const hit = this._hitTest(px, py);
      const nextNote = hit ? hit.note : null;
      if (nextNote !== prev) {
        if (prev !== null && prev !== undefined) {
          this.onUserNoteOff(prev);
        }
        if (nextNote !== null) {
          this.activePointers.set(ev.pointerId, nextNote);
          this.onUserNoteOn(nextNote, hit.vel);
        } else {
          this.activePointers.set(ev.pointerId, null);
        }
      }
    });

    const releasePointer = (ev) => {
      if (!this.activePointers.has(ev.pointerId)) return;
      const prev = this.activePointers.get(ev.pointerId);
      this.activePointers.delete(ev.pointerId);
      if (prev !== null && prev !== undefined) {
        this.onUserNoteOff(prev);
      }
    };

    this.canvas.addEventListener("pointerup", releasePointer);
    this.canvas.addEventListener("pointercancel", releasePointer);
  }

  noteOn(num, vel, nowSec = performance.now() / 1000) {
    const v = Number(vel ?? 0.7);
    if (num < LO || num > HI) return;
    if (v <= 0) {
      this.noteOff(num, nowSec);
      return;
    }
    this.heldNotes.set(num, v);
    this.sustained.delete(num);
    this.glowing.delete(num);
    this.count += 1;
    this.lastName = noteName(num);

    const prevBar = this.openBar.get(num);
    if (prevBar) prevBar.tOff = nowSec;
    const bar = { note: num, vel: v, tOn: nowSec, tOff: null };
    this.roll.push(bar);
    this.openBar.set(num, bar);
  }

  noteOff(num, nowSec = performance.now() / 1000) {
    const v = this.heldNotes.get(num);
    if (v === undefined) return;
    this.heldNotes.delete(num);
    if (this.pedalDown) {
      this.sustained.set(num, v);
    } else {
      this.glowing.set(num, { vel: v, releasedAt: nowSec });
      const bar = this.openBar.get(num);
      if (bar) {
        bar.tOff = nowSec;
        this.openBar.delete(num);
      }
    }
  }

  setPedal(down, nowSec = performance.now() / 1000) {
    this.pedalDown = Boolean(down);
    if (!this.pedalDown) {
      for (const [n, v] of this.sustained.entries()) {
        this.glowing.set(n, { vel: v ?? 0.7, releasedAt: nowSec });
        const bar = this.openBar.get(n);
        if (bar) {
          bar.tOff = nowSec;
          this.openBar.delete(n);
        }
      }
      this.sustained.clear();
    }
  }

  clearRoll() {
    this.roll = [];
    this.openBar.clear();
  }

  panic() {
    this.heldNotes.clear();
    this.sustained.clear();
    this.glowing.clear();
    this.pedalDown = false;
    this.openBar.clear();
  }

  _prune(nowSec) {
    const minTime = nowSec - this.rollSecs;
    let keepFrom = 0;
    while (keepFrom < this.roll.length) {
      const b = this.roll[keepFrom];
      if ((b.tOff ?? nowSec) >= minTime) break;
      keepFrom++;
    }
    if (keepFrom > 0) {
      // Also filter out any bars later in list that ended before minTime
      this.roll = this.roll.filter((b) => (b.tOff ?? nowSec) >= minTime);
    } else if (this.roll.length > 400) {
      this.roll = this.roll.filter((b) => (b.tOff ?? nowSec) >= minTime);
    }

    for (const [n, g] of this.glowing.entries()) {
      if (nowSec - g.releasedAt > this.glowSecs) {
        this.glowing.delete(n);
      }
    }
  }

  _bandSpanX(loNote, hiNote, w) {
    const r0 = this._keyRect(Math.max(LO, loNote), 0, 0, w, 1);
    const r1 = this._keyRect(Math.min(HI, hiNote), 0, 0, w, 1);
    return [r0.x, r1.x + r1.w];
  }

  render(nowSec = performance.now() / 1000) {
    const ctx = this.ctx;
    if (!ctx || this.width <= 0 || this.height <= 0) return;

    this._prune(nowSec);

    const w = this.width;
    const h = this.height;
    const { keyH, rollTop, rollH, zoneY, zoneH, keyY } = this._layout(w, h);

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, w, h);

    // 1. Scrolling Piano Roll
    if (this.showRoll && rollH > 16) {
      ctx.strokeStyle = COL_GRID;
      ctx.lineWidth = 1;
      for (let s = 1; s <= Math.floor(this.rollSecs); s++) {
        const y = rollTop + rollH - (s / this.rollSecs) * rollH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      for (const bar of this.roll) {
        const kr = this._keyRect(bar.note, 0, 0, w, 1);
        const t1 = bar.tOff ?? nowSec;
        const yBot = rollTop + rollH - ((nowSec - t1) / this.rollSecs) * rollH;
        const yTop = Math.max(rollTop, rollTop + rollH - ((nowSec - bar.tOn) / this.rollSecs) * rollH);
        const inset = IS_BLACK[bar.note] ? 0 : kr.w * 0.16;
        if (yBot > rollTop) {
          const alpha = 0.25 + 0.65 * bar.vel;
          ctx.fillStyle = bar.note <= this.bassSplit
            ? `rgba(245, 174, 70, ${alpha})`
            : bar.note >= TREBLE_SPLIT
              ? `rgba(126, 200, 255, ${alpha})`
              : `rgba(25, 158, 112, ${alpha})`;
          ctx.fillRect(
            kr.x + inset,
            yTop,
            Math.max(2, kr.w - inset * 2),
            Math.max(2, yBot - yTop)
          );
        }
      }
    }

    // 2. Register Bands + Bass Steering Strip
    const zones = [
      { lo: LO, hi: BAND_LOW_MAX, label: "Low · Milky Way", col: "rgba(25, 158, 112, 0.22)", ink: "#68d8af" },
      { lo: BAND_LOW_MAX + 1, hi: BAND_MID_MAX, label: "Mid · Exoplanets", col: "rgba(57, 135, 229, 0.20)", ink: "#7db7f8" },
      { lo: BAND_MID_MAX + 1, hi: BAND_HIGH_MAX, label: "High · Galaxies", col: "rgba(176, 122, 238, 0.20)", ink: "#cca2ff" },
      { lo: TREBLE_SPLIT, hi: HI, label: "Treble C6+ · Deep Sky", col: "rgba(126, 200, 255, 0.24)", ink: "#9ad6ff" },
    ];
    ctx.font = "600 10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const z of zones) {
      const [x0, x1] = this._bandSpanX(z.lo, z.hi, w);
      ctx.fillStyle = z.col;
      ctx.fillRect(x0, zoneY, Math.max(0, x1 - x0 - 1), zoneH);
      if (x1 - x0 > 62) {
        ctx.fillStyle = z.ink;
        ctx.textAlign = "center";
        ctx.fillText(z.label, (x0 + x1) * 0.5, zoneY + zoneH * 0.5);
      }
    }
    if (this.bassSplit >= LO) {
      const [bx0, bx1] = this._bandSpanX(LO, Math.min(HI, this.bassSplit), w);
      ctx.fillStyle = "rgba(245, 174, 70, 0.34)";
      ctx.fillRect(bx0, zoneY, Math.max(0, bx1 - bx0), 4);
      if (bx1 - bx0 > 46) {
        ctx.fillStyle = "#f5be66";
        ctx.textAlign = "left";
        ctx.fillText(`Steer <=${noteName(this.bassSplit)}`, bx0 + 4, zoneY + zoneH * 0.52);
      }
    }

    ctx.strokeStyle = COL_INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, keyY);
    ctx.lineTo(w, keyY);
    ctx.stroke();

    // 3. White Keys
    ctx.lineWidth = 1;
    for (let num = LO; num <= HI; num++) {
      if (IS_BLACK[num]) continue;
      const r = this._keyRect(num, 0, keyY, w, keyH);
      const lit = this.heldNotes.get(num);
      const sus = this.sustained.get(num);
      const glow = this.glowing.get(num);

      let col = `rgb(${COL_WHITE[0]},${COL_WHITE[1]},${COL_WHITE[2]})`;
      if (lit !== undefined) {
        col = blendRgb(COL_WHITE, COL_HELD, 0.35 + 0.65 * lit);
      } else if (sus !== undefined) {
        col = blendRgb(COL_WHITE, COL_PED, 0.30 + 0.50 * sus);
      } else if (glow !== undefined) {
        const f = 1 - (nowSec - glow.releasedAt) / this.glowSecs;
        if (f > 0) col = blendRgb(COL_WHITE, COL_HELD, 0.55 * glow.vel * f);
      }

      ctx.fillStyle = col;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = COL_EDGE;
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      if (num <= this.bassSplit) {
        ctx.fillStyle = "rgba(245, 174, 70, 0.45)";
        ctx.fillRect(r.x, r.y, r.w, 3);
      }

      if (this.labelCs && num % 12 === 0 && r.w >= 9) {
        ctx.fillStyle = "#6e6d68";
        ctx.font = "600 9px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(noteName(num), r.x + r.w * 0.5, r.y + r.h - 4);
      }
    }

    // 4. Black Keys
    for (let num = LO; num <= HI; num++) {
      if (!IS_BLACK[num]) continue;
      const r = this._keyRect(num, 0, keyY, w, keyH);
      const lit = this.heldNotes.get(num);
      const sus = this.sustained.get(num);
      const glow = this.glowing.get(num);

      let col = `rgb(${COL_BLACK[0]},${COL_BLACK[1]},${COL_BLACK[2]})`;
      if (lit !== undefined) {
        col = blendRgb(COL_BLACK, COL_HELD, 0.45 + 0.55 * lit);
      } else if (sus !== undefined) {
        col = blendRgb(COL_BLACK, COL_PED, 0.40 + 0.45 * sus);
      } else if (glow !== undefined) {
        const f = 1 - (nowSec - glow.releasedAt) / this.glowSecs;
        if (f > 0) col = blendRgb(COL_BLACK, COL_HELD, 0.70 * glow.vel * f);
      }

      ctx.fillStyle = col;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = COL_EDGE;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    ctx.restore();
  }
}
