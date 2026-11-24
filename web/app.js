// Application entrypoint tying together Web MIDI, Web Audio synth,
// PianoAnalyzer, OpenSpaceLink, OpenSpaceBridge, PlaybackController, and PianoView.

import { PianoAnalyzer } from "./analyzer.js";
import { OpenSpaceBridge } from "./bridge.js";
import { BUNDLED_SONGS, PITCH_BODY, OUTWARD, noteName } from "./constants.js";
import { MidiManager, parseMidiFile, parseScoreText, computeScoreStats } from "./midi.js";
import { OpenSpaceLink } from "./openspace_link.js";
import { PianoView } from "./piano_view.js";
import { PlaybackController } from "./player.js";
import { PianoSynth } from "./synth.js";

const $ = (id) => document.getElementById(id);

const QWERTY_MAP = {
  // Lower octave C3..E4
  KeyZ: 48, KeyS: 49, KeyX: 50, KeyD: 51, KeyC: 52,
  KeyV: 53, KeyG: 54, KeyB: 55, KeyH: 56, KeyN: 57, KeyJ: 58, KeyM: 59,
  Comma: 60, KeyL: 61, Period: 62, Semicolon: 63, Slash: 64,
  // Upper octave C4..E5
  KeyQ: 60, Digit2: 61, KeyW: 62, Digit3: 63, KeyE: 64,
  KeyR: 65, Digit5: 66, KeyT: 67, Digit6: 68, KeyY: 69, Digit7: 70, KeyU: 71,
  KeyI: 72, Digit9: 73, KeyO: 74, Digit0: 75, KeyP: 76,
};

function startBackgroundTicker(onTick, hz = 30) {
  const intervalMs = 1000 / hz;
  try {
    const src = `setInterval(() => postMessage(0), ${intervalMs});`;
    const blob = new Blob([src], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = onTick;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(onTick, intervalMs);
    return () => clearInterval(id);
  }
}

class App {
  constructor() {
    this.logLines = [];
    this.scoreCache = new Map();
    this.userKeysDown = new Set();
    this.qwertyHeld = new Set();
    this.lastAnalysisSec = performance.now() / 1000;
    this.tickCounter = 0;
    this.uiCounter = 0;

    this.synth = new PianoSynth();
    this.analyzer = new PianoAnalyzer();
    this.link = new OpenSpaceLink({
      onStatus: (st) => this.updateConnUI(st),
      onLog: (lvl, msg) => this.log(lvl, msg),
    });
    this.bridge = new OpenSpaceBridge(this.link, {
      onLog: (lvl, msg) => this.log(lvl, msg),
    });
    this.pianoView = new PianoView($("pianoCanvas"), {
      onUserNoteOn: (n, v) => this.handleNoteOn(n, v, true),
      onUserNoteOff: (n) => this.handleNoteOff(n, true),
    });
    this.player = new PlaybackController({
      onNoteOn: (n, v) => this.handleNoteOn(n, v, false),
      onNoteOff: (n) => this.handleNoteOff(n, false),
      onPedal: (d) => this.handlePedal(d),
      onFocusLock: (node) => this.bridge.setFocusLock(node),
      getUserKeysCount: () => this.userKeysDown.size,
      getPedalState: () => this.analyzer.pedal,
      loadSong: (filename) => this.fetchBundledScore(filename),
      onLog: (lvl, msg) => this.log(lvl, msg),
      onStateChange: (snap) => this.updatePlaybackUI(snap),
    });
    this.midi = new MidiManager({
      onNoteOn: (n, v) => this.handleNoteOn(n, v, true),
      onNoteOff: (n) => this.handleNoteOff(n, true),
      onPedal: (d) => this.handlePedal(d),
      onDevicesChange: (devs) => this.renderMidiDevices(devs),
      onLog: (lvl, msg) => this.log(lvl, msg),
    });

    this.populateSongs();
    this.buildLayerMatrix();
    this.bindUI();
    this.syncConfigToUI();
    this.midi.init();

    // Load default bundled song metadata cleanly without auto-playing
    this.fetchBundledScore(BUNDLED_SONGS[0])
      .then((loaded) => {
        this.player.loadSingle(loaded.name, loaded.events);
        this.showScoreStats(computeScoreStats(loaded.events, this.bridge.config.bassSplit), loaded.name);
      })
      .catch(() => {});

    this.stopTicker = startBackgroundTicker(() => this.onTick(), 120);

    const drawLoop = () => {
      this.pianoView.render(performance.now() / 1000);
      requestAnimationFrame(drawLoop);
    };
    requestAnimationFrame(drawLoop);

    window.addEventListener("pagehide", () => {
      if (this.link.connected) {
        this.bridge.restore();
      }
    });
  }

  log(level, msg) {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    const entry = { level, text: `[${ts}] ${msg}` };
    this.logLines.push(entry);
    if (this.logLines.length > 220) {
      this.logLines.splice(0, this.logLines.length - 220);
    }
    const el = $("logConsole");
    if (!el) return;
    const div = document.createElement("div");
    div.className = `log-line ${level}`;
    div.textContent = entry.text;
    el.appendChild(div);
    while (el.childNodes.length > 220) {
      el.removeChild(el.firstChild);
    }
    el.scrollTop = el.scrollHeight;
  }

  handleNoteOn(num, vel, isUser) {
    const nowSec = performance.now() / 1000;
    if (isUser) {
      this.synth.resume();
      this.userKeysDown.add(num);
      this.player.onUserTouch(nowSec);
    }
    this.analyzer.noteOn(num, vel, nowSec);
    this.bridge.onNote(num, vel, nowSec);
    this.synth.noteOn(num, vel);
    this.pianoView.noteOn(num, vel, nowSec);
  }

  handleNoteOff(num, isUser) {
    const nowSec = performance.now() / 1000;
    if (isUser) {
      this.userKeysDown.delete(num);
    }
    this.analyzer.noteOff(num);
    this.synth.noteOff(num);
    this.pianoView.noteOff(num, nowSec);
  }

  handlePedal(down) {
    const nowSec = performance.now() / 1000;
    this.analyzer.setPedal(down);
    this.synth.setPedal(down);
    this.pianoView.setPedal(down, nowSec);
    const btn = $("pedalBtn");
    btn.textContent = `Sustain Pedal: ${down ? "Down" : "Up"}`;
    btn.classList.toggle("active", Boolean(down));
  }

  panic() {
    this.player.stopAll();
    this.userKeysDown.clear();
    this.qwertyHeld.clear();
    this.analyzer.panic();
    this.synth.panic();
    this.pianoView.panic();
    this.bridge.setFocusLock(null);
    $("pedalBtn").textContent = "Sustain Pedal: Up";
    $("pedalBtn").classList.remove("active");
    this.log("warn", "Panic: silenced all voices and reset analysis");
  }

  onTick() {
    const nowSec = performance.now() / 1000;
    this.player.step(nowSec);
    this.tickCounter += 1;
    if (this.tickCounter % 4 !== 0) return;

    const dt = Math.min(0.25, Math.max(0.0, nowSec - this.lastAnalysisSec));
    this.lastAnalysisSec = nowSec;

    const values = this.analyzer.tick(nowSec, dt > 0 ? dt : 1 / 30);
    this.bridge.tick(nowSec, values);

    this.uiCounter += 1;
    if (this.uiCounter % 3 === 0) {
      this.updateTelemetryUI(values);
    }
  }

  async fetchBundledScore(filename) {
    if (this.scoreCache.has(filename)) {
      return this.scoreCache.get(filename);
    }
    const resp = await fetch(`./Songs/${encodeURIComponent(filename)}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} loading ${filename}`);
    }
    const text = await resp.text();
    const events = parseScoreText(text);
    const result = { name: filename, events };
    this.scoreCache.set(filename, result);
    return result;
  }

  populateSongs() {
    const sel = $("songSelect");
    sel.innerHTML = "";
    for (const name of BUNDLED_SONGS) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name.replace(/\.score$/, "");
      sel.appendChild(opt);
    }
  }

  renderMidiDevices(devices) {
    const sel = $("midiSelect");
    const prev = sel.value;
    sel.innerHTML = "";
    if (!this.midi.supported) {
      const opt = document.createElement("option");
      opt.value = "none";
      opt.textContent = "Web MIDI unsupported";
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent =
      devices.length > 0 ? `All MIDI Inputs (${devices.length})` : "No MIDI Keyboard Detected";
    sel.appendChild(allOpt);
    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.name;
      sel.appendChild(opt);
    }
    if (Array.from(sel.options).some((o) => o.value === prev)) {
      sel.value = prev;
    }
  }

  buildLayerMatrix() {
    const root = $("layerMatrix");
    root.innerHTML = "";
    this.layerChips = new Map();
    for (const l of this.bridge.getStatus().layerStates) {
      const chip = document.createElement("div");
      chip.className = "layer-chip";
      chip.innerHTML = `<span>${l.name}</span><div class="fade-line"><i></i></div>`;
      root.appendChild(chip);
      this.layerChips.set(l.name, {
        el: chip,
        bar: chip.querySelector("i"),
      });
    }
  }

  updateConnUI(status) {
    const dot = $("osDot");
    const badge = $("osConnBadge");
    const btn = $("connectBtn");
    dot.className = `status-dot ${status}`;

    if (status === "connected") {
      badge.textContent = "Connected";
      badge.className = "badge accent";
      btn.textContent = "Disconnect";
    } else if (status === "connecting") {
      badge.textContent = "Connecting...";
      badge.className = "badge warn";
      btn.textContent = "Cancel";
    } else if (status === "dry-run") {
      badge.textContent = "Dry Run";
      badge.className = "badge accent";
      btn.textContent = "Stop Dry Run";
    } else {
      badge.textContent = "Offline";
      badge.className = "badge";
      btn.textContent = "Connect";
    }
  }

  updateTelemetryUI(values) {
    // Meters
    for (const el of document.querySelectorAll(".meter[data-key]")) {
      const key = el.dataset.key;
      const v = Math.min(1, Math.max(0, values[key] ?? 0));
      el.querySelector("i").style.width = `${(v * 100).toFixed(1)}%`;
      el.querySelector("em").textContent = v.toFixed(2);
    }

    // Keyboard header readout
    $("statHeld").textContent = String(this.pianoView.heldNotes.size);
    $("statSus").textContent = String(this.pianoView.sustained.size);
    $("statNotes").textContent = String(this.pianoView.count);
    $("statLast").textContent = this.pianoView.lastName || "--";

    // Bass indicator
    const bass = values.bass ?? -1;
    let bassText = "Bass: --";
    if (bass >= 0) {
      const name = noteName(bass);
      if (bass <= this.bridge.config.bassSplit) {
        const dest = PITCH_BODY[bass % 12];
        bassText = `Bass: ${name} -> ${dest === OUTWARD ? "Outward" : dest}`;
      } else {
        bassText = `Bass: ${name} (above split)`;
      }
    }
    $("bassBadge").textContent = bassText;

    // Bridge status
    const st = this.bridge.getStatus();
    $("osCameraState").textContent = st.state;
    $("osDist").textContent = st.distanceText;
    $("osTimeRate").textContent = st.timeRateText;
    $("osLayersCount").textContent = `${st.unlockedCount} / ${st.liveLayerCount} live (+${st.progressFrac.toFixed(2)})`;
    $("osTxCount").textContent = String(st.sent);
    $("boostBadge").textContent = `Size x${st.sizeBoost.toFixed(1)}`;

    // Update layer chips if drawer is open
    const drawer = document.querySelector(".layer-drawer");
    if (drawer && drawer.open) {
      for (const l of st.layerStates) {
        const chip = this.layerChips.get(l.name);
        if (!chip) continue;
        chip.el.classList.toggle("dead", !l.live);
        chip.el.classList.toggle("unlocked", l.unlocked);
        chip.bar.style.width = `${Math.round(l.fade * 100)}%`;
      }
    }

    // Update rolling status live timer
    if (this.player.mode === "rolling" || this.player.mode === "single") {
      this.updatePlaybackUI(this.player.getStatus());
    }
  }

  updatePlaybackUI(snap) {
    const badge = $("playBadge");
    if (snap.mode === "idle") {
      badge.textContent = "Idle";
      badge.className = "badge";
    } else if (snap.mode === "demo") {
      badge.textContent = "Demo";
      badge.className = "badge accent";
    } else if (snap.mode === "single") {
      const t = `${snap.time.toFixed(0)}s / ${snap.duration.toFixed(0)}s`;
      badge.textContent = `${snap.label} (${t})`;
      badge.className = "badge accent";
    } else if (snap.mode === "rolling") {
      if (snap.takenOver) {
        badge.textContent = "Yielded to Player";
        badge.className = "badge warn";
      } else {
        const t = snap.duration > 0 ? ` (${snap.time.toFixed(0)}s / ${snap.duration.toFixed(0)}s)` : "";
        badge.textContent = `Rolling: ${snap.label}${t}`;
        badge.className = "badge accent";
      }
      $("rdStatusText").textContent = snap.takenOver
        ? `Yielded to player -- resumes after ${this.player.rdIdle}s of silence.`
        : `Playing ${snap.label} (gain ${Math.round(snap.gain * 100)}%)`;
    }
  }

  showScoreStats(stats, name) {
    const el = $("scoreStatsText");
    if (!stats || stats.noteCount === 0) {
      el.textContent = `${name}: no notes found.`;
      return;
    }
    const destStr =
      stats.destinations.length > 0
        ? stats.destinations.map((d) => `${d.note}=${d.body}`).slice(0, 4).join(", ")
        : "fallback itinerary";
    el.textContent = `${name}: ${stats.noteCount} notes · ${stats.duration.toFixed(1)}s · ${stats.rangeText} · steers ${stats.steerPct}% (${destStr})`;
  }

  syncConfigToUI() {
    const c = this.bridge.config;
    $("cfgCamera").checked = c.camera;
    $("cfgLayers").checked = c.layers;
    $("cfgSizes").checked = !c.noSizes;
    $("cfgTime").checked = c.time;
    $("cfgTour").checked = c.tour;
    $("cfgBass").checked = c.bass;
    $("cfgHideLabels").checked = !c.keepLabels;
    $("cfgDryRun").checked = c.dryRun;

    $("cfgTruckGain").value = c.truckGain;
    $("cfgElevGain").value = c.elevationGain;
    $("cfgRollGain").value = c.rollGain;
    $("cfgRetarget").value = c.retargetTime;
    $("cfgLayerPace").value = c.layerPace;
    $("cfgHold").value = c.hold;
    $("cfgBassSplit").value = c.bassSplit;
    $("cfgTourMidpoint").value = c.tourMidpoint;
    $("cfgDriftTime").value = c.driftTime;
    $("cfgTimeMin").value = c.timeMin;
    $("cfgTimeMax").value = c.timeMax;
    $("cfgTimeGain").value = c.timeGain;
    $("cfgTimeCurve").value = c.timeCurve;
    $("cfgTimeBuild").value = c.timeBuild;
    $("cfgTimeDecay").value = c.timeDecay;
    $("cfgTrebleBoost").value = c.trebleBoost;

    this.pianoView.setBassSplit(c.bassSplit);

    for (const btn of document.querySelectorAll("#modePresetGroup .seg-btn")) {
      btn.classList.toggle("active", btn.dataset.mode === c.mode);
    }
  }

  async toggleConnection() {
    if (this.link.connected || this.link.ws !== null) {
      await this.bridge.restore();
      this.link.close();
      this.bridge.resetForConnect();
      this.updateConnUI("disconnected");
      return;
    }

    const host = $("osHost").value.trim() || "localhost";
    const port = Number($("osPort").value) || 4682;
    const useTls = $("osTls").checked;
    const dryRun = $("cfgDryRun").checked;

    this.bridge.config.dryRun = dryRun;
    this.bridge.resetForConnect();
    try {
      await this.link.connect(host, port, { dryRun, useTls });
      await this.bridge.probe();
    } catch (err) {
      this.log("error", `Connection failed: ${err.message || err}`);
    }
  }

  async handleFileImport(file) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    try {
      let events;
      let stats;
      if (lower.endsWith(".score") || lower.endsWith(".csv") || lower.endsWith(".txt")) {
        const text = await file.text();
        events = parseScoreText(text);
        stats = computeScoreStats(events, this.bridge.config.bassSplit);
      } else {
        const buf = await file.arrayBuffer();
        const dropBass = $("midiDropBass").checked ? 1 : 0;
        const keepDrums = $("midiKeepDrums").checked;
        const res = parseMidiFile(buf, {
          bassOctaves: dropBass,
          drums: keepDrums,
        });
        events = res.events;
        stats = computeScoreStats(events, this.bridge.config.bassSplit);
        if (res.moved > 0) {
          this.log("info", `Transposed ${res.moved} left-hand notes down 1 octave for steering`);
        }
      }
      this.player.loadSingle(file.name, events);
      this.showScoreStats(stats, file.name);
      this.log("info", `Loaded ${file.name}: ${stats.noteCount} notes over ${stats.duration.toFixed(1)}s`);
    } catch (err) {
      this.log("error", `Failed to parse ${file.name}: ${err.message || err}`);
    }
  }

  bindUI() {
    $("connectBtn").addEventListener("click", () => this.toggleConnection());
    $("midiRefreshBtn").addEventListener("click", () => this.midi.init());
    $("midiSelect").addEventListener("change", (e) => {
      this.midi.setSelectedInput(e.target.value);
    });

    $("audioMuteBtn").addEventListener("click", () => {
      const nextMuted = !this.synth.muted;
      this.synth.setTimbre({ muted: nextMuted });
      $("audioMuteBtn").textContent = `Sound: ${nextMuted ? "Muted" : "On"}`;
      $("audioMuteBtn").classList.toggle("active", nextMuted);
    });
    $("audioVol").addEventListener("input", (e) => {
      this.synth.resume();
      this.synth.setTimbre({ volume: Number(e.target.value) });
    });

    $("panicBtn").addEventListener("click", () => this.panic());

    // Sustain pedal button (toggle)
    $("pedalBtn").addEventListener("click", () => {
      this.synth.resume();
      this.handlePedal(!this.analyzer.pedal);
    });
    $("showRollChk").addEventListener("change", (e) => {
      this.pianoView.showRoll = e.target.checked;
    });
    $("clearRollBtn").addEventListener("click", () => this.pianoView.clearRoll());

    // Mode presets
    for (const btn of document.querySelectorAll("#modePresetGroup .seg-btn")) {
      btn.addEventListener("click", () => {
        this.bridge.applyModePreset(btn.dataset.mode);
        this.syncConfigToUI();
        if (this.link.connected && this.bridge.config.camera && !this.bridge.config.dryRun) {
          this.bridge.setRetarget(this.bridge.config.retargetTime);
          if (this.bridge.config.layers && this.bridge.tourStops.length === 0) {
            this.bridge.probe();
          }
        }
      });
    }

    // Config checkboxes
    $("cfgCamera").addEventListener("change", (e) => {
      this.bridge.config.camera = e.target.checked;
      if (!e.target.checked) {
        this.bridge.config.lockFocus = null;
        this.bridge.setFocusLock(null);
      }
    });
    $("cfgLayers").addEventListener("change", (e) => {
      this.bridge.config.layers = e.target.checked;
    });
    $("cfgSizes").addEventListener("change", (e) => {
      this.bridge.config.noSizes = !e.target.checked;
    });
    $("cfgTime").addEventListener("change", async (e) => {
      this.bridge.config.time = e.target.checked;
      if (!e.target.checked && this.link.connected) {
        await this.bridge.restoreTime();
        this.bridge.timeLive = false;
      }
    });
    $("cfgTour").addEventListener("change", (e) => {
      this.bridge.config.tour = e.target.checked;
    });
    $("cfgBass").addEventListener("change", (e) => {
      this.bridge.config.bass = e.target.checked;
    });
    $("cfgHideLabels").addEventListener("change", (e) => {
      this.bridge.config.keepLabels = !e.target.checked;
      if (e.target.checked && this.link.connected && !this.bridge.config.dryRun) {
        this.bridge.hideText();
      }
    });
    $("cfgDryRun").addEventListener("change", (e) => {
      this.bridge.config.dryRun = e.target.checked;
    });

    // Bridge action buttons
    $("resetLayersBtn").addEventListener("click", () => {
      this.bridge.resetLayers();
      this.log("info", "Layer accrual reset (fading out)");
    });
    $("restoreOsBtn").addEventListener("click", () => this.bridge.restore());

    $("applyLockBtn").addEventListener("click", () => {
      const node = $("lockSelect").value || null;
      this.bridge.config.lockFocus = node;
      this.bridge.setFocusLock(node);
    });
    $("releaseLockBtn").addEventListener("click", () => {
      $("lockSelect").value = "";
      this.bridge.config.lockFocus = null;
      this.bridge.setFocusLock(null);
    });

    // Numeric tuning bindings
    const numBind = (id, key, onChange) => {
      $(id).addEventListener("change", (e) => {
        const val = Number(e.target.value);
        if (Number.isFinite(val)) {
          this.bridge.config[key] = val;
          if (onChange) onChange(val);
        }
      });
    };
    numBind("cfgTruckGain", "truckGain");
    numBind("cfgElevGain", "elevationGain");
    numBind("cfgRollGain", "rollGain");
    numBind("cfgRetarget", "retargetTime", (v) => {
      if (this.link.connected && this.bridge.config.camera && !this.bridge.config.dryRun) {
        this.bridge.setRetarget(v);
      }
    });
    numBind("cfgLayerPace", "layerPace");
    numBind("cfgHold", "hold");
    numBind("cfgBassSplit", "bassSplit", (v) => this.pianoView.setBassSplit(v));
    numBind("cfgTourMidpoint", "tourMidpoint");
    numBind("cfgDriftTime", "driftTime");
    numBind("cfgTimeMin", "timeMin");
    numBind("cfgTimeMax", "timeMax");
    numBind("cfgTimeGain", "timeGain");
    numBind("cfgTimeCurve", "timeCurve");
    numBind("cfgTimeBuild", "timeBuild");
    numBind("cfgTimeDecay", "timeDecay");
    numBind("cfgTrebleBoost", "trebleBoost");

    // Demo controls
    $("demoTempo").addEventListener("change", (e) => {
      this.player.demoTempo = Number(e.target.value) || 72;
    });
    $("demoPlayBtn").addEventListener("click", () => {
      this.synth.resume();
      this.player.demoTempo = Number($("demoTempo").value) || 72;
      this.player.startDemo();
    });
    $("demoStopBtn").addEventListener("click", () => this.player.stopDemo());

    // Rolling controls
    $("rdYieldChk").addEventListener("change", (e) => {
      this.player.rdYield = e.target.checked;
    });
    $("rdIdleInput").addEventListener("change", (e) => {
      this.player.rdIdle = Math.max(1, Number(e.target.value) || 5);
    });
    $("rdStartBtn").addEventListener("click", () => {
      this.synth.resume();
      this.player.startRolling(performance.now() / 1000);
    });
    $("rdSkipBtn").addEventListener("click", () => this.player.skip());
    $("rdStopBtn").addEventListener("click", () => this.player.stopRolling());

    // Single score controls
    $("songSelect").addEventListener("change", async (e) => {
      try {
        const loaded = await this.fetchBundledScore(e.target.value);
        this.player.loadSingle(loaded.name, loaded.events);
        this.showScoreStats(computeScoreStats(loaded.events, this.bridge.config.bassSplit), loaded.name);
      } catch (err) {
        this.log("error", `Failed to load ${e.target.value}: ${err.message || err}`);
      }
    });
    $("songPlayBtn").addEventListener("click", async () => {
      this.synth.resume();
      if (!this.player.singleEvents) {
        const sel = $("songSelect").value;
        const loaded = await this.fetchBundledScore(sel);
        this.player.loadSingle(loaded.name, loaded.events);
      }
      this.player.startSingle();
    });
    $("songStopBtn").addEventListener("click", () => this.player.stopSingle());
    $("midiLoopChk").addEventListener("change", (e) => {
      this.player.midiLoop = e.target.checked;
    });
    $("autoLockChk").addEventListener("change", (e) => {
      this.player.focusLockEnabled = e.target.checked;
    });
    $("midiRate").addEventListener("input", (e) => {
      const rate = Number(e.target.value) || 1;
      this.player.midiRate = rate;
      $("midiRateVal").textContent = `${rate.toFixed(2)}x`;
    });

    // Dropzone & file upload
    const dropZone = $("dropZone");
    $("browseFileBtn").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => {
      if (e.target.files?.[0]) this.handleFileImport(e.target.files[0]);
      e.target.value = "";
    });
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file) this.handleFileImport(file);
    });

    // Synth timbre sliders
    const bindSynth = (inputId, valId, prop) => {
      $(inputId).addEventListener("input", (e) => {
        const v = Number(e.target.value);
        $(valId).textContent = v.toFixed(2);
        this.synth.setTimbre({ [prop]: v });
      });
    };
    bindSynth("synBodyMix", "valBodyMix", "bodyMix");
    bindSynth("synC1", "valC1", "c1Scale");
    bindSynth("synC3", "valC3", "c3Scale");
    bindSynth("synPos", "valPos", "pos");
    bindSynth("synDetune", "valDetune", "detune");

    // Log controls
    $("verboseLuaChk").addEventListener("change", (e) => {
      this.bridge.config.verbose = e.target.checked;
      this.midi.verbose = e.target.checked;
    });
    $("clearLogBtn").addEventListener("click", () => {
      this.logLines = [];
      $("logConsole").innerHTML = "";
    });

    // QWERTY musical keyboard
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        this.synth.resume();
        this.handlePedal(true);
        return;
      }
      const note = QWERTY_MAP[e.code];
      if (note !== undefined && !this.qwertyHeld.has(e.code)) {
        e.preventDefault();
        this.qwertyHeld.add(e.code);
        this.handleNoteOn(note, 0.72, true);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        const tag = document.activeElement?.tagName;
        if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
          this.handlePedal(false);
        }
        return;
      }
      const note = QWERTY_MAP[e.code];
      if (note !== undefined && this.qwertyHeld.has(e.code)) {
        this.qwertyHeld.delete(e.code);
        this.handleNoteOff(note, true);
      }
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.__app = new App();
});
