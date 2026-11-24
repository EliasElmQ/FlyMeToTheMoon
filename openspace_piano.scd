// =====================================================================
//  openspace_piano.scd
//
//  MIDI piano -> SuperCollider (synth + analysis) -> OSC -> bridge -> OpenSpace
//
//  The bridge is openspace_bridge.py, in this folder. Start it first;
//  OpenSpace itself does not speak OSC.
//
//      python openspace_bridge.py
//
//  Play the piano, and the universe assembles itself around you.
//    - the bass note / chord root  -> which body the camera travels to.
//                                     C = Sun, then chromatically outward:
//                                     Eb Moon, E Earth, F Mars, F# Jupiter,
//                                     G Saturn, G# Uranus, A Neptune,
//                                     Bb Pluto, B = outward without end
//    - how fast you play           -> simulation time speed in OpenSpace
//    - how fast / hard you play    -> how fast you travel, and how quickly
//                                     scene layers accumulate
//    - how long you keep playing   -> how many layers; they latch until you stop
//    - where you play on the board -> hot vs cool objects, camera elevation
//    - how dissonant you play      -> violent objects, roll turbulence
//    - how many keys you hold      -> star clusters, deep-sky surveys
//    - anything at C6 and above    -> blows up the size of the
//                                     abstract point clouds
//    - silence                     -> empty void, camera at rest
//
//  ONE BLOCK to run: put the cursor inside the big parenthesis below and hit
//  Ctrl+Enter (Win/Linux) or Cmd+Enter (macOS). It boots the server, defines
//  the voice, connects MIDI and starts both loops, in order, from a single
//  Routine. Re-evaluating it is safe: it stops whatever the last evaluation
//  started before setting up again.
//
//  NO KEYBOARD? A demo piece is built in. Evaluate the block, then evaluate
//  `~demo.play` on its own: two minutes of written-out music that walks the
//  camera out through the solar system and exercises every mapping in turn.
//  `~demoStop.value` stops it, `~demoAuto = true` makes it start itself. It
//  drives the same functions MIDI does, so it is not a special case -- and you
//  can play along over the top of it.
//
//  UNATTENDED? `~rdStart.value` rolls a playlist of scores (~rdSongs). Touch
//  the keyboard and it fades out and hands over; stop playing and it resumes
//  ten seconds later, from where it paused. That is the installation mode:
//  it demonstrates itself between visitors and gets out of the way for one.
//
//  The small snippets at the bottom are utilities — panic, stop, quiet the
//  readout — to run as needed.
// =====================================================================


// ---------------------------------------------------------------------
//  EVERYTHING — evaluate this one block
// ---------------------------------------------------------------------
(
// --- OSC destination -------------------------------------------------
// This goes to openspace_bridge.py, NOT to OpenSpace itself: OpenSpace has no
// inbound OSC (its telemetry module only sends OSC out, for sonification).
~osHost   = "127.0.0.1";
~osPort   = 7000;              // must match OSC_PORT in openspace_bridge.py
~os       = NetAddr(~osHost, ~osPort);
~prefix   = "/piano";          // OSC namespace; must match PREFIX in the bridge
~sendRate = 30;                // continuous updates per second

// --- Analysis tuning -------------------------------------------------
~histWindow  = 3.0;   // seconds of note history used for density/centroid
~densityMax  = 12.0;  // notes/sec that counts as "flat out" (-> density 1.0)
~chordWindow = 0.055; // notes struck within 55 ms of each other count as one
                      //   chord attack rather than separate sequential notes
~chordWeight = 0.12;  // how much each extra note in a chord adds to density
~loudDecay   = 0.975; // per-tick decay of the loudness accumulator (0.9-0.995)
~energySmooth= 0.12;  // 0 = frozen, 1 = instant. Lower = more cinematic.
~polyMax     = 8;     // held notes that counts as maximum polyphony
~trebleSplit = 84;    // C6. Notes at or above this drive the top-register
                      //   accumulator, which the bridge uses to blow up the
                      //   size of the abstract point clouds.
// The keyboard is tiled into four registers. Each drives its own group of
// abstract point clouds, so which part of the sky reacts depends on where you
// play: the registers run OUTWARD, from what is inside the Milky Way at the
// bottom of the keyboard to the deepest surveys at the top. ~trebleSplit
// below is the fourth band. The bridge's BAND_OF table owns the assignment;
// these boundaries only decide where one register ends and the next begins.
~bandLowMax  = 47;    // A0-B2   -> nebulae, remnants, clusters, dwarfs, pulsars
~bandMidMax  = 71;    // C3-B4   -> exoplanets, deep-sky objects, 2MASS
~bandHighMax = 83;    // C5-B5   -> galaxy groups, Tully, Abell, 6dF
~trebleDecay = 0.955; // per-tick decay of that accumulator. Faster than
                      //   ~loudDecay so it tracks the notes rather than
                      //   smearing into a general loudness.

// --- Demo ------------------------------------------------------------
// For demonstrating the whole chain with no keyboard attached. The piece
// itself is section 8, down inside the block.
~demoAuto  = false;  // true = start playing as soon as this block is evaluated
~demoTempo = 72;     // bpm
// Set by piano_autorun.scd. Leave nil for normal interactive use.
~autoStartScore = ~autoStartScore ? nil;

// --- Playing a MIDI file ---------------------------------------------
// Convert first, with the Python tool in the Songs folder:
//
//     python Songs/mid_to_score.py chopin.mid
//
// which writes chopin.score and prints a report -- read it, because it tells
// you whether the piece will actually steer the camera. Real piano writing
// puts its bass around E2-C3, above the bridge's BASS_SPLIT, so an unmodified
// file navigates nowhere and the camera quietly follows its own itinerary
// instead. `--bass-octaves 1` fixes that without changing which bodies the
// piece visits, since the pitch classes are what choose them.
//
// Then, in here:  ~midiLoad.value(~scoreDir +/+ "chopin.score");
//                 ~midiPlay.value;
//
// FlyMeToTheMoon is bundled as a worked example -- see the block at the
// bottom of the file. It needs no transposing: its bass already reaches C1,
// so it steers on its own.
//~scoreDir = "H:/Piano";
~scoreDir = thisProcess.nowExecutingPath.dirname +/+ "Songs";

~midiLoop = false;   // true to repeat the file, like the demo does

// Some pieces start by flying to a specific body first (e.g. FlyMeToTheMoon
// flies to the Moon first, and once it arrives there, continues on to other
// planets). Set ~focusLock = false to skip this initial destination.
~focusLock = true;
~focusLockFor = [           // filename fragment -> first scene graph node to visit
	["FlyMeToTheMoon", "Moon"]
];
// --- Rolling demo ----------------------------------------------------
// A playlist that plays itself, gets out of the way the moment somebody
// touches the keyboard, and comes back when they stop. This is the mode
// for an unattended installation: the instrument demonstrates itself
// between visitors, and anyone who sits down simply plays.
//
// Scores, not .mid -- convert first:  python mid_to_score.py yours.mid
~rdSongs = [                 // played in order, then round again
	"FlyMeToTheMoon.score",        // 3m08 -- pins the camera to the Moon
	"LifeonMars.score",            // 3m45 -- steers 48%, visits Mars

	"Hans-Zimmer-Time-Inception.score", // 2m34 -- sparse, 6 notes/s, steers
	                               //   40% over six destinations

	"InterstellarCornfieldChase.score", // 2m07 -- 240 notes at C6+, ten times
	"Rocket-Man-2.score",           // 4m43 -- steers 20%, mostly Pluto,
	"Space-Oddity.score",          // 5m30 -- steers 50%, six destinations
	                               //   any other: the treble band, and so the
	                               //   deepest surveys, run hot throughout

	                               //   and the only one with pedal data
	"A Sky Full of Stars.score"    // 4m27 -- steers 56% after its left
	                               //   hand was dropped an octave
];                               // about 26 minutes the whole way round
// Per-song velocity trim, by filename fragment. Some exports sit near
// maximum velocity and are simply louder than the rest of the playlist.
// Measured mean velocity: most scores here are 0.22-0.40, Rocket-Man-2
// was 0.784, which is 2.1x the others once density and the pedal are
// accounted for. 0.5 puts it back among them.
~velTrim = [                 // filename fragment -> velocity multiplier
	["Rocket-Man", 0.5]
];

// Does the playback get out of the way when somebody plays?
//   true  -- it fades out and hands over. The installation default.
//   false -- it keeps playing and you play ALONG with it. Both sets of
//            notes go through ~noteOn, so the analysis sees the sum and
//            the visuals answer to the combination, not to either alone.
~rdYield   = true;
~rdIdle    = 5.0;   // seconds without a real key press before it resumes
~rdFadeOut = 1.5;    // seconds to duck out of the way when somebody plays
~rdFadeIn  = 2.5;    // ...and to come back
~rdGap     = 5.0;    // silence between songs, so the layers settle
~rdAuto    = false;  // true = start rolling when this block is evaluated

~midiRate = 1.0;     // playback speed; 0.5 is half tempo. Live: set it
                     //   while the piece plays and it takes effect at once

// --- Voice timbre ----------------------------------------------------
// Live-tunable: change any of these and re-evaluate the small snippet at the
// bottom of the file. New notes pick them up; notes already ringing do not.
~pos      = 0.13;  // where the hammer strikes along the string, 0..1.
                   //   Real actions hit around a seventh of the way along.
                   //   Lower is brighter and thinner, higher is mellower.
~c1Scale  = 1.0;   // decay length. Below 1 rings longer, above 1 shorter.
                   //   Scales the note's T60 directly, so 0.5 halves it.
~c3Scale  = 1.0;   // brightness. Below 1 is brighter, above 1 duller.
~detune   = 1.0;   // unison spread between the two strings, as a multiplier
                   //   on the built-in few-cents detuning.
~bodyMix  = 0.20;  // how much room; ~body.set(\mix, x) changes it live.
~bodyRoom = 0.50;  // room SIZE: a compact room.

// --- Scene layers ----------------------------------------------------
// Not configured here. The bridge owns the whole layer table — which scene
// nodes exist, which derived value each one is driven by, and at what
// threshold — because it is all OpenSpace-specific and there are seventy of
// them. See LAYERS in openspace_bridge.py.
//
// This file's job is to produce honest derived values; deciding what they
// reveal is the bridge's.

// --- Playing latency -------------------------------------------------
// Almost all of the delay between pressing a key and hearing it is the audio
// hardware buffer. On Windows, PortAudio picks MME or shared-mode WASAPI by
// default, which can be 20-200 ms; ASIO with a small buffer is 3-6 ms.
//
// Note that s.latency is NOT in this path and changing it will do nothing:
// Synth.new sends immediately, with no timestamp (see Node.sc, "immediately
// sends"). It only affects scheduled bundles, which this file does not use.
//
// To fix it: evaluate `ServerOptions.outDevices.do(_.postln)` on its own, then
// paste the exact string for an ASIO driver here and uncomment. inDevice and
// outDevice must be the SAME string — an ASIO driver is a single duplex
// device, and Server.sc only passes one -H argument when the two match.

s.options.outDevice  = "ASIO : Focusrite USB ASIO";
// s.options.inDevice  = "ASIO : Dante Virtual Soundcard (x64)";   // <- replace with yours
// s.options.outDevice = "ASIO : Dante Virtual Soundcard (x64)";   // <- must match inDevice
// s.options.hardwareBufferSize = 64;  // frames; try 256 if you get crackles
// s.options.sampleRate = 48000;        // match the driver, avoids resampling
s.options.blockSize = 64;            // default 64; halves block quantisation
s.options.numOutputBusChannels = 2;

// --- Tear down a previous evaluation ---------------------------------
// Defined before it is used so re-evaluating this block is safe, and left in
// the environment so the utility snippets at the bottom can call it.
~stopAll = {
	~task.notNil.if { ~task.stop };
	~monitor.notNil.if { ~monitor.stop };
	~demo.notNil.if { ~demo.stop };
	// A TempoClock owns a scheduling thread, so a re-evaluation that only
	// dropped the reference would leak one per run.
	~demoClock.notNil.if { ~demoClock.stop; ~demoClock = nil };
	~midiFile.notNil.if { ~midiFile.stop };
	~midiClock.notNil.if { ~midiClock.stop; ~midiClock = nil };
	~held.notNil.if {
		~held.do { |syn| syn.notNil.if { syn.set(\gate, 0) } };
		~held.clear;
	};
	// Free only our own MIDIdefs, by key, so anything else in the interpreter
	// is left alone. Note the lookup goes through MIDIdef.all and NOT through
	// MIDIdef(key): on a key that does not exist yet, MIDIdef(key) CREATES a
	// def with a nil function rather than returning nil (ResponseDefs.sc,
	// *new), which on a fresh interpreter would make three empty defs just to
	// free them again.
	[\ospNoteOn, \ospNoteOff, \ospPedal].do { |k|
		var def = MIDIdef.all[k];
		def.notNil.if { def.free };
	};
	~body.notNil.if { ~body.free; ~body = nil };
	~voiceGroup.notNil.if { ~voiceGroup.free; ~voiceGroup = nil };
	~fxBus.notNil.if { ~fxBus.free; ~fxBus = nil };
	~keysDown.notNil.if { ~keysDown.clear };
	~sustained.notNil.if { ~sustained.clear };
	~running = false;
};
~stopAll.value;

// --- Maths helpers ---------------------------------------------------
~lag = { |cur, target, coef| cur + ((target - cur) * coef) };

// dissonance weight per interval class (0 = unison .. 6 = tritone)
~icWeight = [0.0, 1.0, 0.7, 0.35, 0.25, 0.3, 0.85];

~chordTension = { |notes|
	var pairs = 0, total = 0.0;
	if (notes.size < 2) { 0.0 } {
		notes.do { |a, i|
			notes.copyRange(i + 1, notes.size - 1).do { |b|
				var d  = (a - b).abs % 12;
				var ic = min(d, 12 - d);
				total = total + ~icWeight[ic];
				pairs = pairs + 1;
			};
		};
		(total / pairs).clip(0, 1)
	}
};

// note number -> name, for the readout. The bass note is a control now, so
// seeing which one the bridge is acting on matters.
~noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
~noteName  = { |n|
	// Pad the finished string, not the name: padding the name would leave a
	// space inside it ("F 2" rather than "F2").
	var name = if (n < 0) { "--" } { ~noteNames[n % 12] ++ (n.div(12) - 1) };
	name.padLeft(4)
};

~fmt = { |val| val.round(0.01).asString.padLeft(5) };   // keeps columns steady


// --- The one Routine -------------------------------------------------
// Everything that has to happen in order happens here: boot, define the voice,
// wait for it to reach the server, connect MIDI, start the loops. bootSync
// needs a Routine to suspend in, which is exactly why this is one.
~main = Routine({

	// 1 -- server ------------------------------------------------------
	"booting the server...".postln;
	s.bootSync;   // returns immediately if it is already running

	// 2 -- the piano voice --------------------------------------------
	// Built-in additive piano model using standard SuperCollider UGens only:
	// eleven harmonic partials with frequency-dependent decay plus a filtered
	// noise hammer transient.
	SynthDef(\kbPiano, { |out = 0, freq = 440, vel = 0.6, gate = 1, pan = 0,
	                     pos = 0.13, c1Scale = 1, c3Scale = 1, detune = 1|
		var partials, hammer, body, env, decay;
		decay = 7.0 * (400 / (freq + 120)).clip(0.3, 3.5) / c1Scale;
		partials = Mix.fill(11, { |i|
			var n     = i + 1;
			var pfreq = freq * n;
			var pamp  = (1 / (n ** 1.35)) * LFNoise1.kr(0.2).range(0.8, 1.0);
			var penv  = EnvGen.kr(Env.perc(0.002, decay / (n ** 0.45)));
			SinOsc.ar(pfreq, 0, pamp * penv)
		});
		hammer = HPF.ar(
			WhiteNoise.ar(0.5) * EnvGen.kr(Env.perc(0.0005, 0.035)),
			1400
		);
		body = LPF.ar(partials + hammer, (freq * 9).clip(800, 16000));
		env  = EnvGen.kr(Env.asr(0.001, 1.0, 0.4), gate, doneAction: 2);
		Out.ar(out, Pan2.ar(body * env * (vel.squared * 0.9 + 0.05) * 0.35, pan));
	}).add;

	// The soundboard and the room. A string on its own sounds like a string
	// in a vacuum; the broad low-mid resonances of a large wooden plate, and
	// a little space around it, are most of what makes it read as an
	// instrument in a room. One instance for the whole keyboard, at the tail
	// of the group, so every voice goes through it.
	SynthDef(\kbBody, { |in = 0, out = 0, mix = 0.20, room = 0.50,
	                    damp = 0.5, amp = 2|
		var dry, wet, sig;
		dry = In.ar(in, 2);
		dry = BPeakEQ.ar(dry, 130,  1.0,  2.0);   // soundboard low resonance
		dry = BPeakEQ.ar(dry, 400,  0.9,  1.2);   // body
		dry = BPeakEQ.ar(dry, 3000, 1.2, -1.5);   // tame the strike glare
		dry = HPF.ar(dry, 30);
		wet = FreeVerb2.ar(dry[0], dry[1], 1.0, room, damp);
		sig = (dry * (1 - mix)) + (wet * mix);
		// The pedal makes polyphony unbounded -- thirty ringing voices is
		// an ordinary pedalled chord -- and nothing else caps the sum.
		sig = LPF.ar(sig, 500);
		sig = Limiter.ar(sig * amp, 0.95);
		Out.ar(out, sig);
	}).add;

	s.sync;   // do not touch MIDI until the SynthDef has reached the server
	"synth ready".postln;

	// 3 -- mutable state ----------------------------------------------
	~held      = Dictionary.new;   // midi note -> Synth (sounding voices)
	~keysDown  = Set.new;          // keys physically down right now
	~sustained = Set.new;          // released while the pedal was down
	~history   = List.new;         // [time, note, velocity] for recent note-ons
	~loudAcc   = 0.0;              // decaying peak loudness
	~density   = 0.0;              // notes/sec over the window, normalised 0..1
	~energy    = 0.0;              // smoothed master energy, 0..1
	~centroid  = 0.5;              // smoothed pitch centroid, 0..1
	~spread    = 0.0;              // smoothed pitch spread, 0..1
	~tension   = 0.0;              // smoothed harmonic dissonance, 0..1
	~poly      = 0.0;              // smoothed polyphony, 0..1
	~bass      = -1;               // lowest note held, -1 for none
	~trebleAcc = 0.0;              // decaying peak of C6-and-up velocities
	~bandLowAcc  = 0.0;            // ... and one per lower register band
	~bandMidAcc  = 0.0;
	~bandHighAcc = 0.0;
	~pedal     = false;

	// 4 -- soundboard bus ---------------------------------------------
	// Voices write here; the body synth sits at the tail of the group and
	// processes the sum. Voices are added to the head, so they always run
	// before it.
	~fxBus = Bus.audio(s, 2);
	// Every voice lives in here, and nothing else does. That is what
	// makes ~voiceGroup.freeAll a blank slate you can take between songs
	// without killing the soundboard -- s.freeAll would take \kbBody too
	// and leave every later note inaudible.
	//
	// Head of the default group, with \kbBody at the tail, so the voices
	// are still computed before the body reads their bus.
	~voiceGroup = Group.head(s.defaultGroup);
	~body  = Synth.tail(s.defaultGroup, \kbBody,
		[\in, ~fxBus.index, \mix, ~bodyMix, \room, ~bodyRoom]);
	s.sync;

	// 5 -- MIDI input --------------------------------------------------
	MIDIClient.init;
	MIDIIn.connectAll;

	// The three things a keyboard can do, as plain functions. The MIDIdefs
	// are thin wrappers over them, and the demo in section 8 calls the same
	// three -- so a demo run and a real performance are indistinguishable
	// from here on. Anything that only worked for MIDI would be a mapping
	// the demo silently fails to demonstrate.
	~argsFor = { |num, v|
		var pan = (num - 60).linlin(-39, 48, -0.6, 0.6);
		[\freq, num.midicps, \vel, v, \pan, pan,
			\pos, ~pos, \c1Scale, ~c1Scale, \c3Scale, ~c3Scale,
			\detune, ~detune, \out, ~fxBus.index]
	};

	~noteOn = { |num, v|
		// Re-striking a key that is still ringing -- which happens whenever
		// the pedal is down -- damps the old voice first, exactly as the
		// returning hammer damper does.
		~held[num].notNil.if {
			~held[num].set(\gate, 0);
		};
		~sustained.remove(num);
		~keysDown.add(num);

		~held[num] = Synth(\kbPiano, ~argsFor.value(num, v), ~voiceGroup);

		~history.add([Main.elapsedTime, num, v]);
		~loudAcc = max(~loudAcc, v);

		// Top register. Same shape as ~loudAcc -- each strike pushes it up to
		// that note's velocity and it bleeds away -- but only notes at or
		// above ~trebleSplit contribute, so it measures playing UP THERE
		// rather than playing loudly anywhere.
		(num >= ~trebleSplit).if { ~trebleAcc = max(~trebleAcc, v) };

		// The three lower bands, same shape. Together with the treble
		// accumulator these tile the keyboard, so every note feeds
		// exactly one of the four.
		case
			{ num <= ~bandLowMax }  { ~bandLowAcc  = max(~bandLowAcc, v) }
			{ num <= ~bandMidMax }  { ~bandMidAcc  = max(~bandMidAcc, v) }
			{ num <= ~bandHighMax } { ~bandHighAcc = max(~bandHighAcc, v) }
			{ true }                { };   // C6 and up: ~trebleAcc has it

		// one-shot event, useful for flashes / particle bursts on the OpenSpace side
		~os.sendMsg(~prefix ++ "/note", num.asInteger, v.asFloat);
	};

	~noteOff = { |num|
		~keysDown.remove(num);
		if (~pedal) {
			// Damper is off the strings: the note keeps ringing. This is the
			// whole point of the pedal and the file never used to do it --
			// noteOff released the voice regardless, so pedalling was silent.
			~sustained.add(num);
		} {
			~held[num].notNil.if {
				~held[num].set(\gate, 0);
				~held.removeAt(num);
			};
		};
	};

	~setPedal = { |down|
		var wasDown = ~pedal;
		~pedal = down;
		if (wasDown and: { ~pedal.not }) {
			// Pedal up: the dampers come down on everything except the keys
			// still physically held.
			~sustained.do { |n|
				~keysDown.includes(n).not.if {
					~held[n].notNil.if {
						~held[n].set(\gate, 0);
						~held.removeAt(n);
					};
				};
			};
			~sustained.clear;
		};
		~os.sendMsg(~prefix ++ "/pedal", ~pedal.binaryValue);
	};

	// The ONLY path a real key takes. The rolling demo hooks here rather
	// than in ~noteOn, because its own playback goes through ~noteOn too
	// and would otherwise read itself as a player and fade itself out.
	MIDIdef.noteOn(\ospNoteOn, { |vel, num, chan, src|
		~rdTouch.notNil.if { ~rdTouch.value };
		~noteOn.value(num, vel / 127.0);
	});
	MIDIdef.noteOff(\ospNoteOff, { |vel, num, chan, src|
		~noteOff.value(num);
	});
	// sustain pedal (CC 64)
	MIDIdef.cc(\ospPedal, { |val, num, chan, src|
		~setPedal.value(val > 63);
	}, 64);

	"midi listening".postln;

	// 6 -- analysis + OSC transmission --------------------------------
	~task = Task({
		var dt = 1 / ~sendRate;

		loop {
			var now, recent, notes, tCentroid, tSpread, tTension, tPoly, tBass;
			var raw, msgs;

			now = Main.elapsedTime;

			// prune history outside the analysis window
			while { (~history.size > 0) and: { (now - ~history[0][0]) > ~histWindow } } {
				~history.removeAt(0);
			};

			// ---- raw features ------------------------------------------
			recent   = ~history;
			// Group simultaneous chord notes (within ~chordWindow) so density
			// measures sequential note rate rather than chord thickness.
			~density = ({
				var count = 0.0, lastOnset = -100.0;
				recent.do { |e|
					if ((e[0] - lastOnset) > ~chordWindow) {
						count = count + 1.0;
						lastOnset = e[0];
					} {
						count = count + ~chordWeight;
					};
				};
				count / ~histWindow / ~densityMax
			}.value).clip(0, 1);

			~loudAcc   = ~loudAcc * ~loudDecay;
			~trebleAcc   = ~trebleAcc   * ~trebleDecay;
			~bandLowAcc  = ~bandLowAcc  * ~trebleDecay;
			~bandMidAcc  = ~bandMidAcc  * ~trebleDecay;
			~bandHighAcc = ~bandHighAcc * ~trebleDecay;

			notes = recent.collect { |e| e[1] };
			tCentroid = if (notes.size > 0) {
				notes.mean.linlin(21, 108, 0, 1).clip(0, 1)
			} { ~centroid };

			tSpread = if (notes.size > 1) {
				((notes.maxItem - notes.minItem) / 60).clip(0, 1)
			} { 0.0 };

			// Read off the keys actually DOWN, not the voices still
			// sounding: with the pedal held, ~held keeps ringing voices
			// and reading those would pile up dissonance from notes the
			// player has already released -- and freeze the bass note,
			// locking the camera's destination.
			tTension = ~chordTension.value(~keysDown.asArray);
			tPoly    = (~keysDown.size / ~polyMax).clip(0, 1);

			// Lowest note currently held: the bass the player is sounding,
			// which the bridge turns into a travel destination. Sent raw and
			// unsmoothed — it is a discrete choice, not a continuous value.
			// -1 means nothing is held.
			tBass = if (~keysDown.size > 0) { ~keysDown.asArray.minItem } { -1 };

			// ---- master energy -----------------------------------------
			// density carries the sense of motion, loudness carries the sense of scale
			raw = (0.55 * ~density) + (0.45 * ~loudAcc);

			// ---- smoothing ---------------------------------------------
			~energy   = ~lag.value(~energy,   raw,       ~energySmooth);
			~centroid = ~lag.value(~centroid, tCentroid, 0.06);
			~spread   = ~lag.value(~spread,   tSpread,   0.08);
			~tension  = ~lag.value(~tension,  tTension,  0.05);
			~poly     = ~lag.value(~poly,     tPoly,     0.15);
			~bass     = tBass;   // not smoothed, deliberately

			// ---- transmit ----------------------------------------------
			// Only the raw derived values go out. Layer opacities used to be
			// computed here and sent one address per layer, but the bridge
			// derives them itself now — seventy layers driven off six
			// different values, and keeping that table in two files in two
			// languages was a standing invitation to drift.
			msgs = [
				// primary drivers
				[~prefix ++ "/energy",     ~energy.asFloat],
				[~prefix ++ "/zoomSpeed",  (~energy ** 1.6).asFloat],   // eased, feels better
				[~prefix ++ "/density",    ~density.asFloat],             // -> time speed
				[~prefix ++ "/loudness",   ~loudAcc.asFloat],

				// character
				[~prefix ++ "/centroid",   ~centroid.asFloat],  // -> elevation
				[~prefix ++ "/spread",     ~spread.asFloat],    // -> the distance grids
				[~prefix ++ "/tension",    ~tension.asFloat],   // -> roll / turbulence
				[~prefix ++ "/polyphony",  ~poly.asFloat],

				// top register: how hard you are playing at C6 and above
				[~prefix ++ "/treble",     ~trebleAcc.asFloat],

				// register bands: which group of abstract points reacts
				[~prefix ++ "/bandLow",    ~bandLowAcc.asFloat],
				[~prefix ++ "/bandMid",    ~bandMidAcc.asFloat],
				[~prefix ++ "/bandHigh",   ~bandHighAcc.asFloat],

				// destination: lowest held note, -1 for none
				[~prefix ++ "/bass",       ~bass.asInteger]
			];

			~os.sendBundle(nil, *msgs);

			dt.wait;
		};
	}).play(AppClock);

	// 7 -- live readout ------------------------------------------------
	~monitor = Task({
		var tick = 0;
		loop {
			// reprint the header every 20 lines so it stays readable
			if (tick % 20 == 0) {
				"".postln;
				"energy  dens  loud  treb  keys   vc  srv  cent  sprd  tens  poly | bass"
					.postln;
				"-----------------------------------------------------------------+------"
					.postln;
			};
			tick = tick + 1;

			// `vc` is what sclang thinks it is holding; `srv` is what the
			// server actually has running. They should track each other.
			// If srv climbs while vc does not, voices are outliving their
			// bookkeeping -- that is the leak that sounds like crackle,
			// and watching this column is how you see it.
			"%  %  %  %  %  %  %  %  %  %  % | %".format(
				~fmt.value(~energy),
				~fmt.value(~density),
				~fmt.value(~loudAcc),
				~fmt.value(~trebleAcc),
				~keysDown.size.asString.padLeft(4),
				~held.size.asString.padLeft(4),
				((s.numSynths ? 0) - 1).max(0).asString.padLeft(4),
				~fmt.value(~centroid),
				~fmt.value(~spread),
				~fmt.value(~tension),
				~fmt.value(~poly),
				~noteName.value(~bass)
			).postln;

			0.5.wait;
		};
	}).play(AppClock);

	// 8 -- demo, for when there is no keyboard ------------------------
	// A written-out piece that plays itself by calling ~noteOn / ~noteOff /
	// ~setPedal, which is the path MIDI takes -- so the analysis, the OSC, the
	// bridge and OpenSpace all behave exactly as they would under real hands.
	// It never touches MIDI, so a keyboard can stay plugged in and you can
	// play along over the top of it.
	//
	// The piece is arranged to demonstrate the mappings in order: sparse quiet
	// playing (few layers, slow travel), a rising bass line that walks the
	// camera outward body by body, thickening chords and rising velocity
	// (layers accruing), the sustain pedal, the C6-and-above size explosion,
	// and finally silence -- which is the only way to see the camera actually
	// come to rest and drift home. Then it repeats.
	//
	// Score notation, one array per event:
	//     [wait, [midi notes], velocity, hold]
	//     [wait, \pedOn]  /  [wait, \pedOff]
	//     [wait, nil]                                        -- a rest
	// all times in beats. `wait` is how long until the NEXT event; `hold` is
	// how long these notes stay down. The two being independent is what lets a
	// bass note ring under a melody, and that matters more than it looks:
	// `bass` is the lowest key DOWN, so the travel destination only holds while
	// the note is physically held. The left hand has to sustain it.
	//
	// The bass line sits in the first octave (E1..B1) rather than where a
	// left hand would naturally put it. That is not taste: the bridge's
	// BASS_SPLIT is 37, so only notes at or below C#2 steer and anything
	// higher counts as playing rather than navigating. The pitch class is
	// what chooses the body, so the octave is free -- but it has to be at
	// or below the split, or the piece navigates nowhere and falls back to
	// the fixed itinerary without saying so.
	~demoArp = { |notes, dur, vel1, vel2|
		// A run of single notes, velocity ramped from vel1 to vel2 across it.
		var v2 = vel2 ? vel1;
		var last = max(notes.size - 1, 1);
		notes.collect { |note, i|
			[dur, [note], (vel1 + ((v2 - vel1) * (i / last))).clip(0.05, 1.0), dur * 3]
		};
	};

	~demoScore = [
		// Bass E1. One voice at a time, quiet: close to the floor of what the
		// system responds to, so there is somewhere to build from.
		["Earth    E in the bass, one voice, quiet", [
			[0,   [28], 0.30, 16],
			[4,   [64], 0.32, 3],
			[2,   [71], 0.30, 2],
			[2,   [69], 0.28, 3],
			[3,   [67], 0.30, 3],
			[3,   [64], 0.26, 4],
			[2,   nil],
		]],

		// Eb1 -- down a semitone in the bass, which is a step further out in
		// the mapping. Two voices, eighth notes: density starts to register.
		["Moon     Eb, two voices moving", [
			[0,   [27], 0.38, 16],
			[1.5, [63, 70], 0.40, 1.5],
			[1.5, [67], 0.36, 1],
			[1,   [70], 0.38, 1],
			[1,   [72], 0.42, 1.5],
			[1,   [70], 0.36, 1],
			[2,   [67], 0.34, 2],
			[2,   [63, 67, 70], 0.44, 3],
			[3,   [65], 0.36, 2],
			[2,   [63], 0.34, 3],
			[1,   nil],
		]],

		// F1: the example from the original request. Triads now, mezzo-forte.
		["Mars     F, triads, mezzo-forte", [
			[0,   [29], 0.55, 16],
			[1,   [65, 69, 72], 0.58, 1],
			[1,   [65, 69, 72], 0.50, 1],
			[1,   [67, 70, 74], 0.60, 1],
			[1,   [65, 69, 72], 0.52, 1],
			[1,   [72], 0.62, 0.5],
			[0.5, [74], 0.58, 0.5],
			[0.5, [76], 0.60, 1],
			[1,   [69, 72, 77], 0.64, 2],
			[2,   [76], 0.56, 1],
			[1,   [74], 0.54, 1],
			[1,   [72, 77], 0.62, 2],
			[2,   [70, 74], 0.58, 2],
			[2,   [69], 0.52, 2],
			[1,   nil],
		]],

		// F#1 under sixteenth-note arpeggios: the fastest continuous playing in
		// the piece, so this is where `density` and the layer pace peak.
		["Jupiter  F#, sixteenth arpeggios", [
			[0, [30], 0.66, 16],
		] ++ ~demoArp.value(
			([66, 69, 73, 76, 81, 76, 73, 69] ++ [66, 69, 73, 78, 83, 78, 73, 69])
				.dup(4).flat,
			0.25, 0.52, 0.72)],

		// G1, pedal down, wide chords. Voice count climbs well past the key
		// count here, which is the pedal doing its job.
		["Saturn   G, pedal down, wide chords", [
			[0,   \pedOn],
			[0,   [31], 0.75, 14],
			[2,   [67, 74, 79], 0.78, 6],
			[2,   [71, 76, 83], 0.72, 6],
			[2,   [69, 74, 81], 0.80, 6],
			[2,   [67, 79, 86], 0.85, 8],
			[4,   [74, 81, 88], 0.82, 6],
			[4,   \pedOff],
		]],

		// A1. The first real excursion above C6 -- single notes up there, so the
		// size boost comes and goes with them rather than staying on.
		["Neptune  A, first notes above C6", [
			[0,   [33], 0.70, 16],
			[1,   [69, 76, 81], 0.68, 4],
			[2,   [88], 0.55, 1],
			[0.5, [91], 0.58, 1],
			[0.5, [93], 0.62, 1.5],
			[1,   [88], 0.52, 1],
			[1,   [76, 81], 0.60, 3],
			[2,   [93], 0.66, 1],
			[0.5, [96], 0.70, 1],
			[0.5, [100], 0.74, 2],
			[1,   [93], 0.60, 1],
			[1,   [81, 88], 0.64, 4],
			[3,   [76], 0.55, 3],
			[2,   nil],
		]],

		// Bb1 and a cascade played entirely at C6 and above, loud, on the pedal.
		// This is the size explosion: fifteen unbroken beats up there holds the
		// treble accumulator near the top, which is ~19x the baseline point size.
		["Pluto    Bb, cascade entirely above C6 -- the size explosion", [
			[0,   \pedOn],
			[0,   [34], 0.85, 16],
			[0.5, [70, 77, 82], 0.85, 8],
		] ++ ~demoArp.value(
			[86, 89, 93, 96, 101, 96, 93, 89].dup(15).flat, 0.125, 0.78, 0.92)
		  ++ [[0.5, \pedOff]]],

		// B1 is not a body: it focuses the Sun and keeps receding. Held under a
		// long diminuendo, so the camera carries on outward while the playing
		// thins out and the layers stay latched.
		["Outward  B, held, long diminuendo", [
			[0, \pedOn],
			[0, [35], 0.90, 24],
			[0, [59, 66, 71, 78], 0.88, 22],
			[2, [83, 90], 0.82, 20],
		] ++ ~demoArp.value(
			[86, 93, 98, 90, 96, 101].dup(12).flat, 0.25, 0.75, 0.10)
		  ++ [[0, \pedOff], [4, nil]]],

		// Nothing at all. The layers fade, the camera stops and drifts home --
		// none of which is visible while anything is still being played.
		["silence  everything fades, the camera comes to rest", [
			[16, nil],
		]],
	];

	~demoClock = TempoClock(~demoTempo / 60);
	~demo = Task({
		loop {
			~demoScore.do { |sec|
				("demo | " ++ sec[0]).postln;
				sec[1].do { |ev|
					var what = ev[1];
					case
						{ what == \pedOn }  { ~setPedal.value(true) }
						{ what == \pedOff } { ~setPedal.value(false) }
						{ what.isArray }    {
							var vel = ev[2], hold = ev[3];
							what.do { |n|
								~noteOn.value(n, vel);
								// Release on the clock instead of waiting here,
								// so `hold` and `wait` really are independent
								// and a held bass note does not stall the piece.
								~demoClock.sched(hold, { ~noteOff.value(n); nil });
							};
						};
					ev[0].wait;
				};
			};
		};
	}, ~demoClock);

	// Stopping mid-phrase would otherwise leave notes down forever: the task is
	// not what holds them, the pending clock events are.
	~demoStop = {
		~demo.notNil.if { ~demo.stop };
		~demoClock.notNil.if { ~demoClock.clear };
		~setPedal.notNil.if { ~setPedal.value(false) };
		~keysDown.asArray.do { |n| ~noteOff.value(n) };
		~held.keys.asArray.do { |n| ~noteOff.value(n) };
		"demo stopped".postln;
	};

	// 8b -- playing a MIDI file ---------------------------------------
	// A .score file is a flat, absolute-time event list produced by
	// mid_to_score.py: one "seconds,kind,note,velocity" per line, kind being
	// on / off / ped. Parsed here rather than compiled as a literal array
	// because a real piece is thousands of events and SuperCollider's compiler
	// has limits on literal size that a Chopin ballade would find.
	~midiEvents = nil;
	~midiPath = nil;

	// How hard this score should be played, relative to how it was
	// exported. Set by ~midiLoad, so both players honour it.
	~songTrim = 1.0;
	~velTrimFor = { |path|
		var m = 1.0;
		(~velTrim ? []).do { |pair|
			((path ? "").asString.contains(pair[0])).if { m = pair[1] };
		};
		m;
	};

	// Which body, if any, this score pins the camera to. Matched on the
	// filename so a score renamed away from the piece stops locking.
	~focusLockNode = { |path|
		var hit = nil;
		~focusLock.if {
			~focusLockFor.do { |pair|
				((path ? "").asString.contains(pair[0])).if { hit = pair[1] };
			};
		};
		hit;
	};

	// The bridge takes a string as the node to lock, and 0 as "release".
	~sendFocusLock = { |node|
		node.isNil.if {
			~os.sendMsg(~prefix ++ "/focusLock", 0);
		} {
			~os.sendMsg(~prefix ++ "/focusLock", node.asString);
			("focus locked to " ++ node ++ " for this score").postln;
		};
	};

	~midiLoad = { |path|
		var text, evs, notes, dur, resolved;
		resolved = path.standardizePath;
		if (File.exists(resolved).not and: { ~scoreDir.notNil }) {
			[~scoreDir +/+ path.basename, ~scoreDir.dirname +/+ path.basename].do { |cand|
				var alt = cand.standardizePath;
				if (File.exists(resolved).not and: { File.exists(alt) }) {
					resolved = alt;
				};
			};
		};
		if (File.exists(resolved).not) {
			("no such score: " ++ path
				++ "\n  run: python Songs/mid_to_score.py yourfile.mid").postln;
			nil;
		} {
			path = resolved;
			text = File.readAllString(path);
			evs = List.new;
			text.split($\n).do { |ln|
				var p;
				ln = ln.stripWhiteSpace;
				// # is the header and the comments the converter writes
				if ((ln.size > 4) and: { ln[0] != $# }) {
					p = ln.split($,);
					if (p.size >= 4) {
						evs.add([p[0].asFloat, p[1].asSymbol,
							p[2].asInteger, p[3].asFloat]);
					};
				};
			};
			~midiEvents = evs.asArray;
			~midiPath = path;
			~songTrim = ~velTrimFor.value(path);
			notes = ~midiEvents.select { |e| e[1] == \on };
			dur = ~midiEvents.collect { |e| e[0] }.maxItem ? 0;
			("loaded " ++ path.basename ++ ": " ++ notes.size ++ " notes over "
				++ dur.round(0.1) ++ "s"
				++ (~songTrim != 1.0).if({ ", velocity x" ++ ~songTrim }, { "" })
			).postln;
			(notes.size > 0).if {
				var ns = notes.collect { |e| e[2] };
				("  range " ++ ~noteName.value(ns.minItem).stripWhiteSpace ++ " to "
					++ ~noteName.value(ns.maxItem).stripWhiteSpace
					++ ", lowest note "
					++ (ns.minItem <= 37).if({ "steers" }, { "TOO HIGH to steer" })
				).postln;
			};
			~midiEvents;
		};
	};

	// Seconds, not beats: the score is already in absolute time, so this clock
	// runs at one beat per second and ~midiRate scales it.
	~midiClock = TempoClock(1);
	~midiFile = Task({
		var again = true;
		while { again } {
			var t = 0.0;
			(~midiEvents.isNil).if {
				"no score loaded -- ~midiLoad.value(\"file.score\") first".postln;
				again = false;
			} {
				~midiClock.tempo = ~midiRate;
				("playing " ++ (~midiPath ? "?").basename).postln;
				// Sent from inside the Task, so a reset/replay re-engages it
				// and a loop re-asserts it on every pass.
				~sendFocusLock.value(~focusLockNode.value(~midiPath));
				~midiEvents.do { |e|
					// Re-read the rate every event so it can be changed while
					// the piece is playing. A TempoClock reschedules waits
					// that are already pending, so the change lands inside
					// the current note rather than at the next one.
					(~midiClock.tempo != ~midiRate).if {
						~midiClock.tempo = ~midiRate;
					};
					(e[0] - t).max(0).wait;
					t = e[0];
					case
						{ e[1] == \on }  {
							~noteOn.value(e[2],
								(e[3] * ~songTrim).clip(0.0, 1.0));
						}
						{ e[1] == \off } { ~noteOff.value(e[2]) }
						{ e[1] == \ped } { ~setPedal.value(e[2] > 0) };
				};
				// release anything the file left sounding, then let the scene
				// settle the way the demo's closing silence does
				~setPedal.value(false);
				~keysDown.asArray.do { |n| ~noteOff.value(n) };
				"file finished".postln;
				again = ~midiLoop;
				// Give the camera back unless we are going round again.
				again.not.if { ~sendFocusLock.value(nil) };
				// a gap before repeating, so the layers latch and the camera
				// settles the way the demo's closing silence lets it
				again.if { 4.0.wait };
			};
		};
	}, ~midiClock);

	// Same reason ~demoStop exists: the task is not what holds the notes down.
	~midiStop = {
		~midiFile.notNil.if { ~midiFile.stop };
		~midiClock.notNil.if { ~midiClock.clear };
		~setPedal.notNil.if { ~setPedal.value(false) };
		~keysDown.asArray.do { |n| ~noteOff.value(n) };
		~held.keys.asArray.do { |n| ~noteOff.value(n) };
		// Always released, whether or not this score set one: a lock that
		// outlived its song would pin the camera for the rest of the session.
		~sendFocusLock.notNil.if { ~sendFocusLock.value(nil) };
		"midi file stopped".postln;
	};

	~midiPlay = {
		(~midiEvents.notNil).if {
			~midiStop.value;
			~midiFile.reset.play(~midiClock);
		} {
			"nothing loaded -- ~midiLoad.value(\"yourfile.score\")".postln;
		};
	};

	// 8c -- the rolling demo -----------------------------------------
	// See the header note by ~rdSongs. The three traps this avoids are
	// written up there; what follows is the machinery.
	~rdGain = 1.0;          // velocity multiplier on PLAYBACK notes only
	~rdHeld = Set.new;      // what the playback is holding, not the player
	~rdOn = false;
	~rdTakenOver = false;
	~rdSkipWanted = false;
	~rdLastKey = 0;
	~rdIndex = 0;
	~rdClock = TempoClock(1);   // its own, so ~midiStop cannot clear it
	~rdTask = nil;
	~rdWatch = nil;
	~rdFader = nil;

	~rdNoteOn = { |num, vel|
		// Below the floor the playback has faded out: stop striking rather
		// than strike inaudibly, so it stops driving the visuals too.
		// The floor is on ~rdGain alone, not on the product: a heavily
		// trimmed song must still play, it is the FADE that decides when to
		// stop striking.
		(~rdGain > 0.002).if {
			~rdHeld.add(num);
			~noteOn.value(num, (vel * ~rdGain * ~songTrim).clip(0.0, 1.0));
		};
	};
	~rdNoteOff = { |num|
		~noteOff.value(num);
		// With the pedal DOWN, ~noteOff does not release the note -- it moves
		// it to ~sustained, where it is still sounding and still ours.
		// Forgetting it here is what left voices stranded at a takeover: they
		// were no longer in ~rdHeld for ~rdSilence to find.
		~sustained.includes(num).not.if { ~rdHeld.remove(num) };
	};
	// Releases ONLY what the playback holds. Using ~keysDown here would
	// cut the player's own notes -- the one thing a takeover must not do.
	~rdSilence = {
		// Lift the pedal FIRST, and this line is the whole bug fix. With the
		// pedal down ~noteOff sustains instead of releasing, and nothing else
		// would ever lift a pedal the SCORE pressed -- so the voices ran on
		// silently for the rest of the session (\kbPiano's envelope is an ASR
		// that holds until its gate is pulled), and every takeover stranded
		// more of them until the server crackled. It also means whoever just
		// sat down does not inherit a stuck sustain pedal.
		//
		// ~setPedal skips any note still physically held, so this cannot cut
		// the player's own fingers.
		~pedal.if { ~setPedal.value(false) };
		~rdHeld.asArray.do { |n| ~noteOff.value(n) };
		~rdHeld.clear;
	};

	~rdFadeTo = { |target, secs, action|
		~rdFader.notNil.if { ~rdFader.stop };
		~rdFader = Routine({
			var from = ~rdGain, steps = (secs * 25).max(1).asInteger;
			steps.do { |k|
				~rdGain = from + ((target - from) * ((k + 1) / steps));
				(secs / steps).wait;
			};
			~rdGain = target;
			action.notNil.if { action.value };
		}).play(AppClock);
	};

	// Called from the MIDIdef on every real key press.
	~rdTouch = {
		// Recorded either way: if ~rdYield is switched back on mid-session
		// the idle timer is already current rather than stale.
		~rdLastKey = Main.elapsedTime;
		(~rdOn and: { ~rdYield } and: { ~rdTakenOver.not }).if {
			~rdTakenOver = true;
			("rolling demo: you have it -- fading out over "
				++ ~rdFadeOut ++ "s").postln;
			~rdFadeTo.value(0.0, ~rdFadeOut, {
				~rdTask.notNil.if { ~rdTask.pause };
				~rdSilence.value;
				// A locked focus belongs to the SCORE, not to the player --
				// hand steering back with the keyboard.
				~sendFocusLock.notNil.if { ~sendFocusLock.value(nil) };
			});
		};
	};

	// Next song. Takes effect at the next event rather than instantly --
	// at 30 notes a second that is imperceptible, and it means the skip is
	// handled by the thread that owns the playback rather than by whoever
	// called it.
	//
	// While the demo is TAKEN OVER its Task is paused, so the flag simply
	// waits: the skip lands when the playback resumes. That is deliberate
	// -- skipping should not haul the demo back over somebody who is in
	// the middle of playing.
	~rdSkip = {
		~rdOn.if {
			~rdSkipWanted = true;
			~rdTakenOver.if {
				"rolling demo: skip queued -- lands when playback resumes"
					.postln;
			} {
				"rolling demo: skipping to the next song".postln;
			};
		} {
			"rolling demo: not running -- ~rdStart.value first".postln;
		};
	};

	// A blank slate. Frees every voice node outright rather than gating
	// them and trusting each one to go, and clears the bookkeeping that
	// tracks them -- so a song can never inherit anything from the one
	// before it, whatever went wrong during it.
	//
	// Skipped if the player has a key down: at a song boundary the
	// playback is the only thing sounding, but this must never be the
	// thing that cuts somebody off mid-note.
	~rdReset = {
		~keysDown.isEmpty.if {
			~voiceGroup.notNil.if { ~voiceGroup.freeAll };
			~held.clear;
			~sustained.clear;
			~rdHeld.clear;
			~pedal.if {
				~pedal = false;
				~os.sendMsg(~prefix ++ "/pedal", 0);
			};
		} {
			("rolling demo: " ++ ~keysDown.size ++ " key(s) down -- "
				++ "skipping the reset rather than cutting them off").postln;
		};
	};

	~rdStop = {
		~rdOn = false;
		~rdTakenOver = false;
		~rdSkipWanted = false;
		~rdFader.notNil.if { ~rdFader.stop; ~rdFader = nil };
		~rdWatch.notNil.if { ~rdWatch.stop; ~rdWatch = nil };
		~rdTask.notNil.if { ~rdTask.stop; ~rdTask = nil };
		~rdSilence.value;
		~rdReset.value;
		~sendFocusLock.notNil.if { ~sendFocusLock.value(nil) };
		~rdGain = 1.0;
	};

	~rdStart = {
		((~rdSongs ? []).size == 0).if {
			"rolling demo: ~rdSongs is empty".postln;
		} {
			// One player at a time.
			~demoStop.notNil.if { ~demoStop.value };
			~midiStop.notNil.if { ~midiStop.value };
			~rdStop.value;
			~rdOn = true;
			~rdTakenOver = false;
			~rdGain = 1.0;
			~rdLastKey = Main.elapsedTime - ~rdIdle;

			~rdTask = Task({
				var misses = 0;
				// `while { ~rdOn }` rather than `loop` + stopping itself: a
				// Task that calls .stop on itself from inside its own body is
				// how the single-file player went wrong once already.
				while { ~rdOn } {
					var path, evs, t = 0.0, i = 0, skipped = false;
					path = ~scoreDir +/+ ~rdSongs.wrapAt(~rdIndex);
					~rdIndex = ~rdIndex + 1;
					evs = ~midiLoad.value(path);
					evs.isNil.if {
						// A missing file must not spin: if every entry is
						// missing this would be a hot loop posting for ever.
						misses = misses + 1;
						(misses >= ~rdSongs.size).if {
							("rolling demo: none of the " ++ ~rdSongs.size
								++ " scores could be loaded -- stopping").postln;
							~rdOn = false;
						};
						1.0.wait;
					} {
						misses = 0;
						~sendFocusLock.notNil.if {
							~sendFocusLock.value(~focusLockNode.value(path));
						};
						// Indexed rather than `evs.do`: `do` cannot be broken out
						// of, and guarding its body would still run every
						// remaining .wait -- so a skip would take the rest of the
						// song to happen. ~rdOn is in the condition too, so
						// stopping leaves mid-song instead of being killed.
						while { (i < evs.size) and: { ~rdSkipWanted.not }
							and: { ~rdOn } } {
							var e = evs[i];
							(~rdClock.tempo != ~midiRate).if {
								~rdClock.tempo = ~midiRate;
							};
							(e[0] - t).max(0).wait;
							t = e[0];
							case
								{ e[1] == \on }  { ~rdNoteOn.value(e[2], e[3]) }
								{ e[1] == \off } { ~rdNoteOff.value(e[2]) }
								{ e[1] == \ped } { ~setPedal.value(e[2] > 0) };
							i = i + 1;
						};
						skipped = ~rdSkipWanted;
						~rdSkipWanted = false;
						~setPedal.value(false);
						~rdSilence.value;
						~sendFocusLock.notNil.if { ~sendFocusLock.value(nil) };
						// Whatever the song left behind, it stops here.
						~rdReset.value;
						skipped.if {
							// A breath, not the full gap: the gap exists to let the
							// layers settle after a piece ENDS, and whoever asked
							// for the next song is waiting for it.
							("rolling demo: skipped " ++ path.basename).postln;
							0.5.wait;
						} {
							("rolling demo: finished " ++ path.basename).postln;
							~rdGap.wait;
						};
					};
				};
			}, ~rdClock);
			~rdTask.play(~rdClock);

			~rdWatch = Routine({
				loop {
					0.25.wait;
					(~rdOn and: { ~rdTakenOver }).if {
						// Keys still down means the player is still there even
						// if nothing new has been struck -- a held chord must
						// not be played over.
						((((Main.elapsedTime - ~rdLastKey) >= ~rdIdle))
							and: { ~keysDown.size == 0 }).if {
							~rdTakenOver = false;
							("rolling demo: quiet for " ++ ~rdIdle
								++ "s -- resuming").postln;
							~rdTask.notNil.if { ~rdTask.resume };
							~rdFadeTo.value(1.0, ~rdFadeIn, nil);
						};
					};
				};
			}).play(AppClock);

			("rolling demo: " ++ ~rdSongs.size ++ " songs, yielding for "
				++ ~rdIdle ++ "s after a key press").postln;
		};
	};

	~running = true;
	"".postln;
	"streaming OSC to % : % — play.".format(~osHost, ~osPort).postln;
	if (~rdAuto) { ~rdStart.value };
	if (~demoAuto and: { ~rdAuto.not }) { ~demo.play } {
		~autoStartScore.notNil.if {
			("auto-starting " ++ ~autoStartScore).postln;
			~midiLoad.value(~scoreDir +/+ ~autoStartScore);
			~midiPlay.value;
		} {
			"no keyboard? evaluate  ~demo.play  on its own (~demoStop.value stops it)".postln;
		};
	};

}).play(AppClock);
)


// ---------------------------------------------------------------------
//  Utilities — run these on their own, as needed
// ---------------------------------------------------------------------
thisProcess.nowExecutingPath;

// quiet the readout without stopping the music
~monitor.stop;

// bring it back
~monitor.reset.play(AppClock);

// --- the rolling demo -------------------------------------------------
// A playlist that plays itself and steps aside when you play. Start it:
~rdStart.value;

// ...and stop it
~rdStop.value;

// Play ALONG with the playlist instead of taking it over: the songs keep
// going while you play on top. Off by default -- the installation wants
// to hand the instrument to whoever sits down.
~rdYield = false;
~rdYield = true;         // back to stepping aside

// Turning it off DURING a takeover does not haul the playback back at
// once -- the watchdog resumes it after ~rdIdle, as usual.

// next song, now. Takes effect within one event; the inter-song gap is
// skipped too. If somebody is mid-takeover the skip is queued and lands
// when the playback resumes, rather than interrupting them.
~rdSkip.value;

// Touch a key while it is rolling and it fades out over ~rdFadeOut and
// releases its own notes -- yours are untouched. Stop playing and it
// comes back ~rdIdle seconds later, resuming where it paused rather
// than restarting the song.
//
// The playlist. Scores, not .mid; they live in ~scoreDir. Changing this
// takes effect at the next song boundary.
~rdSongs = ["Space-Oddity.score", "LifeonMars.score"];  // a shorter set

// Adding one: convert it, read the steering line the converter prints,
// and only then add it. A piece whose left hand never goes below C#2
// will play but never steer -- the camera just recedes for its whole
// length. --bass-octaves 1 drops the left hand an octave to fix that,
// but check the reported range afterwards: below A0 (MIDI 21) is off
// the bottom of a real piano and sounds like it.
//   python mid_to_score.py "yours.mid" --bass-octaves 1
// One track too loud? Trim its velocity. Matched on a filename fragment,
// applied at strike time by both players, and live -- it takes effect at
// the next load. Check it against the others rather than guessing: the
// scores here average 0.22-0.40 velocity, and the one that needed this
// was exported at 0.78.
~velTrim = [["Rocket-Man", 0.5], ["A Sky Full", 0.85]];
~velTrim = [["Rocket-Man", 0.5]];       // back to just the one

~rdIdle = 20.0;      // wait longer before butting back in
~rdFadeOut = 0.5;    // get out of the way faster
~rdGap = 10.0;       // longer silence between songs
~rdAuto = true;      // ...and in the config block: roll on evaluation

// --- play a MIDI file -------------------------------------------------
// FlyMeToTheMoon.mid ships with the project, already converted. Evaluate
// this and it plays itself on the piano synth:
(
~midiLoad.value(~scoreDir +/+ "FlyMeToTheMoon.score");
~midiPlay.value;
)

// 1198 notes over 3m 08s.
//
// This score LOCKS THE CAMERA TO THE MOON, because ~focusLockFor says so and
// ~focusLock is true. The camera swings onto the Moon and FLIES IN to about
// three lunar radii -- 20s by default, --lock-approach on the bridge -- then
// orbits it slowly for the rest of the piece. Nothing can steer away from it:
// not the itinerary, not the bass notes. The scene keeps reacting; the camera
// only orbits.
//
//   ~focusLock = false;     // play it with the usual steering instead
//
// With the lock off it steers itself: its bass reaches C1, the lowest
// sounding note is under the split for about a quarter of the piece, and it
// visits the Sun, Neptune, outward, Pluto, Mercury and Saturn.
//
// Do NOT convert it with --bass-octaves -- that would drop the C1 to MIDI 12,
// below A0 and off the bottom of the keyboard.
//
// Two things it will not show you: it has no sustain-pedal events, and only
// one note at C6 or above, so the top register's groups barely move. The
// built-in demo is the piece to play for those.

~midiStop.value;          // stop, releasing whatever was sounding
~midiLoop = true;         // repeat it
~midiRate = 1.0;         // slower, immediately -- works mid-piece

// Your own file: run this in a terminal, in the project folder --
//   python mid_to_score.py yourfile.mid
// read the report it prints, then load the .score the same way.
(
~midiLoad.value(~scoreDir +/+ "yourfile.score");
~midiPlay.value;
)

// --- the demo piece, for when there is no keyboard --------------------
// Two minutes of written-out music through the same path MIDI takes: it walks
// the camera out through the solar system and exercises every mapping, then
// repeats. Play along over it if you like.
~demo.play;

// stop it, releasing whatever it was holding
~demoStop.value;

// from the top
(
~demoStop.value;
~demo.reset.play;
)

// audition the piano voice without a keyboard
(
Routine({
	[60, 64, 67, 72].do { |n| ~noteOn.value(n, 0.7); 0.35.wait };
	1.0.wait;
	[60, 64, 67, 72].do { |n| ~noteOff.value(n) };
}).play(AppClock);
)

// panic — kill all sound, reset the analysis, keep running
(
~demoClock.notNil.if { ~demoClock.clear };
// The voices have their own group, so this is a clean sweep that cannot
// touch \kbBody -- which is what made s.freeAll unusable here.
~voiceGroup.notNil.if { ~voiceGroup.freeAll };
~held.clear;
~keysDown.clear;
~sustained.clear;
~history.clear;
~loudAcc = 0.0;
~trebleAcc = 0.0;
~bandLowAcc = 0.0;
~bandMidAcc = 0.0;
~bandHighAcc = 0.0;
"panic".postln;
)

// full stop — silence, both loops off, MIDI released
(
~stopAll.value;
"stopped".postln;
)

// --- voice timbre, while playing -------------------------------------
// Change these and evaluate this block. Notes struck afterwards pick them up;
// anything already ringing keeps the settings it was born with. I could not
// ear-tune the defaults, so expect to move them.
(
~pos     = 0.13;   // hammer strike point, 0.06 bright and thin .. 0.25 mellow
~c1Scale = 1.0;    // decay: 0.7 rings noticeably longer, 1.5 much shorter
~c3Scale = 1.0;    // brightness: 0.6 brighter and more metallic, 1.6 duller
~detune  = 1.0;    // unison beating: 0 dead in tune, 3 honky-tonk
"pos % c1 % c3 % detune %".format(~pos, ~c1Scale, ~c3Scale, ~detune).postln;
)

// the room, live
~body.set(\mix, 0.20);    // 0 dead dry, 0.20 a moderate room
~body.set(\room, 0.50);   // size. compact room
~body.set(\damp, 0.5);    // how quickly the room absorbs the top end.
                          //   LOWER is brighter and seems longer, so it
                          //   is the third way to get more reverb.
