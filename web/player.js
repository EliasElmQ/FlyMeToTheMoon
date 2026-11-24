// Deterministic playback controller for:
//   - Built-in 2-minute demo (DEMO_SCORE)
//   - Single .score / .mid playback (with velocity trim & optional focus lock)
//   - Rolling playlist installation mode (with yield, fade-out, takeover, idle resume)

import { BUNDLED_SONGS, DEMO_SCORE, FOCUS_LOCK_FOR, VEL_TRIM } from "./constants.js";

export function velTrimFor(name) {
  let mult = 1.0;
  const s = String(name || "");
  for (const [frag, m] of VEL_TRIM) {
    if (s.includes(frag)) mult = m;
  }
  return mult;
}

export function focusLockNodeFor(name, enabled = true) {
  if (!enabled) return null;
  const s = String(name || "");
  let hit = null;
  for (const [frag, body] of FOCUS_LOCK_FOR) {
    if (s.includes(frag)) hit = body;
  }
  return hit;
}

export class PlaybackController {
  /**
   * @param {object} opts
   * @param {(num: number, vel: number) => void} opts.onNoteOn
   * @param {(num: number) => void} opts.onNoteOff
   * @param {(down: boolean) => void} opts.onPedal
   * @param {(node: string|null) => void} [opts.onFocusLock]
   * @param {() => number} [opts.getUserKeysCount]
   * @param {() => boolean} [opts.getPedalState]
   * @param {(filename: string) => Promise<{ events: Array, name: string }>} [opts.loadSong]
   * @param {(level: string, msg: string) => void} [opts.onLog]
   * @param {(snap: object) => void} [opts.onStateChange]
   */
  constructor(opts = {}) {
    this.onNoteOn = opts.onNoteOn || (() => {});
    this.onNoteOff = opts.onNoteOff || (() => {});
    this.onPedal = opts.onPedal || (() => {});
    this.onFocusLock = opts.onFocusLock || (() => {});
    this.getUserKeysCount = opts.getUserKeysCount || (() => 0);
    this.getPedalState = opts.getPedalState || (() => false);
    this.loadSong = opts.loadSong || null;
    this.onLog = opts.onLog || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});

    this.mode = "idle"; // "idle" | "demo" | "single" | "rolling"
    this.lastStepAt = null;

    // Demo state
    this.demoTempo = 72;
    this.demoSecIdx = 0;
    this.demoEvIdx = 0;
    this.demoBeat = 0.0;
    this.demoNextBeat = 0.0;
    this.demoPendingOffs = []; // { releaseBeat, note }
    this.demoHeld = new Set();
    this.demoLabel = "";

    // Single score state
    this.singleName = "";
    this.singleEvents = null;
    this.singleIdx = 0;
    this.singleTime = 0.0;
    this.singleDuration = 0.0;
    this.singleGapLeft = 0.0;
    this.singleHeld = new Set();
    this.midiRate = 1.0;
    this.midiLoop = false;
    this.focusLockEnabled = true;
    this.songTrim = 1.0;

    // Rolling playlist state
    this.rdSongs = [...BUNDLED_SONGS];
    this.rdYield = true;
    this.rdIdle = 5.0;
    this.rdFadeOut = 1.5;
    this.rdFadeIn = 2.5;
    this.rdGap = 5.0;

    this.rdGain = 1.0;
    this.rdFadeFrom = 1.0;
    this.rdFadeTarget = 1.0;
    this.rdFadeElapsed = 0.0;
    this.rdFadeSpan = 0.0;
    this.rdFading = false;

    this.rdIndex = 0;
    this.rdTakenOver = false;
    this.rdSkipWanted = false;
    this.rdLastKey = 0.0;
    this.rdHeld = new Set();
    this.rdSongName = "";
    this.rdEvents = null;
    this.rdEvIdx = 0;
    this.rdTime = 0.0;
    this.rdDuration = 0.0;
    this.rdGapLeft = 0.0;
    this.rdLoading = false;
    this.rdMisses = 0;
  }

  _notify() {
    this.onStateChange(this.getStatus());
  }

  getStatus() {
    if (this.mode === "demo") {
      return {
        mode: "demo",
        label: this.demoLabel || "Demo",
        time: 0,
        duration: 0,
        takenOver: false,
        gain: 1,
      };
    }
    if (this.mode === "single") {
      return {
        mode: "single",
        label: this.singleName || "Score",
        time: Math.min(this.singleTime, this.singleDuration),
        duration: this.singleDuration,
        takenOver: false,
        gain: 1,
      };
    }
    if (this.mode === "rolling") {
      return {
        mode: "rolling",
        label: this.rdSongName || "Loading...",
        time: Math.min(this.rdTime, this.rdDuration),
        duration: this.rdDuration,
        takenOver: this.rdTakenOver,
        gain: this.rdGain,
      };
    }
    return {
      mode: "idle",
      label: this.singleName ? `Ready: ${this.singleName}` : "Idle",
      time: 0,
      duration: this.singleDuration || 0,
      takenOver: false,
      gain: 1,
    };
  }

  // -------------------------------------------------------------------
  // Demo
  // -------------------------------------------------------------------

  startDemo() {
    this.stopAll();
    this.mode = "demo";
    this.demoSecIdx = 0;
    this.demoEvIdx = 0;
    this.demoBeat = 0.0;
    this.demoNextBeat = 0.0;
    this.demoPendingOffs = [];
    this.demoHeld.clear();
    this.demoLabel = DEMO_SCORE[0]?.label || "";
    this.onLog("info", `demo | ${this.demoLabel}`);
    this._notify();
  }

  stopDemo() {
    if (this.mode !== "demo") return;
    this.mode = "idle";
    this.onPedal(false);
    for (const n of this.demoHeld) this.onNoteOff(n);
    this.demoHeld.clear();
    this.demoPendingOffs = [];
    this.onLog("info", "demo stopped");
    this._notify();
  }

  _stepDemo(dt) {
    const beatsPerSec = Math.max(20, this.demoTempo) / 60.0;
    this.demoBeat += dt * beatsPerSec;

    // Release any notes whose hold time expired
    for (let i = this.demoPendingOffs.length - 1; i >= 0; i--) {
      if (this.demoBeat >= this.demoPendingOffs[i].releaseBeat) {
        const { note } = this.demoPendingOffs[i];
        this.demoPendingOffs.splice(i, 1);
        this.demoHeld.delete(note);
        this.onNoteOff(note);
      }
    }

    let guard = 0;
    while (this.mode === "demo" && this.demoBeat >= this.demoNextBeat && guard++ < 512) {
      const sec = DEMO_SCORE[this.demoSecIdx];
      if (!sec) {
        this.demoSecIdx = 0;
        this.demoEvIdx = 0;
        continue;
      }
      if (this.demoEvIdx === 0) {
        this.demoLabel = sec.label;
        this.onLog("info", `demo | ${sec.label}`);
      }
      const ev = sec.events[this.demoEvIdx];
      if (!ev) {
        this.demoSecIdx = (this.demoSecIdx + 1) % DEMO_SCORE.length;
        this.demoEvIdx = 0;
        continue;
      }

      if (ev.pedal === true) {
        this.onPedal(true);
      } else if (ev.pedal === false) {
        this.onPedal(false);
      } else if (Array.isArray(ev.notes)) {
        for (const n of ev.notes) {
          for (let i = this.demoPendingOffs.length - 1; i >= 0; i--) {
            if (this.demoPendingOffs[i].note === n) {
              this.demoPendingOffs.splice(i, 1);
            }
          }
          if (this.demoHeld.has(n)) {
            this.demoHeld.delete(n);
            this.onNoteOff(n);
          }
          this.demoHeld.add(n);
          this.onNoteOn(n, ev.vel ?? 0.6);
          this.demoPendingOffs.push({
            releaseBeat: this.demoNextBeat + (ev.hold ?? 1.0),
            note: n,
          });
        }
      }

      this.demoNextBeat += ev.wait ?? 0;
      this.demoEvIdx += 1;
      if (this.demoEvIdx >= sec.events.length) {
        this.demoSecIdx = (this.demoSecIdx + 1) % DEMO_SCORE.length;
        this.demoEvIdx = 0;
      }
    }
  }

  // -------------------------------------------------------------------
  // Single score
  // -------------------------------------------------------------------

  loadSingle(name, events) {
    this.singleName = name || "";
    this.singleEvents = events || [];
    this.songTrim = velTrimFor(this.singleName);
    this.singleDuration =
      this.singleEvents.length > 0
        ? this.singleEvents[this.singleEvents.length - 1].t
        : 0;
    this._notify();
  }

  startSingle() {
    if (!this.singleEvents || this.singleEvents.length === 0) {
      this.onLog("warn", "No score loaded to play");
      return false;
    }
    this.stopAll();
    this.mode = "single";
    this.singleIdx = 0;
    this.singleTime = 0.0;
    this.singleGapLeft = 0.0;
    this.singleHeld.clear();
    this.songTrim = velTrimFor(this.singleName);

    const lock = focusLockNodeFor(this.singleName, this.focusLockEnabled);
    this.onFocusLock(lock);
    if (lock) {
      this.onLog("info", `focus locked to ${lock} for ${this.singleName}`);
    }
    this.onLog("info", `playing ${this.singleName}`);
    this._notify();
    return true;
  }

  stopSingle() {
    if (this.mode !== "single") return;
    this.mode = "idle";
    this.onPedal(false);
    for (const n of this.singleHeld) this.onNoteOff(n);
    this.singleHeld.clear();
    this.onFocusLock(null);
    this.onLog("info", "score stopped");
    this._notify();
  }

  _stepSingle(dt) {
    if (this.singleGapLeft > 0) {
      this.singleGapLeft -= dt * this.midiRate;
      if (this.singleGapLeft <= 0) {
        this.singleIdx = 0;
        this.singleTime = 0.0;
        const lock = focusLockNodeFor(this.singleName, this.focusLockEnabled);
        this.onFocusLock(lock);
      }
      return;
    }

    this.singleTime += dt * Math.max(0.05, this.midiRate);
    while (
      this.singleIdx < this.singleEvents.length &&
      this.singleEvents[this.singleIdx].t <= this.singleTime
    ) {
      const e = this.singleEvents[this.singleIdx++];
      if (e.kind === "on") {
        const v = Math.min(1.0, Math.max(0.0, e.vel * this.songTrim));
        this.singleHeld.add(e.note);
        this.onNoteOn(e.note, v);
      } else if (e.kind === "off") {
        this.singleHeld.delete(e.note);
        this.onNoteOff(e.note);
      } else if (e.kind === "ped") {
        this.onPedal(e.note > 0);
      }
    }

    if (this.singleIdx >= this.singleEvents.length) {
      this.onPedal(false);
      for (const n of this.singleHeld) this.onNoteOff(n);
      this.singleHeld.clear();
      this.onLog("info", `finished ${this.singleName}`);
      if (this.midiLoop) {
        this.singleGapLeft = 4.0;
      } else {
        this.onFocusLock(null);
        this.mode = "idle";
        this._notify();
      }
    }
  }

  // -------------------------------------------------------------------
  // Rolling playlist (installation mode)
  // -------------------------------------------------------------------

  async startRolling(nowSec = 0) {
    if (!this.rdSongs || this.rdSongs.length === 0) {
      this.onLog("warn", "rolling demo: song list is empty");
      return;
    }
    if (!this.loadSong) {
      this.onLog("error", "rolling demo: no song loader configured");
      return;
    }
    this.stopAll();
    this.mode = "rolling";
    this.rdTakenOver = false;
    this.rdSkipWanted = false;
    this.rdGain = 1.0;
    this.rdFading = false;
    this.rdLastKey = nowSec - this.rdIdle;
    this.rdHeld.clear();
    this.rdEvents = null;
    this.rdMisses = 0;
    this.onLog(
      "info",
      `rolling demo: ${this.rdSongs.length} songs, yielding for ${this.rdIdle}s after key press`
    );
    this._notify();
    await this._loadNextRollingSong();
  }

  stopRolling() {
    if (this.mode !== "rolling") return;
    this.mode = "idle";
    this.rdTakenOver = false;
    this.rdSkipWanted = false;
    this.rdFading = false;
    this.rdGain = 1.0;
    this._rdSilence();
    this.onFocusLock(null);
    this.onLog("info", "rolling demo stopped");
    this._notify();
  }

  skip() {
    if (this.mode !== "rolling") {
      this.onLog("warn", "rolling demo: not running");
      return;
    }
    this.rdSkipWanted = true;
    if (this.rdTakenOver) {
      this.onLog("info", "rolling demo: skip queued -- lands when playback resumes");
    } else {
      this.onLog("info", "rolling demo: skipping to next song");
    }
  }

  /**
   * Notify controller of a physical/on-screen user key press.
   */
  onUserTouch(nowSec) {
    this.rdLastKey = nowSec;
    if (this.mode === "rolling" && this.rdYield && !this.rdTakenOver) {
      this.rdTakenOver = true;
      this.onLog("info", `rolling demo: you have it -- fading out over ${this.rdFadeOut}s`);
      this._startFade(0.0, this.rdFadeOut);
      this._notify();
    }
  }

  _startFade(target, spanSec) {
    this.rdFadeFrom = this.rdGain;
    this.rdFadeTarget = target;
    this.rdFadeSpan = Math.max(0.0, spanSec);
    this.rdFadeElapsed = 0.0;
    this.rdFading = true;
    if (this.rdFadeSpan <= 0) {
      this.rdGain = target;
      this.rdFading = false;
      if (target === 0.0) {
        this._rdSilence();
        this.onFocusLock(null);
      }
    }
  }

  _rdSilence() {
    if (this.getPedalState()) {
      this.onPedal(false);
    }
    for (const n of this.rdHeld) {
      this.onNoteOff(n);
    }
    this.rdHeld.clear();
  }

  async _loadNextRollingSong() {
    if (this.mode !== "rolling" || this.rdLoading) return;
    this.rdLoading = true;
    try {
      while (this.mode === "rolling") {
        const song = this.rdSongs[this.rdIndex % this.rdSongs.length];
        this.rdIndex = (this.rdIndex + 1) % this.rdSongs.length;
        try {
          const loaded = await this.loadSong(song);
          if (this.mode !== "rolling") return;
          if (!loaded || !loaded.events || loaded.events.length === 0) {
            throw new Error("Empty score");
          }
          this.rdMisses = 0;
          this.rdSongName = loaded.name || song;
          this.rdEvents = loaded.events;
          this.rdEvIdx = 0;
          this.rdTime = 0.0;
          this.rdDuration = loaded.events[loaded.events.length - 1].t;
          this.rdGapLeft = 0.0;
          this.songTrim = velTrimFor(this.rdSongName);
          if (!this.rdTakenOver) {
            const lock = focusLockNodeFor(this.rdSongName, this.focusLockEnabled);
            this.onFocusLock(lock);
          }
          this._notify();
          return;
        } catch (err) {
          this.rdMisses += 1;
          this.onLog("warn", `rolling demo: failed to load ${song}: ${err.message || err}`);
          if (this.rdMisses >= this.rdSongs.length) {
            this.onLog("error", "rolling demo: no scores could be loaded -- stopping");
            this.stopRolling();
            return;
          }
        }
      }
    } finally {
      this.rdLoading = false;
    }
  }

  _stepRolling(nowSec, dt) {
    // 1. Fade progression
    if (this.rdFading) {
      this.rdFadeElapsed += dt;
      const frac = this.rdFadeSpan > 0 ? Math.min(1.0, this.rdFadeElapsed / this.rdFadeSpan) : 1.0;
      this.rdGain = this.rdFadeFrom + (this.rdFadeTarget - this.rdFadeFrom) * frac;
      if (frac >= 1.0) {
        this.rdGain = this.rdFadeTarget;
        this.rdFading = false;
        if (this.rdFadeTarget === 0.0) {
          this._rdSilence();
          this.onFocusLock(null);
        }
      }
    }

    // 2. Idle watchdog during takeover
    if (this.rdTakenOver) {
      if (nowSec - this.rdLastKey >= this.rdIdle && this.getUserKeysCount() === 0) {
        this.rdTakenOver = false;
        this.onLog("info", `rolling demo: quiet for ${this.rdIdle}s -- resuming`);
        if (this.rdSongName) {
          const lock = focusLockNodeFor(this.rdSongName, this.focusLockEnabled);
          this.onFocusLock(lock);
        }
        this._startFade(1.0, this.rdFadeIn);
        this._notify();
      } else {
        return;
      }
    }

    if (this.rdLoading) return;

    // 3. Inter-song gap
    if (this.rdGapLeft > 0) {
      if (this.rdSkipWanted) {
        this.rdSkipWanted = false;
        this.rdGapLeft = 0;
        this._loadNextRollingSong();
      } else {
        this.rdGapLeft -= dt;
        if (this.rdGapLeft <= 0) {
          this._loadNextRollingSong();
        }
      }
      return;
    }

    if (!this.rdEvents) return;

    // 4. Skip mid-song
    if (this.rdSkipWanted) {
      this.rdSkipWanted = false;
      this._rdSilence();
      this.onFocusLock(null);
      this.onLog("info", `rolling demo: skipped ${this.rdSongName}`);
      this.rdEvents = null;
      this.rdGapLeft = 0.5;
      return;
    }

    // 5. Event playback
    this.rdTime += dt * Math.max(0.05, this.midiRate);
    while (this.rdEvIdx < this.rdEvents.length && this.rdEvents[this.rdEvIdx].t <= this.rdTime) {
      const e = this.rdEvents[this.rdEvIdx++];
      if (e.kind === "on") {
        if (this.rdGain > 0.002) {
          const v = Math.min(1.0, Math.max(0.0, e.vel * this.rdGain * this.songTrim));
          this.rdHeld.add(e.note);
          this.onNoteOn(e.note, v);
        }
      } else if (e.kind === "off") {
        this.rdHeld.delete(e.note);
        this.onNoteOff(e.note);
      } else if (e.kind === "ped") {
        this.onPedal(e.note > 0);
      }
    }

    if (this.rdEvIdx >= this.rdEvents.length) {
      this._rdSilence();
      this.onFocusLock(null);
      this.onLog("info", `rolling demo: finished ${this.rdSongName}`);
      this.rdEvents = null;
      this.rdGapLeft = this.rdGap;
      this._notify();
    }
  }

  // -------------------------------------------------------------------
  // Shared step & stop
  // -------------------------------------------------------------------

  stopAll() {
    if (this.mode === "demo") this.stopDemo();
    else if (this.mode === "single") this.stopSingle();
    else if (this.mode === "rolling") this.stopRolling();
    this.mode = "idle";
    this._notify();
  }

  step(nowSec) {
    const dt =
      this.lastStepAt === null
        ? 1 / 30
        : Math.min(0.25, Math.max(0.0, nowSec - this.lastStepAt));
    this.lastStepAt = nowSec;

    if (this.mode === "demo") {
      this._stepDemo(dt);
    } else if (this.mode === "single") {
      this._stepSingle(dt);
    } else if (this.mode === "rolling") {
      this._stepRolling(nowSec, dt);
    }
  }
}
