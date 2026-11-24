// Web MIDI live hardware input manager + .score CSV & Standard MIDI File (.mid) parsers.
// The .mid parser is a faithful port of Songs/mid_to_score.py.

import { BASS_SPLIT, NOTE_NAMES, OUTWARD, PITCH_BODY, noteName } from "./constants.js";

const DRUM_CHANNEL = 9;
const SUSTAIN_CC = 64;
const DEFAULT_TEMPO = 500000;
const DOUBLING_S = 0.03;
const MIN_NOTE_S = 0.03;

// ---------------------------------------------------------------------
// Live Web MIDI input manager
// ---------------------------------------------------------------------

export class MidiManager {
  constructor(opts = {}) {
    this.onNoteOn = opts.onNoteOn || (() => {});
    this.onNoteOff = opts.onNoteOff || (() => {});
    this.onPedal = opts.onPedal || (() => {});
    this.onDevicesChange = opts.onDevicesChange || (() => {});
    this.onLog = opts.onLog || (() => {});

    this.access = null;
    this.selectedId = "all";
    this.verbose = Boolean(opts.verbose ?? false);
    this._recentNoteOn = new Map(); // note -> { timeMs, vel, inputId }
    this.supported =
      typeof navigator !== "undefined" &&
      typeof navigator.requestMIDIAccess === "function";
    this._boundHandler = (ev) => this._handleMidiMessage(ev);
  }

  async init() {
    if (!this.supported) {
      this.onLog(
        "warn",
        "Web MIDI is not supported in this browser (use Chrome, Edge, Opera, or Firefox for hardware MIDI; automated scores and on-screen keys work everywhere)."
      );
      this.onDevicesChange([]);
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => {
        this._bindInputs();
      };
      this._bindInputs();
      return true;
    } catch (err) {
      this.onLog("warn", `Web MIDI access denied or unavailable: ${err.message || err}`);
      this.onDevicesChange([]);
      return false;
    }
  }

  setSelectedInput(id) {
    this.selectedId = id || "all";
    this._bindInputs();
  }

  getInputs() {
    if (!this.access) return [];
    const list = [];
    for (const input of this.access.inputs.values()) {
      list.push({
        id: input.id,
        name: input.name || `MIDI Input ${list.length + 1}`,
        manufacturer: input.manufacturer || "",
        state: input.state,
      });
    }
    return list;
  }

  _bindInputs() {
    if (!this.access) return;
    const devices = [];
    for (const input of this.access.inputs.values()) {
      const active = this.selectedId === "all" || input.id === this.selectedId;
      input.onmidimessage = active ? this._boundHandler : null;
      devices.push({
        id: input.id,
        name: input.name || `MIDI Input ${devices.length + 1}`,
        manufacturer: input.manufacturer || "",
        state: input.state,
      });
    }
    this.onDevicesChange(devices);
  }

  _handleMidiMessage(ev) {
    const data = ev?.data;
    if (!data || data.length === 0) return;

    const statusByte = data[0];
    // Ignore system common / realtime messages (e.g. 0xF8 clock, 0xFE active sensing)
    if (statusByte >= 0xf0) return;

    const status = statusByte & 0xf0;
    const ch = statusByte & 0x0f;
    if (status !== 0x80 && status !== 0x90 && status !== 0xb0) return;
    if (data.length < 3) return;

    const d1 = data[1];
    const d2 = data[2];
    const inputId = ev.target?.id || ev.currentTarget?.id || "unknown";
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();

    if (status === 0x90) {
      if (d2 === 0) {
        if (this.verbose) {
          this.onLog("info", `[MIDI] ch${ch + 1} NoteOff ${noteName(d1)} (${d1}) vel=0`);
        }
        this.onNoteOff(d1);
      } else {
        if (this.selectedId === "all") {
          const prev = this._recentNoteOn.get(d1);
          if (
            prev &&
            prev.inputId !== inputId &&
            prev.vel === d2 &&
            nowMs - prev.timeMs < 8
          ) {
            return;
          }
        }
        this._recentNoteOn.set(d1, { timeMs: nowMs, vel: d2, inputId });
        if (this.verbose) {
          this.onLog(
            "info",
            `[MIDI] ch${ch + 1} NoteOn ${noteName(d1)} (${d1}) vel=${d2} (${(d2 / 127).toFixed(3)})`
          );
        }
        this.onNoteOn(d1, d2 / 127.0);
      }
    } else if (status === 0x80) {
      if (this.verbose) {
        this.onLog("info", `[MIDI] ch${ch + 1} NoteOff ${noteName(d1)} (${d1})`);
      }
      this.onNoteOff(d1);
    } else if (status === 0xb0 && d1 === SUSTAIN_CC) {
      if (this.verbose) {
        this.onLog("info", `[MIDI] ch${ch + 1} Sustain ${d2 > 63 ? "Down" : "Up"} (${d2})`);
      }
      this.onPedal(d2 > 63);
    }
  }
}

// ---------------------------------------------------------------------
// .score CSV parser & overlap sanitizer
// ---------------------------------------------------------------------

/**
 * Sanitize an event stream so every pitch strictly alternates on -> off:
 * collapses same-pitch doublings within DOUBLING_S, inserts an explicit off
 * before legitimate overlapping re-strikes, drops orphaned offs, closes
 * hanging notes, and stretches/drops sub-MIN_NOTE_S slivers.
 */
export function sanitizeScoreEvents(events) {
  if (!events || events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.t - b.t);

  let out = [];
  const count = new Map();
  const began = new Map();

  for (const ev of sorted) {
    if (ev.kind === "ped") {
      out.push({ t: ev.t, kind: "ped", note: ev.note, vel: 0.0 });
      continue;
    }
    const note = ev.note;
    const n = count.get(note) || 0;
    if (ev.kind === "off") {
      if (n === 1) {
        count.delete(note);
        out.push({ t: ev.t, kind: "off", note, vel: 0.0 });
      } else if (n > 1) {
        count.set(note, n - 1);
      }
      continue;
    }
    if (ev.kind !== "on") continue;

    if (n && ev.t - (began.get(note) ?? -100) < DOUBLING_S) {
      count.set(note, n + 1);
      continue;
    }
    if (n) {
      out.push({ t: ev.t, kind: "off", note, vel: 0.0 });
    }
    count.set(note, n + 1);
    began.set(note, ev.t);
    out.push({ t: ev.t, kind: "on", note, vel: ev.vel });
  }

  if (count.size > 0 && out.length > 0) {
    const last = out.reduce((m, e) => (e.t > m ? e.t : m), 0) + 0.25;
    for (const note of Array.from(count.keys()).sort((a, b) => a - b)) {
      out.push({ t: last, kind: "off", note, vel: 0.0 });
    }
  }

  const openAt = new Map();
  const nxtOn = new Map();
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    if (e.kind === "on") {
      nxtOn.set(i, openAt.has(e.note) ? openAt.get(e.note) : null);
      openAt.set(e.note, e.t);
    }
  }
  openAt.clear();
  const stretch = new Map();
  const drop = new Set();
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.kind === "on") {
      openAt.set(e.note, i);
    } else if (e.kind === "off" && openAt.has(e.note)) {
      const j = openAt.get(e.note);
      openAt.delete(e.note);
      if (e.t - out[j].t < MIN_NOTE_S) {
        const nextT = nxtOn.get(j);
        const limit = nextT !== null && nextT !== undefined ? nextT : Infinity;
        if (limit - out[j].t < MIN_NOTE_S) {
          drop.add(i);
          drop.add(j);
        } else {
          stretch.set(i, Math.min(limit, out[j].t + MIN_NOTE_S));
        }
      }
    }
  }
  if (stretch.size > 0 || drop.size > 0) {
    out = out
      .map((e, i) => (drop.has(i) ? null : stretch.has(i) ? { ...e, t: stretch.get(i) } : e))
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
  }

  return out;
}

export function parseScoreText(text) {
  const events = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const ln = raw.trim();
    if (ln.length <= 4 || ln.startsWith("#")) continue;
    const parts = ln.split(",");
    if (parts.length < 4) continue;
    const t = Number.parseFloat(parts[0]);
    const kind = parts[1].trim();
    const note = Number.parseInt(parts[2], 10);
    const vel = Number.parseFloat(parts[3]);
    if (!Number.isFinite(t) || !Number.isFinite(note)) continue;
    if (kind !== "on" && kind !== "off" && kind !== "ped") continue;
    events.push({
      t,
      kind,
      note,
      vel: Number.isFinite(vel) ? vel : 0,
    });
  }
  return sanitizeScoreEvents(events);
}

// ---------------------------------------------------------------------
// Standard MIDI File (.mid) parser (ported from Songs/mid_to_score.py)
// ---------------------------------------------------------------------

class ByteReader {
  constructor(uint8) {
    this.d = uint8;
    this.i = 0;
  }

  u8() {
    if (this.i >= this.d.length) throw new Error("Unexpected end of MIDI file");
    return this.d[this.i++];
  }

  u16() {
    const v = (this.u8() << 8) | this.u8();
    return v >>> 0;
  }

  i16() {
    const u = this.u16();
    return u & 0x8000 ? u - 0x10000 : u;
  }

  u32() {
    const b0 = this.u8();
    const b1 = this.u8();
    const b2 = this.u8();
    const b3 = this.u8();
    return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  }

  take(n) {
    const slice = this.d.subarray(this.i, this.i + n);
    this.i += n;
    return slice;
  }

  ascii(n) {
    let s = "";
    const bytes = this.take(n);
    for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
    return s;
  }

  vlq() {
    let v = 0;
    while (true) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
  }
}

function secondsOf(division, tempoMap) {
  if (division < 0) {
    const fps = -(division >> 8);
    const sub = division & 0xff;
    const perTick = 1.0 / (fps * sub);
    return (t) => t * perTick;
  }

  const tpq = division || 480;
  let marks = tempoMap.length > 0 ? [...tempoMap] : [[0, DEFAULT_TEMPO]];
  if (marks[0][0] > 0) {
    marks = [[0, DEFAULT_TEMPO], ...marks];
  }

  const table = [];
  let acc = 0.0;
  for (let i = 0; i < marks.length; i++) {
    const [tick, upq] = marks[i];
    table.push([tick, acc, upq]);
    if (i + 1 < marks.length) {
      acc += ((marks[i + 1][0] - tick) * (upq / 1e6)) / tpq;
    }
  }

  return (t) => {
    let lo = 0;
    for (let j = 0; j < table.length; j++) {
      if (table[j][0] <= t) lo = j;
      else break;
    }
    const [tick, base, upq] = table[lo];
    return base + ((t - tick) * (upq / 1e6)) / tpq;
  };
}

export function parseMidiFile(arrayBuffer, opts = {}) {
  const drums = Boolean(opts.drums ?? false);
  const bassOctaves = Number(opts.bassOctaves ?? 0) | 0;
  const bassBoundary = Number(opts.bassBoundary ?? 60);
  const transpose = Number(opts.transpose ?? 0) | 0;
  const channels = opts.channels ? new Set(opts.channels) : null;

  const raw = new Uint8Array(arrayBuffer);
  const r = new ByteReader(raw);
  if (r.ascii(4) !== "MThd") {
    throw new Error("Not a valid MIDI file (missing MThd header)");
  }
  const hdrLen = r.u32();
  const fmt = r.u16();
  const ntracks = r.u16();
  const division = r.i16();
  r.i += Math.max(0, hdrLen - 6);

  const rawEvents = [];
  const tempoMap = [];

  for (let tIdx = 0; tIdx < ntracks; tIdx++) {
    while (
      r.i + 4 <= raw.length &&
      !(
        raw[r.i] === 0x4d &&
        raw[r.i + 1] === 0x54 &&
        raw[r.i + 2] === 0x72 &&
        raw[r.i + 3] === 0x6b
      )
    ) {
      r.i += 1;
    }
    if (r.i + 4 > raw.length) break;
    r.take(4);
    const length = r.u32();
    const end = Math.min(raw.length, r.i + length);
    let tick = 0;
    let status = null;

    while (r.i < end) {
      tick += r.vlq();
      if (r.i >= end) break;
      const b = r.d[r.i];
      if (b === 0xff) {
        r.u8();
        const mtype = r.u8();
        const n = r.vlq();
        const data = r.take(n);
        if (mtype === 0x51 && n === 3) {
          tempoMap.push([tick, (data[0] << 16) | (data[1] << 8) | data[2]]);
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.u8();
        r.take(r.vlq());
        continue;
      }
      if (b & 0x80) {
        status = r.u8();
      } else if (status === null) {
        throw new Error("Invalid MIDI stream: data byte before status byte");
      }

      const hi = status & 0xf0;
      const ch = status & 0x0f;
      if (hi === 0x80 || hi === 0x90 || hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        const a = r.u8();
        const b2 = r.u8();
        if (hi === 0x90) {
          rawEvents.push({ tick, kind: b2 === 0 ? "off" : "on", a, b: b2, ch });
        } else if (hi === 0x80) {
          rawEvents.push({ tick, kind: "off", a, b: b2, ch });
        } else if (hi === 0xb0) {
          rawEvents.push({ tick, kind: "cc", a, b: b2, ch });
        }
      } else if (hi === 0xc0 || hi === 0xd0) {
        r.u8();
      } else {
        throw new Error(`Unknown MIDI status byte 0x${status.toString(16)}`);
      }
    }
    r.i = end;
  }

  tempoMap.sort((a, b) => a[0] - b[0]);
  const toSec = secondsOf(division, tempoMap);

  rawEvents.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    return (a.kind === "cc" ? 1 : 0) - (b.kind === "cc" ? 1 : 0);
  });

  let out = [];
  let moved = 0;
  const count = new Map();
  const struck = new Map();
  const began = new Map();

  for (const ev of rawEvents) {
    if (ev.ch === DRUM_CHANNEL && !drums) continue;
    if (channels && !channels.has(ev.ch)) continue;
    const t = toSec(ev.tick);

    if (ev.kind === "cc") {
      if (ev.a === SUSTAIN_CC) {
        out.push({ t, kind: "ped", note: ev.b > 63 ? 1 : 0, vel: 0.0 });
      }
      continue;
    }

    let note = ev.a + transpose;
    if (bassOctaves && note < bassBoundary) {
      note -= 12 * bassOctaves;
      moved += 1;
    }
    note = Math.max(0, Math.min(127, note));

    const n = count.get(note) || 0;
    if (ev.kind === "off") {
      if (n === 1) {
        count.delete(note);
        out.push({ t, kind: "off", note, vel: 0.0 });
      } else if (n > 1) {
        count.set(note, n - 1);
      }
      continue;
    }

    const vel = Math.round((ev.b / 127.0) * 10000) / 10000;
    const key = `${ev.ch}:${note}`;
    if (n && struck.get(key) === ev.tick) {
      continue;
    }
    struck.set(key, ev.tick);
    if (n && t - (began.get(note) ?? -100) < DOUBLING_S) {
      count.set(note, n + 1);
      continue;
    }
    if (n) {
      out.push({ t, kind: "off", note, vel: 0.0 });
    }
    count.set(note, n + 1);
    began.set(note, t);
    out.push({ t, kind: "on", note, vel });
  }

  if (count.size > 0 && out.length > 0) {
    const last = out.reduce((m, e) => (e.t > m ? e.t : m), 0) + 0.25;
    for (const note of Array.from(count.keys()).sort((a, b) => a - b)) {
      out.push({ t: last, kind: "off", note, vel: 0.0 });
    }
  }

  // Stretch ultra-short notes to MIN_NOTE_S or drop doubled zero-length artifacts
  const openAt = new Map();
  const nxtOn = new Map();
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    if (e.kind === "on") {
      nxtOn.set(i, openAt.has(e.note) ? openAt.get(e.note) : null);
      openAt.set(e.note, e.t);
    }
  }
  openAt.clear();
  const stretch = new Map();
  const drop = new Set();
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.kind === "on") {
      openAt.set(e.note, i);
    } else if (e.kind === "off" && openAt.has(e.note)) {
      const j = openAt.get(e.note);
      openAt.delete(e.note);
      if (e.t - out[j].t < MIN_NOTE_S) {
        const nextT = nxtOn.get(j);
        const limit = nextT !== null && nextT !== undefined ? nextT : Infinity;
        if (limit - out[j].t < MIN_NOTE_S) {
          drop.add(i);
          drop.add(j);
        } else {
          stretch.set(i, Math.min(limit, out[j].t + MIN_NOTE_S));
        }
      }
    }
  }
  if (stretch.size > 0 || drop.size > 0) {
    out = out
      .map((e, i) => (drop.has(i) ? null : stretch.has(i) ? { ...e, t: stretch.get(i) } : e))
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
  }

  return {
    events: out,
    moved,
    fmt,
    division,
    tempoChanges: tempoMap.length,
    stats: computeScoreStats(out),
  };
}

export function computeScoreStats(events, bassSplit = BASS_SPLIT) {
  const ons = events.filter((e) => e.kind === "on");
  if (ons.length === 0) {
    return {
      noteCount: 0,
      duration: 0,
      minNote: null,
      maxNote: null,
      rangeText: "--",
      trebleCount: 0,
      pedalCount: 0,
      steerPct: 0,
      destinations: [],
    };
  }
  const duration = events.reduce((m, e) => (e.t > m ? e.t : m), 0);
  let minNote = 127;
  let maxNote = 0;
  let trebleCount = 0;
  for (const e of ons) {
    if (e.note < minNote) minNote = e.note;
    if (e.note > maxNote) maxNote = e.note;
    if (e.note >= 84) trebleCount++;
  }
  const pedalCount = events.filter((e) => e.kind === "ped").length;

  const down = new Set();
  let prevT = 0.0;
  let steerTime = 0.0;
  const perPc = new Map();
  for (const e of events) {
    if (down.size > 0 && e.t > prevT) {
      let lo = 127;
      for (const n of down) if (n < lo) lo = n;
      if (lo <= bassSplit) {
        const span = e.t - prevT;
        steerTime += span;
        const pc = lo % 12;
        perPc.set(pc, (perPc.get(pc) || 0) + span);
      }
    }
    if (e.kind === "on") down.add(e.note);
    else if (e.kind === "off") down.delete(e.note);
    prevT = e.t;
  }

  const destinations = Array.from(perPc.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([pc, sec]) => ({
      pc,
      note: NOTE_NAMES[pc],
      body: PITCH_BODY[pc] === OUTWARD ? "outward" : PITCH_BODY[pc],
      sec,
    }));

  return {
    noteCount: ons.length,
    duration,
    minNote,
    maxNote,
    rangeText: `${noteName(minNote)} to ${noteName(maxNote)}`,
    trebleCount,
    pedalCount,
    steerPct: duration > 0 ? Math.round((100 * steerTime) / duration) : 0,
    destinations,
  };
}
