// OpenSpace mapping & state machine, ported from openspace_bridge.py.
// Drives camera navigation, tour / bass steering, focus lock, 80 latched
// scene layers, point-cloud register breathing, and simulation time speed.

import {
  ARRIVE,
  BAND_OF,
  BASS_HOLD,
  BASS_REDIRECT,
  BASS_SPLIT,
  CAMERA,
  DRIFT_AFTER,
  DRIFT_DEADBAND,
  DRIFT_EASE,
  DRIFT_MAX,
  DRIFT_TIME,
  DRIVE_LAYERS,
  DRIVE_TIME,
  DUTY,
  ELEVATION_GAIN,
  ENABLE_AT,
  FADE_IN,
  FADE_OUT,
  HOLD_AFTER_STOP,
  IDLE_FLOOR,
  LABEL_SWEEPS,
  LAYERS,
  LAYER_EPS,
  LAYER_PACE,
  LOCK_APPROACH,
  LOCK_ARRIVED_GAP,
  LOCK_EASE,
  LOCK_RATE_MAX,
  NOTE_KICK,
  NOTE_NAMES,
  OPACITY_MAX,
  OPACITY_MIN,
  ORBIT_RATE,
  OUTWARD,
  PACE_MAX,
  PACE_MIN,
  PITCH_BODY,
  PROBE_RETRY_WAIT,
  PROBE_TIMEOUT,
  PROBE_TRIES,
  RETARGET_TIME,
  RETARGET_URI,
  ROLL_GAIN,
  ROLL_HZ,
  SCALARS,
  SCALAR_EPS,
  SCREEN_TEXT,
  SIZED,
  SIZE_CEILING,
  SIZE_LAG,
  SIZE_MAX,
  SIZE_MIN,
  SIZE_SOURCE,
  SLOW_ELEVATION_GAIN,
  SLOW_MAX_ROT,
  SLOW_ORBIT_RATE,
  SLOW_RETARGET_TIME,
  SLOW_ROLL_GAIN,
  TELEMETRY_EVERY,
  TELEMETRY_TIMEOUT,
  TICK,
  TIME_BUILD_SECS,
  TIME_BUILD_SHARE,
  TIME_CHORD_WEIGHT,
  TIME_CHORD_WINDOW,
  TIME_CURVE,
  TIME_DECAY_SECS,
  TIME_EPS,
  TIME_EVERY,
  TIME_GAIN,
  TIME_INTERP,
  TIME_LAG_DOWN,
  TIME_LAG_UP,
  TIME_MAX,
  TIME_MIN,
  TIME_ONSET_MAX,
  TIME_ONSET_WINDOW,
  TIME_SOURCE,
  TOUR,
  TOUR_DWELL,
  TOUR_FINAL,
  TOUR_MIDPOINT,
  TREBLE_BOOST,
  TREBLE_LAG,
  TRUCK_GAIN,
  formatRate,
  formatSI,
  luaNum,
  luaStr,
  smoothstep,
} from "./constants.js";
import { allNumbers } from "./openspace_link.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDefaultConfig() {
  return {
    mode: "normal", // "normal" | "slow" | "time-only"
    slow: false,
    timeOnly: false,
    camera: CAMERA,
    layers: DRIVE_LAYERS,
    noSizes: false,
    time: DRIVE_TIME,
    tour: true,
    bass: true,
    bassSplit: BASS_SPLIT,
    keepLabels: false,
    hideScreenText: false,
    dryRun: false,
    noProbe: false,
    verbose: false,

    truckGain: TRUCK_GAIN,
    elevationGain: ELEVATION_GAIN,
    rollGain: ROLL_GAIN,
    retargetTime: RETARGET_TIME,
    layerPace: LAYER_PACE,
    hold: HOLD_AFTER_STOP,

    sizeSource: SIZE_SOURCE,
    sizeMin: SIZE_MIN,
    sizeMax: SIZE_MAX,
    trebleBoost: TREBLE_BOOST,

    timeSource: TIME_SOURCE,
    timeMin: TIME_MIN,
    timeMax: TIME_MAX,
    timeGain: TIME_GAIN,
    timeCurve: TIME_CURVE,
    timeBuild: TIME_BUILD_SECS,
    timeDecay: TIME_DECAY_SECS,

    tourMidpoint: TOUR_MIDPOINT,
    lockFocus: null,
    lockApproach: LOCK_APPROACH,
    lockDistance: 0.0,
    orbitRate: ORBIT_RATE,

    driftTime: DRIFT_TIME,
    driftAfter: DRIFT_AFTER,
    idleFloor: IDLE_FLOOR,
  };
}

export class OpenSpaceBridge {
  /**
   * @param {import('./openspace_link.js').OpenSpaceLink} link
   * @param {object} [opts]
   * @param {Partial<ReturnType<typeof createDefaultConfig>>} [opts.config]
   * @param {(level: string, msg: string) => void} [opts.onLog]
   */
  constructor(link, opts = {}) {
    this.link = link;
    this.onLog = opts.onLog || (() => {});
    this.config = { ...createDefaultConfig(), ...(opts.config || {}) };
    if (this.config.mode && this.config.mode !== "normal") {
      this.applyModePreset(this.config.mode);
    }

    this.values = {};
    this.layers = {};
    this.notes = [];

    this.layerUri = new Map();
    this.layerLive = new Map();
    for (const l of LAYERS) {
      this.layerUri.set(l.name, l.uri);
      this.layerLive.set(l.name, true);
    }
    this.layerEnabled = new Map();

    this.progress = 0.0;
    this.unlocked = [];
    this.unlockedSet = new Set();
    this.ramp = new Map();
    this.stoppedAt = null;

    this.sizeBase = new Map();
    this.sizeVal = 0.0;
    this.bandVal = { bandLow: 0.0, bandMid: 0.0, bandHigh: 0.0, treble: 0.0 };
    this.opacityLive = new Set();
    this.lastOpacity = new Map();
    this.lastSize = new Map();

    this.scalarUri = new Map();
    this.scalarRange = new Map();
    this.lastLayer = new Map();
    this.lastScalar = new Map();

    this.retargetWas = null;
    this.timeLive = false;
    this.timeWas = null;
    this.timeVal = 0.0;
    this.timeBuild = 0.0;
    this.timeOnsets = []; // { t, weight }
    this.timeLastOnset = -100.0;
    this.timeSeenNotes = false;
    this.timeRate = null;
    this.timeSentAt = 0.0;

    this.hasInput = false;
    this.lastInputAt = 0.0;
    this.t0 = null;

    this.lastActive = null;
    this.drifting = false;
    this.driftRate = 0.0;

    // Tour state
    this.tourStops = [...TOUR];
    this.current = TOUR[0];
    this.target = null;
    this.phase = "out"; // "out" | "in" | "final"
    this.bodies = new Set();

    // Focus lock
    this.lockWant = this.config.lockFocus || null;
    this.lockNode = null;
    this.lockSince = 0.0;
    this.lockArrived = false;
    this.lockDist = null;
    this.lockRate = null;
    this.lockMissing = new Set();
    this._checkingLockBody = null;

    // Bass steering
    this.bassPc = null;
    this.bassRaw = null;
    this.bassSince = 0.0;
    this.bassHigh = null;
    this.redirectTo = null;
    this.redirectSince = 0.0;
    this.tourStarted = false;
    this.tourLastChange = 0.0;

    // Telemetry
    this.telDist = null;
    this.telSep = null;
    this.telSepFor = null; // [from, to]
    this.telSepPending = null;
    this.telTopic = null;
    this.telSent = 0.0;
    this.telStale = true;
    this.lastEmit = null;
    this.netEfolds = 0.0;

    this.probing = false;
    this._settingUpTime = false;
    this._sortedLayers = [...LAYERS].sort((a, b) => a.rank - b.rank);
  }

  /**
   * Apply a mode preset ("normal" | "slow" | "time-only").
   */
  applyModePreset(mode) {
    this.config.mode = mode;
    if (mode === "normal") {
      this.config.slow = false;
      this.config.timeOnly = false;
      this.config.camera = true;
      this.config.layers = true;
      this.config.noSizes = false;
      this.config.keepLabels = false;
      this.config.tour = true;
      this.config.elevationGain = ELEVATION_GAIN;
      this.config.rollGain = ROLL_GAIN;
      this.config.orbitRate = ORBIT_RATE;
      this.config.retargetTime = RETARGET_TIME;
    } else if (mode === "slow") {
      this.config.slow = true;
      this.config.timeOnly = false;
      this.config.camera = true;
      this.config.layers = true;
      this.config.noSizes = false;
      this.config.keepLabels = false;
      this.config.tour = true;
      this.config.elevationGain = Math.min(this.config.elevationGain, SLOW_ELEVATION_GAIN);
      this.config.rollGain = Math.min(this.config.rollGain, SLOW_ROLL_GAIN);
      const sign = this.config.orbitRate < 0 ? -1 : 1;
      this.config.orbitRate = Math.min(Math.abs(this.config.orbitRate), SLOW_ORBIT_RATE) * sign;
      if (this.config.retargetTime !== null && this.config.retargetTime > 0) {
        this.config.retargetTime = Math.max(this.config.retargetTime, SLOW_RETARGET_TIME);
      }
    } else if (mode === "time-only") {
      this.config.timeOnly = true;
      this.config.slow = false;
      this.config.camera = false;
      this.config.layers = false;
      this.config.noSizes = true;
      this.config.keepLabels = true;
      this.config.time = true;
      this.config.tour = false;
      this.config.lockFocus = null;
      this.lockWant = null;
    }
  }

  /**
   * Reset transient connection/probe caches before a new probe.
   */
  resetForConnect() {
    this.lastLayer.clear();
    this.lastScalar.clear();
    this.lastSize.clear();
    this.lastOpacity.clear();
    this.layerEnabled.clear();
    this.retargetWas = null;
    this.timeWas = null;
    this.timeRate = null;
    this.timeLive = false;
    this.telTopic = null;
    this.telStale = true;
    this.tourStarted = false;
    this.lockNode = null;
    this.lockArrived = false;
    this.lockRate = null;
    this._checkingLockBody = null;
  }

  async probe() {
    if (this.probing) return;
    this.probing = true;
    try {
      const a = this.config;
      if (a.dryRun || a.noProbe) {
        for (const [oscName, uris, lo, hi] of SCALARS) {
          this.scalarUri.set(oscName, uris[0]);
          this.scalarRange.set(oscName, [lo, hi]);
        }
        for (const l of LAYERS) {
          this.layerLive.set(l.name, true);
        }
        this.bodies = new Set([...TOUR, TOUR_FINAL, ...Object.values(PITCH_BODY).filter((b) => b !== OUTWARD)]);
        this.tourStops = a.camera && a.tour ? [...TOUR] : [];
        this.timeLive = Boolean(a.time);
        this.onLog("info", `Dry-run / no-probe active: all ${LAYERS.length} layers and tour bodies enabled`);
        return;
      }

      if (!a.layers) {
        for (const l of LAYERS) {
          this.layerLive.set(l.name, false);
        }
        this.onLog("info", "layers disabled -- leaving scene renderables as they are");
        if (!a.keepLabels) await this.hideText();
        if (a.camera && a.retargetTime !== null && a.retargetTime !== undefined) {
          await this.setRetarget(a.retargetTime);
        }
        if (a.time) await this.setupTime();
        if (!a.camera) {
          this.onLog("info", "camera movement disabled");
          this.tourStops = [];
          return;
        }
      } else {
        await this.probeLayers();
        if (!this.link.connected) return;
        if (!a.keepLabels) await this.hideText();
        if (!a.noSizes) await this.readSizeBaselines();
        if (a.camera && a.retargetTime !== null && a.retargetTime !== undefined) {
          await this.setRetarget(a.retargetTime);
        }
        if (a.time) await this.setupTime();
      }

      if (!a.camera) {
        this.onLog("info", "camera movement disabled");
        this.tourStops = [];
        return;
      }

      for (const [oscName, uris, lo, hi] of SCALARS) {
        let found = false;
        for (const uri of uris) {
          const n = await this.link.ask(`return #openspace.property(${luaStr(uri)})`);
          if (n && n > 0) {
            this.scalarUri.set(oscName, uri);
            this.scalarRange.set(oscName, [lo, hi]);
            found = true;
            break;
          }
        }
        if (!found) {
          this.onLog("warn", `no property found for '${oscName}' -- mapping skipped`);
        }
      }

      await this.probeTourBodies();
    } finally {
      this.probing = false;
    }
  }

  async probeLayers() {
    const uris = LAYERS.map((l) => `'${l.uri}.Fade'`).join(",");
    const script =
      `local u={${uris}} local r={} ` +
      `for i,v in ipairs(u) do ` +
      `local ok,n = pcall(function() return #openspace.property(v) end) ` +
      `r[i] = (ok and n) or 0 end return r`;

    let counts = null;
    for (let attempt = 1; attempt <= PROBE_TRIES; attempt++) {
      if (!this.link.connected) return;
      const got = await this.link.ask(script, PROBE_TIMEOUT, LAYERS.length);
      const good = Array.isArray(got) && got.length >= LAYERS.length && got.some((c) => c > 0);
      if (good) {
        counts = got;
        break;
      }
      if (attempt < PROBE_TRIES) {
        const why = got === null ? "no answer" : "nothing in the scene yet";
        this.onLog(
          "warn",
          `layer probe attempt ${attempt}: ${why} -- is OpenSpace still loading? retrying in ${PROBE_RETRY_WAIT}s`
        );
        await sleep(PROBE_RETRY_WAIT * 1000);
      }
    }

    if (!counts) {
      for (const l of LAYERS) this.layerLive.set(l.name, false);
      this.onLog("error", "layer probe failed -- ALL LAYERS DISABLED rather than written to blindly.");
      return;
    }

    const missing = [];
    for (let i = 0; i < LAYERS.length; i++) {
      const l = LAYERS[i];
      const live = counts[i] > 0;
      this.layerLive.set(l.name, live);
      if (!live) missing.push(l.name);
    }
    if (missing.length > 0) {
      this.onLog(
        "info",
        `${LAYERS.length - missing.length}/${LAYERS.length} layers live; not in this scene: ${missing.join(", ")}`
      );
    } else {
      this.onLog("info", `all ${LAYERS.length} layers live`);
    }
  }

  async readSizeBaselines() {
    const names = SIZED.filter((n) => this.layerLive.get(n));
    if (names.length === 0) return;

    const uris = names.map((n) => `${this.layerUri.get(n)}.Sizing.ScaleFactor`);
    const uList = uris.map((u) => `'${u}'`).join(",");
    const vals = await this.link.ask(
      `local u={${uList}} local r={} ` +
        `for i,v in ipairs(u) do ` +
        `if #openspace.property(v)>0 then r[i]=openspace.propertyValue(v) ` +
        `else r[i]=-1 end end return r`,
      15.0,
      uris.length
    );

    if (!Array.isArray(vals) || vals.length < uris.length) {
      this.onLog("warn", "could not read point-size baselines -- sizes left alone");
      return;
    }
    for (let i = 0; i < names.length; i++) {
      const v = vals[i];
      if (v >= 0.0) {
        this.sizeBase.set(names[i], v > 0.0 ? v : 1.0);
      }
    }

    const ouris = names.map((n) => `${this.layerUri.get(n)}.Opacity`);
    const oList = ouris.map((u) => `'${u}'`).join(",");
    const ohave = await this.link.ask(
      `local u={${oList}} local r={} for i,v in ipairs(u) do r[i]=#openspace.property(v) end return r`,
      15.0,
      ouris.length
    );
    if (Array.isArray(ohave) && ohave.length >= ouris.length) {
      this.opacityLive = new Set(names.filter((_, i) => ohave[i] > 0));
    } else {
      this.opacityLive = new Set();
      this.onLog("warn", "could not probe point opacity -- opacity left alone");
    }

    this.onLog(
      "info",
      `point sizes breathing on ${this.sizeBase.size} layers (opacity on ${this.opacityLive.size}), driven by ${this.config.sizeSource}`
    );
  }

  async hideText() {
    const patterns = [...LABEL_SWEEPS];
    if (this.config.hideScreenText) {
      patterns.push(...SCREEN_TEXT);
    }
    const pList = patterns.map((p) => `'${p}'`).join(",");
    const counts = await this.link.ask(
      `local u={${pList}} local r={} for i,v in ipairs(u) do r[i]=#openspace.property(v) end return r`,
      15.0,
      patterns.length
    );
    if (!Array.isArray(counts) || counts.length < patterns.length) {
      this.onLog("warn", "could not probe the label patterns -- text left as it is");
      return;
    }
    const applied = [];
    let total = 0;
    for (let i = 0; i < patterns.length; i++) {
      const n = counts[i];
      if (n > 0) {
        applied.push(`openspace.setPropertyValue(${luaStr(patterns[i])},false)`);
        total += Math.trunc(n);
      }
    }
    if (applied.length > 0) {
      this.link.lua(applied.join(";"), true);
    }
    this.onLog("info", `text hidden: ${total} properties across ${applied.length} patterns`);
  }

  async setRetarget(seconds) {
    if (!this.link.connected || this.config.dryRun) return;
    const n = await this.link.ask(`return #openspace.property(${luaStr(RETARGET_URI)})`);
    if (!n || n <= 0) {
      this.onLog("warn", `no RetargetAnchorInterpolationTime in this build -- ignored`);
      return;
    }
    if (this.retargetWas === null) {
      const was = await this.link.ask(`return openspace.propertyValue(${luaStr(RETARGET_URI)})`);
      if (typeof was === "number" && Number.isFinite(was)) {
        this.retargetWas = was;
      }
    }
    this.link.lua(`openspace.setPropertyValue(${luaStr(RETARGET_URI)},${luaNum(seconds)})`, true);
    const prev = this.retargetWas !== null ? `${this.retargetWas}s` : "unknown";
    this.onLog("info", `focus retarget time ${prev} -> ${seconds}s (restored on exit)`);
  }

  async setupTime() {
    if (this._settingUpTime) return;
    this._settingUpTime = true;
    try {
      if (this.config.dryRun || this.config.noProbe) {
        this.timeLive = true;
        return;
      }
      const was = await this.link.ask(
        "local ok,d = pcall(openspace.time.deltaTime) if ok then return d else return 'none' end"
      );
      if (typeof was !== "number" || !Number.isFinite(was)) {
        this.onLog("warn", "could not read openspace.time.deltaTime -- time speed left alone");
        return;
      }
      if (this.timeWas === null) {
        this.timeWas = was;
      }
      this.timeLive = true;
      this.onLog(
        "info",
        `time speed driven by ${this.config.timeSource}: ${formatRate(this.config.timeMin)} -> ${formatRate(this.config.timeMax)} (was ${formatRate(this.timeWas)})`
      );
      const paused = await this.link.ask(
        "local ok,p = pcall(openspace.time.isPaused) return (ok and p) and 1 or 0"
      );
      if (paused) {
        this.onLog("warn", "simulation time is PAUSED in OpenSpace -- unpause with Spacebar in OpenSpace");
      }
    } finally {
      this._settingUpTime = false;
    }
  }

  async probeTourBodies() {
    if (!this.config.tour) {
      this.tourStops = [];
      return;
    }
    const wantedSet = new Set([
      ...Object.values(PITCH_BODY),
      ...TOUR,
      TOUR_FINAL,
    ]);
    wantedSet.delete(OUTWARD);
    const wanted = Array.from(wantedSet);
    const uList = wanted.map((n) => `'${n}'`).join(",");
    const counts = await this.link.ask(
      `local u={${uList}} local r={} for i,v in ipairs(u) do r[i]=openspace.hasSceneGraphNode(v) and 1 or 0 end return r`,
      15.0,
      wanted.length
    );

    if (!Array.isArray(counts) || counts.length < wanted.length) {
      this.onLog("warn", "could not probe the tour bodies -- assuming all present");
      this.bodies = new Set(wanted);
    } else {
      this.bodies = new Set();
      const dropped = [];
      for (let i = 0; i < wanted.length; i++) {
        if (counts[i] > 0) this.bodies.add(wanted[i]);
        else dropped.push(wanted[i]);
      }
      if (dropped.length > 0) {
        this.onLog("info", `tour: ${dropped.join(", ")} not in this scene, skipped`);
      }
    }

    this.tourStops = TOUR.filter((n) => this.bodies.has(n));
    if (this.tourStops.length > 0) {
      this.onLog("info", `tour: ${this.tourStops.join(" -> ")} -> ${TOUR_FINAL} (outward)`);
    }
  }

  onNote(num, vel, nowSec) {
    this.hasInput = true;
    this.lastInputAt = nowSec;
    this.notes.push([num, vel]);
    this.timeSeenNotes = true;
    if (nowSec - this.timeLastOnset > TIME_CHORD_WINDOW) {
      this.timeOnsets.push({ t: nowSec, weight: 1.0 });
      this.timeLastOnset = nowSec;
    } else {
      this.timeOnsets.push({ t: nowSec, weight: TIME_CHORD_WEIGHT });
    }
  }

  setFocusLock(nodeOrNull) {
    if (!this.config.camera) return;
    if (nodeOrNull === null || nodeOrNull === undefined || nodeOrNull === false || nodeOrNull === "") {
      this.lockWant = null;
    } else {
      this.lockWant = String(nodeOrNull).trim() || null;
    }
  }

  resetLayers() {
    this.progress = 0.0;
    this.unlocked = [];
    this.unlockedSet.clear();
    this.stoppedAt = null;
  }

  async _checkLockBodyAsync(want) {
    if (this._checkingLockBody === want) return;
    this._checkingLockBody = want;
    try {
      if (this.bodies.has(want)) return;
      if (this.config.dryRun || this.config.noProbe) {
        this.bodies.add(want);
        return;
      }
      const got = await this.link.ask(
        `return openspace.hasSceneGraphNode(${luaStr(want)}) and 1 or 0`,
        5.0,
        1
      );
      const here = typeof got === "number" && Number.isFinite(got) && got > 0;
      if (here) {
        this.bodies.add(want);
      } else {
        if (!this.lockMissing.has(want)) {
          this.lockMissing.add(want);
          this.onLog("warn", `focus lock: no node called '${want}' in this scene -- ignored`);
        }
        if (this.lockWant === want) {
          this.lockWant = null;
        }
      }
    } finally {
      if (this._checkingLockBody === want) {
        this._checkingLockBody = null;
      }
    }
  }

  applyFocusLock(nowSec, nav) {
    const want = this.lockWant;
    if (want !== null) {
      if (!this.bodies.has(want)) {
        if (this.config.dryRun || this.config.noProbe) {
          this.bodies.add(want);
        } else {
          this._checkLockBodyAsync(want);
          return;
        }
      }
    }

    this.lockNode = want;
    if (want !== null) {
      this.lockSince = nowSec;
      this.lockArrived = false;
      nav.push(`openspace.navigation.setFocus(${luaStr(want)})`);
      this.current = want;
      this.target = null;
      this.redirectTo = null;
      this.phase = "in";
      this.telStale = true;
      this.lockRate = null;
      this.lockDist = this.config.lockDistance > 0 ? this.config.lockDistance : (ARRIVE[want] ?? null);
      if (this.lockDist) {
        this.onLog(
          "info",
          `focus lock -> ${want} (closing to ${(this.lockDist / 1e6).toFixed(1)} Mm over ${this.config.lockApproach}s)`
        );
      } else {
        this.onLog("info", `focus lock -> ${want} (turning over ${this.config.retargetTime}s)`);
      }
    } else {
      this.phase = "out";
      this.telStale = true;
      this.tourLastChange = nowSec;
      this.onLog("info", "focus lock released -- the itinerary steers again");
    }
  }

  source(name) {
    if (name.endsWith("_inv")) {
      return 1.0 - this.source(name.slice(0, -4));
    }
    if (name === "earned") {
      return this.unlocked.length / Math.max(1, LAYERS.length);
    }
    const def = name === "centroid" ? 0.5 : 0.0;
    const v = this.values[name] ?? def;
    return Math.min(1.0, Math.max(0.0, v));
  }

  eligible(conds) {
    for (const [src, th] of Object.entries(conds)) {
      if (this.source(src) < th) return false;
    }
    return true;
  }

  accrue(nowSec, dt) {
    const playing = (this.values.energy ?? 0.0) >= this.config.idleFloor;
    if (!playing) {
      if (this.stoppedAt === null) {
        this.stoppedAt = nowSec;
      } else if (nowSec - this.stoppedAt >= this.config.hold) {
        this.progress = 0.0;
        this.unlocked = [];
        this.unlockedSet.clear();
      }
      return;
    }

    this.stoppedAt = null;
    const intensity = 0.5 * this.source("density") + 0.5 * this.source("loudness");
    const mult = PACE_MIN + (PACE_MAX - PACE_MIN) * Math.min(1.0, Math.max(0.0, intensity));
    this.progress += (dt / Math.max(0.05, this.config.layerPace)) * mult;

    while (this.unlocked.length < Math.floor(this.progress)) {
      let nxt = null;
      for (const layer of this._sortedLayers) {
        if (this.unlockedSet.has(layer.name)) continue;
        if (!this.layerLive.get(layer.name)) continue;
        if (this.eligible(layer.conds)) {
          nxt = layer.name;
          break;
        }
      }
      if (nxt === null) {
        this.progress = this.unlocked.length;
        break;
      }
      this.unlocked.push(nxt);
      this.unlockedSet.add(nxt);
    }
  }

  trackBass(nowSec) {
    const raw = this.values.bass ?? -1;
    const note = Math.trunc(raw);
    this.bassHigh = note > this.config.bassSplit ? note : null;
    const pc = note >= 0 && note <= this.config.bassSplit ? note % 12 : null;
    if (pc !== this.bassRaw) {
      this.bassRaw = pc;
      this.bassSince = nowSec;
    } else if (pc !== null && nowSec - this.bassSince >= BASS_HOLD) {
      this.bassPc = pc;
    }
  }

  bassBody() {
    if (this.bassPc === null || !this.config.bass) return null;
    const body = PITCH_BODY[this.bassPc];
    if (!body) return null;
    if (body === OUTWARD) return body;
    if (!this.bodies.has(body)) return null;
    return body;
  }

  noteBody() {
    const body = this.bassBody();
    if (body === null || body === OUTWARD) return null;
    return body === this.current ? null : body;
  }

  nextBody() {
    if (this.bassBody() === this.current) return "hold";
    const chosen = this.noteBody();
    if (chosen !== null) return chosen;
    const idx = this.tourStops.indexOf(this.current);
    if (idx >= 0) {
      if (idx + 1 < this.tourStops.length) {
        return this.tourStops[idx + 1];
      }
      return null;
    }
    return null;
  }

  lockStep(nowSec, nav) {
    this.trackBass(nowSec);
    const turned = nowSec - this.lockSince >= Math.max(0.0, this.config.retargetTime || 0);

    if (!this.lockArrived) {
      if (this.lockDist === null) {
        this.lockArrived = turned;
      } else if (this.telStale || this.telDist === null) {
        return 0;
      } else if (Math.log(Math.max(1e-9, this.telDist / this.lockDist)) <= LOCK_ARRIVED_GAP) {
        if (turned) this.lockArrived = true;
      } else {
        const gap = Math.log(this.telDist / this.lockDist);
        if (this.lockRate === null) {
          this.lockRate = Math.min(
            LOCK_RATE_MAX,
            gap / Math.max(0.1, this.config.lockApproach) / DUTY
          );
        }
        const rate = this.lockRate * Math.min(1.0, gap / LOCK_EASE);
        nav.push(`openspace.navigation.addTruckMovement(${luaNum(rate)})`);
        return 0;
      }
    }

    if (this.lockArrived) {
      if (!this.config.lockFocus) {
        const arrived = this.lockNode;
        const distStr = this.telDist !== null ? `${(this.telDist / 1e6).toFixed(1)} Mm` : "arrived";
        this.onLog("info", `arrived at ${arrived} (${distStr}) -- releasing focus lock`);
        this.lockNode = null;
        this.lockWant = null;
        this.tourStarted = true;
        this.current = arrived;
        this.target = null;
        this.redirectTo = null;
        this.bassPc = null;
        this.bassRaw = null;
        this.phase = "out";
        this.telStale = true;
        this.tourLastChange = nowSec;
        return -1;
      }
      if (this.config.orbitRate) {
        nav.push(`openspace.navigation.addGlobalRotation(${luaNum(this.config.orbitRate)},0)`);
      }
    }
    return 0;
  }

  tourStep(nowSec, nav) {
    this.trackBass(nowSec);

    if (!this.tourStarted) {
      this.tourStarted = true;
      this.tourLastChange = nowSec;
      this.telStale = true;
      this.current = this.tourStops[0];
      nav.push(`openspace.navigation.setFocus(${luaStr(this.current)})`);
      return 0;
    }

    const ready =
      !this.telStale &&
      this.telDist !== null &&
      nowSec - this.tourLastChange >= TOUR_DWELL;

    if (this.bassBody() === OUTWARD) {
      if (this.phase !== "final" && ready) {
        this.phase = "final";
        this.current = TOUR_FINAL;
        this.target = null;
        this.redirectTo = null;
        this.tourLastChange = nowSec;
        this.telStale = true;
        nav.push(`openspace.navigation.setFocus(${luaStr(TOUR_FINAL)})`);
      }
      return -1;
    }

    if (this.phase === "final") {
      const chosen = this.noteBody();
      if (chosen !== null && ready) {
        this.phase = "out";
        this.target = chosen;
        this.tourLastChange = nowSec;
        this.telStale = true;
      }
      return -1;
    }

    if (this.phase === "out") {
      const nxt = this.nextBody();
      if (nxt === "hold") {
        this.target = null;
        return 0;
      }
      this.target = nxt;
      if (this.target === null) return -1;

      const sepOk =
        this.telSep !== null &&
        this.telSepFor !== null &&
        this.telSepFor[0] === this.current &&
        this.telSepFor[1] === this.target;
      if (ready && sepOk && this.telDist >= this.config.tourMidpoint * this.telSep) {
        this.current = this.target;
        this.phase = "in";
        this.tourLastChange = nowSec;
        this.telStale = true;
        nav.push(`openspace.navigation.setFocus(${luaStr(this.current)})`);
        return 1;
      }
      return -1;
    }

    // phase === "in"
    const chosen = this.noteBody();
    if (chosen !== null) {
      if (chosen !== this.redirectTo) {
        this.redirectTo = chosen;
        this.redirectSince = nowSec;
      } else if (nowSec - this.redirectSince >= BASS_REDIRECT) {
        this.redirectTo = null;
        this.redirectSince = 0.0;
        this.target = chosen;
        this.phase = "out";
        this.tourLastChange = nowSec;
        this.telStale = true;
        return -1;
      }
    } else {
      this.redirectTo = null;
    }

    if (ready && this.telDist <= (ARRIVE[this.current] ?? 0.0)) {
      this.target = null;
      this.tourLastChange = nowSec;
      this.telStale = true;
      const nxt = this.nextBody();
      if (nxt === "hold") {
        this.phase = "out";
        return 0;
      }
      if (nxt === null) {
        this.phase = "final";
        this.current = TOUR_FINAL;
        nav.push(`openspace.navigation.setFocus(${luaStr(TOUR_FINAL)})`);
        return -1;
      }
      this.phase = "out";
      return -1;
    }
    return 1;
  }

  telemetry(nowSec, replies) {
    for (const [topic, payload] of replies) {
      if (topic !== null && topic !== undefined && topic === this.telTopic) {
        const nums = allNumbers(payload);
        if (nums.length > 0) {
          this.telDist = nums[0];
          this.telSep = nums.length > 1 ? nums[1] : null;
          this.telSepFor = this.telSepPending;
          this.telStale = false;
        }
        this.telTopic = null;
      }
    }

    if (this.telTopic !== null) {
      if (nowSec - this.telSent > TELEMETRY_TIMEOUT) {
        this.telTopic = null;
      }
      return;
    }
    if (nowSec - this.telSent < TELEMETRY_EVERY) return;

    let nxt = this.target || this.nextBody();
    if (nxt === "hold") nxt = null;
    const cur = this.current;
    let script;
    if (this.phase === "out" && nxt !== null) {
      script =
        `local d=openspace.navigation.distanceToFocus() ` +
        `local a=openspace.worldPosition('${cur}') ` +
        `local b=openspace.worldPosition('${nxt}') ` +
        `local s=math.sqrt((a[1]-b[1])^2+(a[2]-b[2])^2+(a[3]-b[3])^2) ` +
        `return d,s`;
      this.telSepPending = [cur, nxt];
    } else {
      script = "return openspace.navigation.distanceToFocus()";
      this.telSepPending = null;
    }
    this.telTopic = this.link.request(script);
    this.telSent = nowSec;
  }

  noteDensity(nowSec) {
    const cutoff = nowSec - TIME_ONSET_WINDOW;
    while (this.timeOnsets.length > 0 && this.timeOnsets[0].t < cutoff) {
      this.timeOnsets.shift();
    }
    if (this.timeSeenNotes) {
      let total = 0.0;
      for (const item of this.timeOnsets) total += item.weight;
      return Math.min(1.0, Math.max(0.0, total / TIME_ONSET_WINDOW / TIME_ONSET_MAX));
    }
    const d = this.source(this.config.timeSource);
    const poly = this.source("polyphony");
    return d / (1.0 + 1.8 * poly);
  }

  timeStep(nowSec, dt) {
    const raw =
      this.config.timeSource === "density"
        ? this.noteDensity(nowSec)
        : this.source(this.config.timeSource);
    const target = Math.min(1.0, raw * this.config.timeGain);
    const lag = target >= this.timeVal ? TIME_LAG_UP : TIME_LAG_DOWN;
    this.timeVal += (target - this.timeVal) * Math.min(1.0, dt / Math.max(0.05, lag));
    const fast = Math.pow(Math.min(1.0, Math.max(0.0, this.timeVal)), this.config.timeCurve);

    const playing = (this.values.energy ?? 0.0) >= this.config.idleFloor || raw > 0.01;
    let x;
    if (this.config.timeBuild > 0) {
      if (playing) {
        const pace = 0.6 + 1.2 * target;
        this.timeBuild = Math.min(1.0, this.timeBuild + (dt / this.config.timeBuild) * pace);
      } else {
        this.timeBuild = Math.max(0.0, this.timeBuild - dt / Math.max(0.1, this.config.timeDecay));
      }
      const share = TIME_BUILD_SHARE;
      const b = this.timeBuild;
      x = Math.min(1.0, fast * ((1.0 - share) + share * b) + share * b);
    } else {
      x = fast;
    }

    const lo = Math.max(1e-6, this.config.timeMin);
    const hi = Math.max(lo, this.config.timeMax);
    const rate = x < 1e-3 ? lo : lo * Math.pow(hi / lo, x);

    const last = this.timeRate;
    if (last !== null) {
      if (nowSec - this.timeSentAt < TIME_EVERY) return null;
      const settling = rate === lo && last !== lo;
      if (!settling && Math.abs(Math.log(rate / last)) < TIME_EPS) return null;
    }
    this.timeRate = rate;
    this.timeSentAt = nowSec;
    return `openspace.time.interpolateDeltaTime(${luaNum(rate)},${luaNum(TIME_INTERP)})`;
  }

  send(script, synchronized) {
    if (this.config.verbose) {
      this.onLog("lua", `lua${synchronized ? "" : " (local)"}: ${script}`);
    }
    this.link.lua(script, synchronized);
  }

  /**
   * Main 30 Hz tick. Feed analyzer output values and drive OpenSpace.
   */
  tick(nowSec, values) {
    if (this.t0 === null) this.t0 = nowSec;
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          this.values[k] = v;
        }
      }
      if (!this.hasInput && (values.energy > 0 || (values.bass ?? -1) >= 0)) {
        this.hasInput = true;
        this.lastInputAt = nowSec;
      }
    }

    if (!this.link.connected) return;

    // Handle runtime enabling of time driving if connected after initial probe.
    if (this.config.time && !this.timeLive && !this.probing && !this._settingUpTime) {
      this.setupTime();
    }

    const replies = this.link.drain();
    if (this.config.camera && (this.config.tour || this.lockNode || this.lockWant)) {
      this.telemetry(nowSec, replies);
    }

    const nav = [];
    const energy = this.values.energy ?? 0.0;
    let dt = this.lastEmit !== null ? nowSec - this.lastEmit : TICK;
    dt = Math.min(Math.max(dt, 0.0), 0.5);
    this.lastEmit = nowSec;

    if (this.config.camera) {
      const touring = Boolean(this.config.tour && this.tourStops.length > 0);

      if (this.lockWant !== this.lockNode) {
        this.applyFocusLock(nowSec, nav);
      }

      let direction;
      if (this.lockNode !== null) {
        direction = this.lockStep(nowSec, nav);
      } else {
        direction = touring && this.hasInput ? this.tourStep(nowSec, nav) : -1;
      }

      if (energy >= this.config.idleFloor) {
        this.lastActive = nowSec;
        this.drifting = false;

        const zoom = this.values.zoomSpeed ?? 0.0;
        if (zoom > 1e-4 && this.config.truckGain && direction !== 0) {
          const rate = zoom * this.config.truckGain;
          nav.push(`openspace.navigation.addTruckMovement(${luaNum(direction * rate)})`);
          if (!touring) {
            this.netEfolds += rate * DUTY * dt;
          }
        }

        const locked = this.lockNode !== null;
        const elevation = ((this.values.centroid ?? 0.5) - 0.5) * 2.0 * energy;
        if (!locked && Math.abs(elevation) > 1e-3 && this.config.elevationGain) {
          let rotY = elevation * this.config.elevationGain;
          if (this.config.slow) {
            rotY = Math.max(-SLOW_MAX_ROT, Math.min(SLOW_MAX_ROT, rotY));
          }
          nav.push(`openspace.navigation.addGlobalRotation(0,${luaNum(rotY)})`);
        }

        const tension = (this.values.tension ?? 0.0) * energy;
        if (!locked && tension > 1e-3 && this.config.rollGain) {
          const phase = 2 * Math.PI * ROLL_HZ * (nowSec - this.t0);
          let roll = tension * this.config.rollGain * Math.sin(phase);
          if (this.config.slow) {
            roll = Math.max(-SLOW_MAX_ROT, Math.min(SLOW_MAX_ROT, roll));
          }
          nav.push(`openspace.navigation.addLocalRoll(${luaNum(roll)})`);
        }

        if (!locked && this.notes.length > 0 && NOTE_KICK) {
          const kick = this.notes.reduce((s, [, v]) => s + v, 0) * NOTE_KICK;
          nav.push(`openspace.navigation.addLocalRotation(${luaNum(kick)},0)`);
        }
      } else if (
        !touring &&
        this.lockNode === null &&
        this.lastActive !== null &&
        this.config.driftTime > 0 &&
        nowSec - this.lastActive >= this.config.driftAfter &&
        this.netEfolds > DRIFT_DEADBAND
      ) {
        if (!this.drifting) {
          this.drifting = true;
          this.driftRate = Math.min(
            DRIFT_MAX,
            this.netEfolds / this.config.driftTime / DUTY
          );
        }
        const rate = this.driftRate * Math.min(1.0, this.netEfolds / DRIFT_EASE);
        nav.push(`openspace.navigation.addTruckMovement(${luaNum(rate)})`);
        this.netEfolds = Math.max(0.0, this.netEfolds - rate * DUTY * dt);
      } else {
        this.drifting = false;
      }
    }

    this.notes.length = 0;

    if (nav.length > 0) {
      this.send(nav.join(";"), false);
    }

    const props = [];
    if (this.config.layers && this.hasInput) {
      this.accrue(nowSec, dt);

      for (const layer of LAYERS) {
        const name = layer.name;
        if (!this.layerLive.get(name)) continue;

        const target = this.unlockedSet.has(name) ? 1.0 : 0.0;
        let r = this.ramp.get(name) ?? 0.0;
        const span = target > r ? FADE_IN : FADE_OUT;
        const step = dt / Math.max(span, 1e-6);
        r = target > r ? Math.min(target, r + step) : Math.max(target, r - step);
        this.ramp.set(name, r);

        const value = smoothstep(r, 0.0, 1.0);
        this.layers[name] = value;

        const wantOn = value > ENABLE_AT;
        if (this.layerEnabled.get(name) !== wantOn) {
          this.layerEnabled.set(name, wantOn);
          props.push(
            `openspace.setPropertyValue(${luaStr(layer.uri + ".Enabled")},${wantOn ? "true" : "false"})`
          );
        }

        const txt = luaNum(value);
        const last = this.lastLayer.get(name);
        if (last !== undefined && txt === last[1]) continue;
        if (
          last !== undefined &&
          Math.abs(value - last[0]) < LAYER_EPS &&
          value !== 0.0 &&
          value !== 1.0
        ) {
          continue;
        }
        this.lastLayer.set(name, [value, txt]);
        props.push(`openspace.setPropertyValue(${luaStr(layer.uri + ".Fade")},${txt})`);
      }
    }

    for (const [oscName, uri] of this.scalarUri.entries()) {
      if (!(oscName in this.values)) continue;
      const [lo, hi] = this.scalarRange.get(oscName);
      const value = lo + (hi - lo) * Math.min(1.0, Math.max(0.0, this.values[oscName]));
      const last = this.lastScalar.get(oscName);
      if (last !== undefined && Math.abs(value - last) < SCALAR_EPS) continue;
      this.lastScalar.set(oscName, value);
      props.push(`openspace.setPropertyValue(${luaStr(uri)},${luaNum(value)})`);
    }

    if (!this.config.noSizes && this.sizeBase.size > 0 && this.hasInput) {
      const target = this.source(this.config.sizeSource);
      this.sizeVal += (target - this.sizeVal) * Math.min(1.0, dt / SIZE_LAG);
      const common = this.config.sizeMin + (this.config.sizeMax - this.config.sizeMin) * this.sizeVal;

      for (const band of Object.keys(this.bandVal)) {
        const bTarget = this.source(band);
        this.bandVal[band] += (bTarget - this.bandVal[band]) * Math.min(1.0, dt / TREBLE_LAG);
      }

      for (const [name, base] of this.sizeBase.entries()) {
        if ((this.ramp.get(name) ?? 0.0) <= 0.0) continue;
        const bv = this.bandVal[BAND_OF[name] || "treble"] ?? 0.0;
        const mult = common * (1.0 + this.config.trebleBoost * bv);
        const txt = luaNum(Math.min(base * mult, SIZE_CEILING));
        if (this.lastSize.get(name) !== txt) {
          this.lastSize.set(name, txt);
          props.push(
            `openspace.setPropertyValue(${luaStr(this.layerUri.get(name) + ".Sizing.ScaleFactor")},${txt})`
          );
        }
        if (this.opacityLive.has(name)) {
          const op = OPACITY_MIN + (OPACITY_MAX - OPACITY_MIN) * bv;
          const otxt = luaNum(op);
          if (this.lastOpacity.get(name) !== otxt) {
            this.lastOpacity.set(name, otxt);
            props.push(
              `openspace.setPropertyValue(${luaStr(this.layerUri.get(name) + ".Opacity")},${otxt})`
            );
          }
        }
      }
    }

    if (props.length > 0) {
      this.send(props.join(";"), true);
    }

    if (this.config.time && this.timeLive && this.hasInput) {
      const script = this.timeStep(nowSec, dt);
      if (script) {
        this.send(script, false);
      }
    }
  }

  async restoreTime() {
    if (!this.link.connected) return false;
    if (this.timeWas !== null && this.timeRate !== null) {
      if (this.link.lua(`openspace.time.setDeltaTime(${luaNum(this.timeWas)})`, false)) {
        this.onLog("info", `time speed restored to ${formatRate(this.timeWas)}`);
        this.timeRate = null;
        return true;
      }
      this.onLog("warn", "could not restore the time speed -- OpenSpace is gone");
    }
    return false;
  }

  async restore() {
    if (!this.link.connected) return false;
    let restoredAny = await this.restoreTime();
    if (this.retargetWas !== null) {
      if (
        this.link.lua(
          `openspace.setPropertyValue(${luaStr(RETARGET_URI)},${luaNum(this.retargetWas)})`,
          true
        )
      ) {
        this.onLog("info", `focus retarget time restored to ${this.retargetWas}s`);
        restoredAny = true;
      } else {
        this.onLog("warn", "could not restore the retarget time -- OpenSpace is gone");
      }
    }
    return restoredAny;
  }

  tourWhere() {
    if (this.lockNode !== null) {
      if (this.lockArrived) return `${this.lockNode}, locked, orbiting`;
      if (this.lockDist && this.telDist && !this.telStale) {
        return `${this.lockNode}, locked, closing in (${(this.telDist / 1e6).toFixed(0)} -> ${(this.lockDist / 1e6).toFixed(1)} Mm)`;
      }
      return `${this.lockNode}, locked, arriving`;
    }

    let note = this.bassPc === null ? "" : ` [${NOTE_NAMES[this.bassPc]}]`;
    if (this.bassHigh !== null) {
      const nName = NOTE_NAMES[this.bassHigh % 12];
      const oct = Math.floor(this.bassHigh / 12) - 1;
      note += ` (${nName}${oct} too high to steer)`;
    }

    if (!this.tourStarted) return "starting";
    if (this.phase === "final") return `${TOUR_FINAL}, outward without end${note}`;

    if (this.phase === "in") {
      const arrive = ARRIVE[this.current] ?? 0.0;
      let near = "";
      if (this.telDist && arrive > 0) {
        const left = Math.log(Math.max(this.telDist, arrive) / arrive);
        near = ` ${left.toFixed(1)} to go`;
      }
      if (this.redirectTo) {
        near += ` (holding ${this.redirectTo}...)`;
      }
      return `-> ${this.current}${note}${near}`;
    }

    const nxt = this.target || this.nextBody();
    if (nxt === "hold") return `at ${this.current}${note}`;
    if (nxt === null) return `${this.current}, outward${note}`;

    let prog = "";
    if (
      this.telDist &&
      this.telSep &&
      this.telSepFor &&
      this.telSepFor[0] === this.current &&
      this.telSepFor[1] === nxt
    ) {
      const goal = this.config.tourMidpoint * this.telSep;
      if (goal > 0) {
        if (this.telDist >= goal) {
          prog = " handing over";
        } else {
          prog = ` ${Math.log(goal / this.telDist).toFixed(1)} to go`;
        }
      }
    }
    return `${this.current} -> ${nxt}${note}${prog}`;
  }

  getStatus() {
    let liveCount = 0;
    for (const v of this.layerLive.values()) if (v) liveCount++;

    let state;
    if (!this.hasInput) {
      state = "waiting for notes";
    } else if (!this.link.connected) {
      state = "OpenSpace offline";
    } else if (!this.config.camera) {
      state = "camera off";
    } else if (this.config.tour && this.tourStops.length > 0) {
      const d = this.telDist;
      state = this.tourWhere() + (d ? `  ${formatSI(d)}` : "");
    } else if (this.drifting) {
      state = `drifting back, ${this.netEfolds.toFixed(1)} e-folds out`;
    } else if ((this.values.energy ?? 0.0) < this.config.idleFloor) {
      state = `idle, ${this.netEfolds.toFixed(1)} e-folds out`;
    } else {
      state = "ok";
    }

    const hottest = Math.max(0.0, ...Object.values(this.bandVal));
    const sizeBoost =
      hottest > 0.02 && !this.config.noSizes && this.config.trebleBoost
        ? 1.0 + this.config.trebleBoost * hottest
        : 1.0;

    return {
      state,
      tourWhere: this.tourWhere(),
      distanceText: this.telDist ? formatSI(this.telDist) : "--",
      timeRate: this.timeRate,
      timeRateText: this.timeLive && this.timeRate !== null ? formatRate(this.timeRate) : "--",
      unlockedCount: this.unlocked.length,
      liveLayerCount: liveCount,
      totalLayerCount: LAYERS.length,
      progress: this.progress,
      progressFrac: this.progress - this.unlocked.length,
      sizeBoost,
      lockNode: this.lockNode,
      bassBody: this.bassBody(),
      bassPc: this.bassPc,
      bassHigh: this.bassHigh,
      sent: this.link.sent,
      layerStates: this._sortedLayers.map((l) => ({
        name: l.name,
        rank: l.rank,
        live: Boolean(this.layerLive.get(l.name)),
        unlocked: this.unlockedSet.has(l.name),
        fade: this.layers[l.name] ?? 0.0,
        band: BAND_OF[l.name] || null,
      })),
    };
  }
}
