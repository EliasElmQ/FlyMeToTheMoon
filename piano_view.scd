// =====================================================================
//  piano_view.scd -- an 88-key keyboard, lit by what you play
//
//  Standalone. Nothing in openspace_piano.scd depends on this file, and
//  this file does not need OpenSpace, a server, or a network connection.
//  Evaluate the one block below (Ctrl+Enter inside it) and a window opens.
//
//  Two things are drawn:
//
//    * the keyboard  -- all 88 keys, A0 to C8, in their real proportions.
//      A key you are holding is filled; how far the fill is tinted is the
//      velocity. A key held by the sustain pedal rather than your finger is
//      a different colour, because those are different states and the
//      instrument treats them differently.
//    * a piano roll  -- the last few seconds, scrolling upward away from
//      the keys. Each bar is aligned with the key that made it, so a chord
//      is a vertical stack and a run is a diagonal.
//
//  HOW IT GETS THE NOTES, which is the one thing worth reading:
//
//  If openspace_piano.scd is already running, this WRAPS its ~noteOn /
//  ~noteOff / ~setPedal functions rather than opening a second MIDI
//  connection. MIDIIn.connectAll a second time duplicates the connections
//  on some platforms, and then every MIDIdef fires twice -- every note
//  would sound twice and count twice. Wrapping the existing seam cannot do
//  that, and it means the viewer also shows the demo, an imported .mid, and
//  anything else that goes through those functions.
//
//  If the main patch is NOT running, it sets up its own MIDI instead.
//
//  Either way ~pvDetach.value puts things back.
//
//  ONE ORDERING TRAP: re-evaluating openspace_piano.scd replaces ~noteOn and
//  ~noteOff outright, which throws away this file's wrapper -- the window
//  stays open and simply stops lighting up. Re-evaluate this file after that
//  one, not before, and if it ever goes quiet that is the reason.
// =====================================================================

(
// --- config ----------------------------------------------------------
~pvFps       = 60;      // redraw rate. The keyboard is 88 rectangles, so
                        //   this is cheap; drop it if the GUI thread is busy.
~pvRollSecs  = 6.0;     // how much history the roll shows
~pvKeyH      = 190;     // keyboard height in pixels, capped at 45% of the
                        //   window so the roll never disappears
~pvGlowSecs  = 0.45;    // how long a released key keeps glowing. Without
                        //   this a staccato passage is invisible: the note
                        //   is gone before the next frame is drawn.
~pvShowRoll  = true;
~pvLabelCs   = true;    // write C1..C8 on the C keys

// --- colours ---------------------------------------------------------
// The dark surface and the two accents are the project's own, so this
// looks like it belongs with the infographic.
~pvBg        = Color.new255(20, 21, 19);
~pvWhite     = Color.new255(234, 232, 226);
~pvBlackKey  = Color.new255(28, 28, 26);
~pvEdge      = Color.new255(10, 10, 9);
~pvHeldCol   = Color.new255(25, 158, 112);    // finger down
~pvPedCol    = Color.new255(57, 135, 229);    // held by the pedal only
~pvInk       = Color.new255(160, 158, 150);
~pvGridCol   = Color.new255(38, 38, 35);

// --- geometry --------------------------------------------------------
// An 88-key piano is 52 white keys with 36 black ones wedged between them.
// White keys tile the width evenly; a black key is centred on the boundary
// between the two whites it sits between, which is why the layout needs a
// running count of white keys rather than a note-number-to-x formula.
~pvLo = 21;    // A0
~pvHi = 108;   // C8
~pvWhitePcs = [0, 2, 4, 5, 7, 9, 11];          // C D E F G A B
~pvIsBlack = Array.fill(128, { |n| ~pvWhitePcs.includes(n % 12).not });
~pvWhiteBelow = Array.fill(128, 0);
~pvNWhite = 0;
(~pvLo..~pvHi).do { |n|
	~pvWhiteBelow[n] = ~pvNWhite;              // whites strictly below n
	~pvIsBlack[n].not.if { ~pvNWhite = ~pvNWhite + 1 };
};

// Where one key is, given the keyboard's box. Black keys are drawn after
// all the whites so they sit on top.
~pvKeyRect = { |num, x0, y0, w, h|
	var ww = w / ~pvNWhite, bw, r;
	~pvIsBlack[num].if {
		bw = ww * 0.64;
		r = Rect(x0 + (~pvWhiteBelow[num] * ww) - (bw * 0.5), y0, bw, h * 0.62);
	} {
		r = Rect(x0 + (~pvWhiteBelow[num] * ww), y0, ww - 1.0, h);
	};
	r;
};

~pvNoteName = { |n|
	var names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
	names[n % 12] ++ ((n div: 12) - 1);
};

// --- state -----------------------------------------------------------
~pvHeldNotes  = IdentityDictionary.new;   // num -> velocity, finger down
~pvSustained  = IdentityDictionary.new;   // num -> velocity, pedal only
~pvGlowing    = IdentityDictionary.new;   // num -> [velocity, releasedAt]
~pvPedalDown  = false;
~pvRoll       = List.new;                 // [num, vel, tOn, tOff or nil]
~pvOpenBar    = IdentityDictionary.new;   // num -> the roll entry still open
~pvCount      = 0;                        // notes seen, for the readout
~pvLast       = "";

// --- what a note does ------------------------------------------------
// Deliberately tolerant about velocity: a note-on of velocity 0 is a
// note-off in MIDI, and an imported .mid is full of them.
~pvOn = { |num, vel|
	var v = (vel ? 0.7).asFloat;
	((num >= ~pvLo) and: { num <= ~pvHi }).if {
		(v <= 0.0).if {
			~pvOff.value(num);
		} {
			var bar = [num, v, Main.elapsedTime, nil];
			~pvHeldNotes[num] = v;
			~pvSustained.removeAt(num);
			~pvGlowing.removeAt(num);
			~pvCount = ~pvCount + 1;
			~pvLast = ~pvNoteName.value(num);
			// Re-striking a note that is still sounding closes its old bar
			// and starts a new one, so the roll shows two notes rather than
			// one long one.
			~pvOpenBar[num].notNil.if { ~pvOpenBar[num][3] = Main.elapsedTime };
			~pvRoll.add(bar);
			~pvOpenBar[num] = bar;
		};
	};
};

~pvOff = { |num|
	var v = ~pvHeldNotes[num];
	v.notNil.if {
		~pvHeldNotes.removeAt(num);
		// The pedal is what decides whether lifting a finger ends the note.
		~pvPedalDown.if {
			~pvSustained[num] = v;
		} {
			~pvGlowing[num] = [v, Main.elapsedTime];
			~pvOpenBar[num].notNil.if {
				~pvOpenBar[num][3] = Main.elapsedTime;
				~pvOpenBar.removeAt(num);
			};
		};
	};
};

// Forget what has scrolled off the roll and what has stopped glowing.
// Called from drawFunc rather than from the note handlers, so the lists
// cannot grow while nothing is being drawn -- and kept out here so it can be
// tested without a window.
~pvPrune = { |now|
	~pvRoll.array.copy.do { |bar|
		((bar[3] ? now) < (now - ~pvRollSecs)).if { ~pvRoll.remove(bar) };
	};
	~pvGlowing.keys.asArray.do { |n|
		((now - ~pvGlowing[n][1]) > ~pvGlowSecs).if { ~pvGlowing.removeAt(n) };
	};
};

~pvPedal = { |down|
	~pvPedalDown = down;
	down.not.if {
		// Pedal up: everything it was holding is released now.
		~pvSustained.keys.asArray.do { |n|
			var v = ~pvSustained[n];
			~pvSustained.removeAt(n);
			~pvGlowing[n] = [v ? 0.7, Main.elapsedTime];
			~pvOpenBar[n].notNil.if {
				~pvOpenBar[n][3] = Main.elapsedTime;
				~pvOpenBar.removeAt(n);
			};
		};
	};
};

// --- getting the notes ------------------------------------------------
~pvAttached = ~pvAttached ? false;

~pvAttach = {
	~pvAttached.if {
		"piano_view: already attached".postln;
	} {
		(~noteOn.notNil and: { ~noteOff.notNil }).if {
			// The instrument is running: chain onto its own functions. No
			// second MIDI connection, so no doubled notes -- and the viewer
			// then also shows the demo and any imported .mid, because those
			// go through here too.
			~pvPrevOn = ~noteOn;
			~pvPrevOff = ~noteOff;
			~pvPrevPed = ~setPedal;
			~noteOn = { |num, v| ~pvPrevOn.value(num, v); ~pvOn.value(num, v) };
			~noteOff = { |num| ~pvPrevOff.value(num); ~pvOff.value(num) };
			~pvPrevPed.notNil.if {
				~setPedal = { |down| ~pvPrevPed.value(down); ~pvPedal.value(down) };
			};
			~pvMode = \wrapped;
			"piano_view: following openspace_piano.scd's own note functions"
				.postln;
		} {
			// Standalone. Own MIDIdef keys, so even if the main patch is
			// loaded later its \osp defs are untouched.
			MIDIClient.initialized.not.if { MIDIClient.init };
			MIDIIn.connectAll;
			MIDIdef.noteOn(\pvNoteOn, { |vel, num|
				{ ~pvOn.value(num, vel / 127) }.defer;
			});
			MIDIdef.noteOff(\pvNoteOff, { |vel, num|
				{ ~pvOff.value(num) }.defer;
			});
			MIDIdef.cc(\pvPedalCC, { |val, num|
				{ ~pvPedal.value(val > 63) }.defer;
			}, 64);
			~pvMode = \standalone;
			"piano_view: own MIDI connection (openspace_piano.scd not loaded)"
				.postln;
		};
		~pvAttached = true;
	};
};

~pvDetach = {
	(~pvMode == \wrapped).if {
		// Only safe because nothing else has wrapped them since.
		~pvPrevOn.notNil.if { ~noteOn = ~pvPrevOn };
		~pvPrevOff.notNil.if { ~noteOff = ~pvPrevOff };
		~pvPrevPed.notNil.if { ~setPedal = ~pvPrevPed };
	} {
		[\pvNoteOn, \pvNoteOff, \pvPedalCC].do { |k|
			MIDIdef.all[k].notNil.if { MIDIdef.all[k].free };
		};
	};
	~pvAttached = false;
	"piano_view: detached".postln;
};

// --- the window -------------------------------------------------------
~pvWin.notNil.if { ~pvWin.close };
~pvWin = Window("88 keys", Rect(120, 120, 1180, 460))
	.background_(~pvBg);
~pvView = UserView(~pvWin, ~pvWin.view.bounds).resize_(5);

~pvView.drawFunc = { |v|
	var w = v.bounds.width, h = v.bounds.height;
	var keyH = min(~pvKeyH, h * 0.45);
	var rollH = h - keyH - 26;
	var keyY = h - keyH;
	var now = Main.elapsedTime;
	var ww = w / ~pvNWhite;

	~pvPrune.value(now);

	// -- the readout
	Pen.stringLeftJustIn(
		"held % · sustained % · pedal % · % notes%".format(
			~pvHeldNotes.size, ~pvSustained.size,
			~pvPedalDown.if({ "down" }, { "up" }), ~pvCount,
			(~pvLast.size > 0).if({ " · last " ++ ~pvLast }, { "" })),
		Rect(10, 6, w - 20, 16), Font("Helvetica", 11), ~pvInk);

	// -- the roll
	(~pvShowRoll and: { rollH > 20 }).if {
		var top = 24;
		// one line per second, so the scroll speed is legible
		Pen.width = 1;
		(1 .. ~pvRollSecs.floor.asInteger).do { |s|
			var y = top + rollH - (s / ~pvRollSecs * rollH);
			Pen.strokeColor = ~pvGridCol;
			Pen.line(Point(0, y), Point(w, y));
			Pen.stroke;
		};
		~pvRoll.do { |bar|
			var num = bar[0], vel = bar[1], t0 = bar[2], t1 = bar[3] ? now;
			var kr = ~pvKeyRect.value(num, 0, 0, w, 1);
			var yBot = top + rollH - ((now - t1) / ~pvRollSecs * rollH);
			var yTop = top + rollH - ((now - t0) / ~pvRollSecs * rollH);
			var inset = ~pvIsBlack[num].if({ 0.0 }, { kr.width * 0.16 });
			yTop = max(top, yTop);
			(yBot > top).if {
				Pen.fillColor = ~pvHeldCol.copy.alpha_(0.22 + (0.68 * vel));
				Pen.fillRect(Rect(kr.left + inset, yTop,
					max(2.0, kr.width - (inset * 2)), max(2.0, yBot - yTop)));
			};
		};
		// a line where the roll meets the keys: notes are born there
		Pen.strokeColor = ~pvInk.copy.alpha_(0.5);
		Pen.line(Point(0, top + rollH), Point(w, top + rollH));
		Pen.stroke;
	};

	// -- the white keys, then the black ones on top of them
	Pen.width = 1;
	(~pvLo .. ~pvHi).do { |num|
		~pvIsBlack[num].not.if {
			var r = ~pvKeyRect.value(num, 0, keyY, w, keyH);
			var lit = ~pvHeldNotes[num], sus = ~pvSustained[num];
			var glow = ~pvGlowing[num];
			var col = ~pvWhite;
			lit.notNil.if {
				col = ~pvWhite.blend(~pvHeldCol, 0.35 + (0.65 * lit));
			} {
				sus.notNil.if {
					col = ~pvWhite.blend(~pvPedCol, 0.30 + (0.50 * sus));
				} {
					glow.notNil.if {
						var f = 1 - ((now - glow[1]) / ~pvGlowSecs);
						col = ~pvWhite.blend(~pvHeldCol,
							0.55 * glow[0] * max(0.0, f));
					};
				};
			};
			Pen.fillColor = col;
			Pen.fillRect(r);
			Pen.strokeColor = ~pvEdge;
			Pen.strokeRect(r);
			(~pvLabelCs and: { num % 12 == 0 }).if {
				Pen.stringCenteredIn(~pvNoteName.value(num),
					Rect(r.left, r.top + r.height - 16, r.width, 14),
					Font("Helvetica", 8), Color.new255(120, 118, 112));
			};
		};
	};
	(~pvLo .. ~pvHi).do { |num|
		~pvIsBlack[num].if {
			var r = ~pvKeyRect.value(num, 0, keyY, w, keyH);
			var lit = ~pvHeldNotes[num], sus = ~pvSustained[num];
			var glow = ~pvGlowing[num];
			var col = ~pvBlackKey;
			lit.notNil.if {
				col = ~pvBlackKey.blend(~pvHeldCol, 0.45 + (0.55 * lit));
			} {
				sus.notNil.if {
					col = ~pvBlackKey.blend(~pvPedCol, 0.40 + (0.45 * sus));
				} {
					glow.notNil.if {
						var f = 1 - ((now - glow[1]) / ~pvGlowSecs);
						col = ~pvBlackKey.blend(~pvHeldCol,
							0.7 * glow[0] * max(0.0, f));
					};
				};
			};
			Pen.fillColor = col;
			Pen.fillRect(r);
			Pen.strokeColor = ~pvEdge;
			Pen.strokeRect(r);
		};
	};
};

~pvAttach.value;

~pvRedraw.notNil.if { ~pvRedraw.stop };
~pvRedraw = Routine({
	loop {
		~pvView.notNil.if { ~pvView.refresh };
		(1 / ~pvFps).wait;
	};
}).play(AppClock);

~pvWin.onClose = {
	~pvRedraw.notNil.if { ~pvRedraw.stop };
	~pvDetach.value;
	~pvView = nil;
	~pvWin = nil;
};

~pvWin.front;
"".postln;
("piano_view: % keys, % white, % black -- play something."
	.format(~pvHi - ~pvLo + 1, ~pvNWhite, ~pvHi - ~pvLo + 1 - ~pvNWhite))
	.postln;
)


// ---------------------------------------------------------------------
//  Utilities -- run these on their own
// ---------------------------------------------------------------------

// Light every key in turn, bottom to top. Worth running once: if the
// geometry is wrong this is where it shows, because the lit key should
// walk smoothly across the keyboard with no gaps and no jumps.
(
Routine({
	(~pvLo .. ~pvHi).do { |n|
		~pvOn.value(n, 0.9);
		0.045.wait;
		~pvOff.value(n);
	};
	"self test done".postln;
}).play(AppClock);
)

// A chord, held, then pedalled -- shows the three key states at once
(
Routine({
	[60, 64, 67, 71].do { |n| ~pvOn.value(n, 0.8) };
	1.0.wait;
	~pvPedal.value(true);
	[60, 64, 67, 71].do { |n| ~pvOff.value(n) };   // now sustained, blue
	2.0.wait;
	~pvPedal.value(false);
}).play(AppClock);
)

~pvShowRoll = false;      // keyboard only
~pvShowRoll = true;
~pvRollSecs = 12.0;       // slower scroll, more history
~pvFps = 30;              // lighter on the GUI thread

~pvDetach.value;          // stop following the MIDI/note functions
~pvWin.close;             // ...and put the window away
