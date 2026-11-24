# OpenSpace Piano Instrument

An interactive audiovisual instrument that connects a MIDI piano (or built-in automated scores) to **OpenSpace**.

It is available in two ways:
1. **Web Version *(Recommended — zero install beyond OpenSpace)*:** Runs directly in a browser via Web MIDI + Web Audio and connects straight to OpenSpace's WebSocket interface on port `4682`.
2. **Desktop Version (SuperCollider + Python Bridge):** Connects via SuperCollider (`openspace_piano.scd`) and `openspace_bridge.py` over TCP port `4681`.

---

## Web Version (No SuperCollider / Python Required)

```text
MIDI / Score / UI  ──►  Browser (Web MIDI + Web Audio + JS Engine)  ──►  WebSocket (:4682)  ──►  OpenSpace
```

### Quick Start (Local)
1. Launch **OpenSpace** and load your scene profile (ensure simulation time is unpaused with `Spacebar`).
2. Start a static web server in this folder — on Windows, double-click **`runWeb.bat`**, or run:
   ```powershell
   python -m http.server 8080
   ```
3. Open [http://localhost:8080/](http://localhost:8080/) in **Chrome, Edge, Opera, or Firefox** (note: Safari does not support Web MIDI).
4. Click **Connect** (defaults to `localhost:4682`), then play your MIDI keyboard, click the 88-key canvas, use QWERTY keys (`Z..M`, `Q..I`, `Space` = sustain), or start the **Built-in Demo** / **Rolling Playlist**.
5. You can also drag and drop any `.mid` or `.score` file directly onto the page to convert and play it in-browser.

### Hosting on GitHub Pages
Because everything is static (`index.html`, `web/*.js`, `web/styles.css`, `Songs/*.score`), you can push this folder to GitHub and enable **GitHub Pages** on the repository root:
* When opened over `https://<user>.github.io/<repo>/`, connecting to a **local** OpenSpace instance (`ws://localhost:4682` or `ws://127.0.0.1:4682`) works in modern browsers because loopback addresses are exempt from mixed-content blocking, and HTTPS satisfies Web MIDI's secure-context requirement.
* **Multi-machine / dome note:** Browsers block plain `ws://` connections from an `https://` page to a non-localhost LAN IP. For a remote OpenSpace Master node, either run the page locally over `http://localhost:8080`, open the site on the Master node itself, or place a `wss://` proxy in front of port `4682` (and add the client IP to `AllowAddresses` in `openspace.cfg`).

---

## Desktop Version (SuperCollider + Python Bridge)

```text
MIDI Piano / Score  ──►  SuperCollider (Synth + Analysis)  ──►  UDP/OSC (:7000)  ──►  openspace_bridge.py  ──►  TCP JSON (:4681)  ──►  OpenSpace
```

This implementation is self-contained and requires **zero third-party Python (`pip`) packages** and **zero SuperCollider plugins or Quarks**.

---

## 1. Prerequisites

Install the following three applications on the target machine:

1. **Python 3** (3.7 or newer) — [https://www.python.org/downloads/](https://www.python.org/downloads/)
   * *Windows installer note:* Check **"Add python.exe to PATH"** during installation.
   * Uses only the Python standard library (`socket`, `struct`, `json`, `argparse`, `math`, `time`, `signal`, `itertools`, `sys`).
2. **SuperCollider** — [https://supercollider.github.io/](https://supercollider.github.io/)
   * Uses only standard built-in UGens and GUI classes (no `sc3-plugins` or `SCLOrkSynths` required).
3. **OpenSpace** (supports **0.22.0 / 0.22.1+** as well as earlier releases) — [https://www.openspaceproject.com/](https://www.openspaceproject.com/)

---

## 2. Included Files

| File | Purpose |
| :--- | :--- |
| `openspace_bridge.py` | Receives real-time analysis values from SuperCollider over UDP/OSC (port `7000`) and drives OpenSpace over its TCP Socket API (port `4681`). Includes the OpenSpace 0.22+ API v1.0.0 handshake. |
| `runPython.bat` | Launches `openspace_bridge.py` in normal mode (camera navigation, scene layers, and point-cloud sizing; simulation time speed is left untouched). |
| `runPython_Slow.bat` | Launches `openspace_bridge.py --slow` (limits camera rotation movement: gentler elevation orbit, minimal roll, and slower 40s focus turns). |
| `runPython_TimeOnly.bat` | Launches `openspace_bridge.py --time-only` (disables all camera movement and layer changes; only controls simulation time speed). |
| `openspace_piano.scd` | SuperCollider patch containing the polyphonic piano synthesizer (`\kbPiano`), MIDI listener, real-time playing analyzer, rolling score playlist, and 2-minute built-in demo. |
| `piano_view.scd` | *(Optional)* Standalone 88-key visual keyboard and scrolling piano-roll window in SuperCollider. |
| `Songs/mid_to_score.py` | *(Optional)* Command-line converter that turns standard `.mid` files into `.score` files for self-playing mode. |
| `Songs/*.score` | Pre-converted piano scores (`FlyMeToTheMoon.score`, `Space-Oddity.score`, `LifeonMars.score`, `Rocket-Man-2.score`, `InterstellarCornfieldChase.score`, `Hans-Zimmer-Time-Inception.score`, `A Sky Full of Stars.score`). |

---

## 3. Step-by-Step Startup Guide

### Step 1: Start OpenSpace
1. Launch **OpenSpace** and start your scene profile (e.g., *Default* or *Default Full*).
2. Wait for the scene to finish loading and make sure simulation time is **unpaused** (`Spacebar`).
   * *Note for multi-computer / dome clusters:* By default, OpenSpace authorizes `127.0.0.1` and `localhost` on TCP port `4681`. If you run the piano and bridge on a separate machine from the OpenSpace Master node, add the piano machine's IP address to `AllowAddresses` under `Server.Interfaces` (`DefaultTcpSocketInterface`) in the Master node's `openspace.cfg`, and pass `--os-host <OPENSPACE_IP>` to `openspace_bridge.py`.

---

### Step 2: Start the Python Bridge
Double-click one of the included batch files, or run from a terminal in this folder:

* **Normal Mode (Camera + Scene Layers + Point Sizes; Time Speed Untouched):**
  Double-click **`runPython.bat`**, or run:
  ```powershell
  python openspace_bridge.py
  ```

* **Slow Rotation Mode (Limits Camera Rotation Movement):**
  Double-click **`runPython_Slow.bat`**, or run:
  ```powershell
  python openspace_bridge.py --slow
  ```

* **Time-Only Mode (Camera & Layers Untouched — Time Speed Only):**
  Double-click **`runPython_TimeOnly.bat`**, or run:
  ```powershell
  python openspace_bridge.py --time-only
  ```

Once connected, the terminal will display a live status readout at 2 Hz. When you stop the bridge with **`Ctrl+C`**, it automatically restores OpenSpace's original simulation delta time and camera retarget interpolation time.

---

### Step 3: Start the SuperCollider Piano Patch
1. Connect a USB MIDI keyboard (optional — you can also use the built-in demo or `.score` files without a keyboard).
2. Open **`openspace_piano.scd`** in the **SuperCollider IDE**.
3. Place your cursor anywhere inside the main `( ... )` block (lines `54`–`1239`) and press **`Ctrl+Enter`** (`Cmd+Enter` on macOS).
4. SuperCollider will boot the audio server, compile the built-in `\kbPiano` and `\kbBody` SynthDefs, connect to all available MIDI inputs, and begin streaming OSC to `127.0.0.1:7000`. Watch the Post Window for:
   ```text
   booting the server...
   synth ready
   midi listening
   streaming OSC to 127.0.0.1 : 7000 — play.
   ```

> **Audio Device Note:** By default, `openspace_piano.scd` uses your computer's default audio output. To select a specific ASIO or external audio interface, uncomment and edit lines `281`–`282` in `openspace_piano.scd` before evaluating:
> ```supercollider
> s.options.inDevice  = "Your Audio Device Name";
> s.options.outDevice = "Your Audio Device Name";
> ```

---

### Step 4 *(Optional)*: Open the 88-Key Visual Keyboard
1. Open **`piano_view.scd`** in SuperCollider.
2. Place your cursor inside the main `( ... )` block (lines `50`–`374`) and press **`Ctrl+Enter`**.
3. It automatically attaches to `openspace_piano.scd` and displays live key velocities, pedal sustain state (in blue), and a scrolling piano roll for both live playing and automated scores.

---

## 4. Playback & Installation Controls (in SuperCollider)

At the bottom of **`openspace_piano.scd`** (lines `1242`–`1412`), you will find one-line utility commands. Place your cursor on any line or small block and press **`Ctrl+Enter`**:

### Unattended Rolling Playlist (Installation Mode)
Cycles through the `.score` files in the folder. If a visitor touches the MIDI keyboard, the automated song smoothly fades out and hands control to the player; after 5 seconds of silence (`~rdIdle`), the playlist resumes from where it paused:
```supercollider
~rdStart.value;   // start the rolling playlist
~rdSkip.value;    // skip to the next song immediately
~rdStop.value;    // stop the rolling playlist
```
*(Tip: Set `~rdAuto = true;` at line `140` of `openspace_piano.scd` if you want the rolling playlist to start automatically whenever the main block is evaluated.)*

### Built-In 2-Minute Demo
Plays a written-out piece designed to exercise every register and mapping in order:
```supercollider
~demo.play;       // start the demo
~demoStop.value;  // stop the demo
```

### Play a Specific `.score` File
```supercollider
(
~midiLoad.value(~scoreDir +/+ "FlyMeToTheMoon.score");
~midiPlay.value;
)

~midiStop.value;  // stop score playback
```

### Convert Your Own `.mid` File to `.score`
Run in a terminal from this folder:
```powershell
python Songs/mid_to_score.py "Songs/yourfile.mid" --bass-octaves 1
```
Then load `"yourfile.score"` in SuperCollider with `~midiLoad` and `~midiPlay`.

---

## 5. How the Musical Mappings Work

### Simulation Time Speed
* **Sequential Note Density (Chord-Filtered):** Time speed is driven by how rapidly sequential notes are played (`density`). Notes struck within `55 ms` of each other (`TIME_CHORD_WINDOW = 0.055`) are grouped as a single chord onset where each extra finger adds only `0.12` weight (`TIME_CHORD_WEIGHT = 0.12`), so block chords do not artificially spike the simulation speed.
* **Progressive Build-Up Over Duration:** As the piano is played continuously, a long-play accumulator (`time_build`) climbs over `60 seconds` (`TIME_BUILD_SECS = 60.0`), gradually raising both the baseline speed and unlocking the upper speed range (up to `TIME_MAX`, 1 week/sec by default).
* **Gentle Coast-Down:** When playing slows down or stops, time decelerates smoothly (`TIME_LAG_DOWN = 6.0s`) and unwinds back to `1x` real-time over `30 seconds` (`TIME_DECAY_SECS = 30.0s`).

### Camera & Scene Layers *(when not using `--time-only`)*
* **Bass Register (`<= C#2` / MIDI 37):** Steers the camera's destination body chromatically outward (`C` = Sun, `C#` = Mercury, `D` = Venus, `Eb` = Moon, `E` = Earth, `F` = Mars, `F#` = Jupiter, `G` = Saturn, `G#` = Uranus, `A` = Neptune, `Bb` = Pluto, `B` = outward into deep space).
* **Continuous Playing Duration & Intensity:** Progressively unlocks and latches up to 70 OpenSpace scene layers (trails, grids, constellations, exoplanets, star clusters, galaxies, deep-sky surveys), which fade back out after silence.
* **Register Bands & High Treble (`>= C6`):** Modulates the scale factor of abstract astronomical point clouds corresponding to the register being played.

---

## 6. Bridge Configuration & CLI Options

You can customize behavior either by passing command-line flags to `openspace_bridge.py` or by editing the constants near the top of `openspace_bridge.py` (lines `40`–`60` and `513`–`530`).

| Flag | Constant in `openspace_bridge.py` | Default | Description |
| :--- | :--- | :--- | :--- |
| `--slow` | `SLOW_MODE` | `False` | Limit camera rotation movement (caps elevation rotation to `0.08`, roll to `0.03`, orbit to `0.005`, and slows focus retarget turns to `40s`) |
| `--time-only` | `TIME_ONLY` | `False` | Stop all camera movement and leave scene layers, point sizes, and labels untouched; only control simulation time speed |
| `--no-camera` | `CAMERA` (`True`) | `False` | Stop all camera movement (tour, bass steering, focus lock, zoom, rotation, roll) while keeping scene layers active |
| `--no-layers` | `DRIVE_LAYERS` (`True`) | `False` | Leave scene renderables/layers untouched |
| `--time` | `DRIVE_TIME` (`False`) | `False` | Also drive simulation time speed in normal mode (enabled automatically by `--time-only`) |
| `--time-min DT` | `TIME_MIN` | `1.0` | Simulation speed in silence (`1.0` = real-time) |
| `--time-max DT` | `TIME_MAX` | `604800.0` | Maximum simulation speed at full playing (`604800` = 1 week/s; `86400` = 1 day/s) |
| `--time-gain G` | `TIME_GAIN` | `1.2` | Sensitivity multiplier on incoming note onset rate |
| `--time-curve C` | `TIME_CURVE` | `0.8` | Exponent on playing speed (`< 1` reacts sooner to gentle playing; `> 1` requires faster playing) |
| `--time-build SEC` | `TIME_BUILD_SECS` | `60.0` | Seconds of continuous playing to reach full long-play time boost (`0` disables build-up) |
| `--time-decay SEC` | `TIME_DECAY_SECS` | `30.0` | Seconds of silence for accumulated time speed to unwind back to `TIME_MIN` |
| `--keep-labels` | — | `False` | Do not hide scene text labels or dashboard text on startup |
| `--dry-run` | — | `False` | Decode OSC and print Lua without connecting to OpenSpace |

---

## 7. Troubleshooting

* **Time speed is changing in the bridge readout, but planets aren't moving in OpenSpace:**
  * Check that OpenSpace's clock is not paused (press `Spacebar` in OpenSpace). The bridge also warns at startup if OpenSpace reports `isPaused = true`.
* **`waiting for OpenSpace on 127.0.0.1:4681...`:**
  * Make sure OpenSpace is running and has finished loading its profile.
* **No sound from SuperCollider:**
  * Check the SuperCollider Post Window during boot to see which audio output device `scsynth` selected, or set `s.options.outDevice` explicitly in `openspace_piano.scd` (lines `281`–`282`).
* **Re-evaluating `openspace_piano.scd` while `piano_view.scd` is open:**
  * If you re-evaluate `openspace_piano.scd`, evaluate `~pvAttach.value;` (or re-run `piano_view.scd`) so the visualizer re-hooks the newly created note functions.
