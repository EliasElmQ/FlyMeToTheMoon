"""Convert a Standard MIDI File into a score the piano can play itself.

    python mid_to_score.py chopin.mid

Writes chopin.score beside it: a flat, absolute-time event list that
openspace_piano.scd loads and plays through ~noteOn / ~noteOff / ~setPedal --
the same three functions a keyboard drives and the same three the built-in demo
drives. So the analysis, the bass steering, the treble size boost and the pedal
all behave exactly as they would under real hands.

Stdlib only, deliberately: SuperCollider has no MIDI-file reader in its class
library, and adding a Quark or a pip dependency to play a file offline is a
worse trade than eighty lines of parsing. Parsing here rather than in sclang
also means the conversion is testable without an audio server.

Four things in the format produce plausible-looking but wrong results if
skipped, and all four are handled:

  * note-off is usually encoded as note-on with velocity 0. Miss it and every
    note hangs forever.
  * running status: the status byte is omitted when it repeats. A parser that
    ignores it desynchronises and yields garbage after the first few events.
  * the tempo map is set_tempo meta events against the header's ticks-per-
    quarter, and can change mid-piece. Ignoring it gives confidently wrong
    timing.
  * channel 10 is percussion. Those notes as piano pitches are nonsense, and
    worse, they pollute the bass, centroid and spread the visuals run on.

Read the report it prints. It tells you whether the file will actually steer
the camera, which is the thing most likely to surprise you: real piano writing
puts its bass around E2-C3, above the bridge's BASS_SPLIT, so an unmodified
file navigates nowhere and the camera silently falls back to its itinerary.
"""
from __future__ import annotations

import argparse
import os
import struct
import sys

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
DRUM_CHANNEL = 9          # channel 10, one-based
SUSTAIN_CC = 64
DEFAULT_TEMPO = 500000    # microseconds per quarter note; 120 bpm
DOUBLING_S = 0.03         # a re-strike sooner than this is a doubling, not a
                          # repeat: one voice, not a 1 ms voice and a click
MIN_NOTE_S = 0.03         # shorter notes are stretched to this


# --------------------------------------------------------------- parsing ---
class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.i = 0

    def u8(self) -> int:
        v = self.d[self.i]
        self.i += 1
        return v

    def u16(self) -> int:
        v = struct.unpack(">H", self.d[self.i:self.i + 2])[0]
        self.i += 2
        return v

    def u32(self) -> int:
        v = struct.unpack(">I", self.d[self.i:self.i + 4])[0]
        self.i += 4
        return v

    def take(self, n: int) -> bytes:
        v = self.d[self.i:self.i + n]
        self.i += n
        return v

    def vlq(self) -> int:
        """Variable-length quantity: 7 bits per byte, high bit means continue."""
        v = 0
        while True:
            b = self.u8()
            v = (v << 7) | (b & 0x7F)
            if not b & 0x80:
                return v


def parse(path: str):
    """-> (fmt, division, [ (tick, kind, a, b, channel) ], tempo_map)

    kind is one of "on", "off", "cc"; a/b are note/velocity or cc/value.
    """
    raw = open(path, "rb").read()
    r = Reader(raw)
    if r.take(4) != b"MThd":
        raise SystemExit(f"{path}: not a MIDI file (no MThd header)")
    hdr_len = r.u32()
    fmt = r.u16()
    ntracks = r.u16()
    division = struct.unpack(">h", r.take(2))[0]
    r.i += max(0, hdr_len - 6)

    events = []
    tempo_map = []            # (tick, microseconds per quarter)
    for _t in range(ntracks):
        # Some files pad or misreport; scan for the next MTrk rather than
        # trusting the position blindly.
        while r.i < len(raw) and raw[r.i:r.i + 4] != b"MTrk":
            r.i += 1
        if r.i >= len(raw):
            break
        r.take(4)
        length = r.u32()
        end = r.i + length
        tick = 0
        status = None
        while r.i < end:
            tick += r.vlq()
            b = r.d[r.i]
            # Meta and sysex are handled BEFORE the running-status logic and
            # never become the running status. Storing 0xFF there made the
            # next running-status channel event parse as a meta event, which
            # silently swallowed it -- a note-off after a marker, typically.
            if b == 0xFF:                            # meta
                r.u8()
                mtype = r.u8()
                n = r.vlq()
                data = r.take(n)
                if mtype == 0x51 and n == 3:
                    tempo_map.append(
                        (tick, (data[0] << 16) | (data[1] << 8) | data[2]))
                # 0x2F end-of-track: the loop bound already handles it
                continue
            if b in (0xF0, 0xF7):                    # sysex
                r.u8()
                r.take(r.vlq())
                continue
            if b & 0x80:
                status = r.u8()
            elif status is None:
                raise SystemExit(f"{path}: data byte before any status byte")
            # else: running status -- reuse `status`, b is the first data byte

            hi = status & 0xF0
            ch = status & 0x0F
            if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                a, b2 = r.u8(), r.u8()
                if hi == 0x90:
                    # velocity 0 is a note-off in nearly every real file
                    events.append((tick, "off" if b2 == 0 else "on", a, b2, ch))
                elif hi == 0x80:
                    events.append((tick, "off", a, b2, ch))
                elif hi == 0xB0:
                    events.append((tick, "cc", a, b2, ch))
                # aftertouch and bend are read and discarded, which is what
                # keeps the stream aligned
            elif hi in (0xC0, 0xD0):
                r.u8()
            else:
                raise SystemExit(f"{path}: unknown status byte {status:#04x}")
        r.i = end
    return fmt, division, events, sorted(tempo_map)


def seconds_of(division: int, tempo_map):
    """Return tick -> seconds, honouring every tempo change."""
    if division < 0:                      # SMPTE: frames per second
        fps = -(division >> 8)
        sub = division & 0xFF
        per_tick = 1.0 / (fps * sub)
        return lambda t: t * per_tick

    tpq = division or 480
    marks = tempo_map or [(0, DEFAULT_TEMPO)]
    if marks[0][0] > 0:
        marks = [(0, DEFAULT_TEMPO)] + marks
    # precompute the elapsed seconds at each tempo change
    table = []
    acc = 0.0
    for i, (tick, upq) in enumerate(marks):
        table.append((tick, acc, upq))
        if i + 1 < len(marks):
            acc += (marks[i + 1][0] - tick) * (upq / 1e6) / tpq

    def to_sec(t):
        lo = 0
        for j, (tick, _a, _u) in enumerate(table):
            if tick <= t:
                lo = j
            else:
                break
        tick, base, upq = table[lo]
        return base + (t - tick) * (upq / 1e6) / tpq

    return to_sec


# ------------------------------------------------------------- shaping ---
def build(path, drums=False, bass_octaves=0, bass_boundary=60,
          channels=None, transpose=0):
    fmt, division, raw_events, tempo_map = parse(path)
    if fmt == 2:
        print("!! format 2: tracks are independent sequences, but they are "
              "being treated as simultaneous. Check the result.")

    to_sec = seconds_of(division, tempo_map)

    # Within one tick, notes keep their file order and the pedal comes after
    # them, so a pedal pressed on a chord change catches the new chord and
    # not the one being released. Notes used to be re-ordered off-before-on
    # too, but that turned a genuine zero-length note (on, off) into an off
    # that found nothing and an on that then rang until the end of the
    # piece; the per-pitch count below makes a legato repeat come out right
    # in either order, so the file's own order can be kept.
    raw_events.sort(key=lambda e: (e[0], e[1] == "cc"))

    # The player keeps ONE voice per pitch and releases by pitch, so the score
    # must alternate on/off for every pitch. A MIDI file need not: a pitch can
    # be struck again before its previous note-off (legato exports, or the
    # same pitch on two channels). Written through raw, that late off lands
    # just after the re-strike and cuts the NEW note -- 805 notes of "A Sky
    # Full of Stars" were cut 1.3 ms after they started, an audible click
    # train. So note instances are counted per pitch: a re-strike becomes
    # off+on, and an off is only written when the last instance ends.
    # One exception: the same pitch struck twice on the same channel at the
    # same tick is a duplicate in the export (Time has 348 of them), not two
    # notes, and usually comes with one off. Counted, it would never return
    # to zero and the note would ring on until that pitch was next struck.
    out = []
    moved = 0
    count = {}            # pitch -> MIDI note instances currently sounding
    struck = {}           # (channel, pitch) -> tick of its latest note-on
    began = {}            # pitch -> seconds its sounding voice was struck
    for tick, kind, a, b, ch in raw_events:
        if ch == DRUM_CHANNEL and not drums:
            continue
        if channels and ch not in channels:
            continue
        t = to_sec(tick)
        if kind == "cc":
            if a == SUSTAIN_CC:
                out.append((t, "ped", 1 if b > 63 else 0, 0.0))
            continue
        note = a + transpose
        if bass_octaves and note < bass_boundary:
            note -= 12 * bass_octaves
            moved += 1
        note = max(0, min(127, note))
        n = count.get(note, 0)
        if kind == "off":
            # An off with nothing sounding is a doubled or orphaned off
            # (Cornfield Chase has hundreds) and is dropped.
            if n == 1:
                del count[note]
                out.append((t, "off", note, 0.0))
            elif n > 1:
                count[note] = n - 1
            continue
        # A 0x80 note-off carries a release velocity, which nothing downstream
        # reads, so offs are always written as 0.
        vel = round(b / 127.0, 4)
        if n and struck.get((ch, note)) == tick:
            continue                            # duplicate note-on
        struck[(ch, note)] = tick
        if n and t - began[note] < DOUBLING_S:
            # The same pitch doubled in another part a tick or two later
            # (Rocket Man has hundreds). Re-striking would sound a voice for
            # a millisecond and damp it -- a click. One voice, two owners.
            count[note] = n + 1
            continue
        if n:
            out.append((t, "off", note, 0.0))   # re-strike: damp, then strike
        count[note] = n + 1
        began[note] = t
        out.append((t, "on", note, vel))

    # anything still sounding at the end must be released, or it hangs
    if count:
        last = max(e[0] for e in out) + 0.25
        for note in sorted(count):
            out.append((last, "off", note, 0.0))

    # A note a few milliseconds long is a click, not a note (FlyMeToTheMoon
    # has two of 2.5 ms, both on the steering B1). Stretch it to MIN_NOTE_S,
    # but never past the next strike of the same pitch -- and if that strike
    # comes sooner than MIN_NOTE_S (Life on Mars has on, off, on at a single
    # tick), the short note is a doubling of it and is dropped.
    open_at, nxt_on, stretch, drop = {}, {}, {}, set()
    for i in range(len(out) - 1, -1, -1):
        t, kind, note, _v = out[i]
        if kind == "on":
            nxt_on[i] = open_at.get(note)
            open_at[note] = t
    open_at = {}
    for i, (t, kind, note, _v) in enumerate(out):
        if kind == "on":
            open_at[note] = i
        elif kind == "off" and note in open_at:
            j = open_at.pop(note)
            if t - out[j][0] < MIN_NOTE_S:
                limit = nxt_on[j] if nxt_on[j] is not None else float("inf")
                if limit - out[j][0] < MIN_NOTE_S:
                    drop.update((i, j))
                else:
                    stretch[i] = out[j][0] + MIN_NOTE_S
    if stretch or drop:
        out = [(stretch.get(i, e[0]),) + e[1:]
               for i, e in enumerate(out) if i not in drop]
        out.sort(key=lambda e: e[0])          # stable: ties keep their order

    return out, moved, fmt, division, tempo_map


# -------------------------------------------------------------- report ---
def report(events, moved, fmt, division, tempo_map, bass_split):
    ons = [e for e in events if e[1] == "on"]
    peds = [e for e in events if e[1] == "ped"]
    if not ons:
        print("!! no playable notes found")
        return
    dur = max(e[0] for e in events)
    notes = [e[2] for e in ons]
    print(f"  format {fmt}, division {division}, "
          f"{len(tempo_map) or 'no'} tempo change(s)")
    print(f"  {len(ons)} notes over {dur:.1f}s "
          f"({len(ons) / max(dur, 1e-9):.1f} notes/s average)")
    print(f"  range {NOTE_NAMES[min(notes) % 12]}{min(notes) // 12 - 1}"
          f" to {NOTE_NAMES[max(notes) % 12]}{max(notes) // 12 - 1}"
          f"   pedal events {len(peds)}")
    if moved:
        print(f"  {moved} notes transposed down for the bass split")

    above = sum(1 for n in notes if n >= 84)
    print(f"  {above} notes at C6 or above "
          + ("-- the size boost will fire" if above else
             "-- the size boost will never fire"))

    # will it steer? walk the timeline and see what the lowest sounding note is
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        for d in ( os.path.dirname(here), here ):
            if d not in sys.path:
                sys.path.insert(0, d)
        import openspace_bridge as ob
        body_of = {k: (v if v != ob.OUTWARD else "outward")
                   for k, v in ob.PITCH_BODY.items()}
    except Exception:
        body_of = {}

    down, prev_t, steer_time, per_pc = set(), 0.0, 0.0, {}
    for t, kind, note, _v in events:
        if down and t > prev_t:
            lo = min(down)
            if lo <= bass_split:
                steer_time += t - prev_t
                per_pc[lo % 12] = per_pc.get(lo % 12, 0.0) + (t - prev_t)
        if kind == "on":
            down.add(note)
        elif kind == "off":
            down.discard(note)
        prev_t = t

    pct = 100.0 * steer_time / max(dur, 1e-9)
    print(f"  steering: the lowest sounding note is at or below "
          f"{NOTE_NAMES[bass_split % 12]}{bass_split // 12 - 1} "
          f"for {pct:.0f}% of the piece")
    if per_pc:
        best = sorted(per_pc.items(), key=lambda kv: -kv[1])
        print("    destinations it visits: " + ", ".join(
            f"{NOTE_NAMES[pc]}"
            + (f"={body_of[pc]}" if pc in body_of else "")
            + f" {sec:.0f}s"
            for pc, sec in best[:6]))
    else:
        print("    it will NOT steer: nothing ever sounds low enough. The "
              "camera will follow its fixed itinerary instead.")
        print("    fix with --bass-octaves 1 (or 2), or raise the bridge's "
              "--bass-split")


# ---------------------------------------------------------------- write ---
def options_of(a) -> list[str]:
    """The conversion options that differ from the defaults, as flags.

    Written into the .score header so a score can be regenerated exactly:
    "A Sky Full of Stars" needs --bass-octaves 1 --bass-boundary 48, and that
    used to be recorded only in CLAUDE.md."""
    o = []
    if a.drums:
        o.append("--drums")
    if a.bass_octaves:
        o += ["--bass-octaves", str(a.bass_octaves)]
    if a.bass_boundary != 60:
        o += ["--bass-boundary", str(a.bass_boundary)]
    if a.transpose:
        o += ["--transpose", str(a.transpose)]
    if a.channels:
        o += ["--channels", a.channels]
    return o


def write(events, path, src, options=()):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(f"# generated by mid_to_score.py from {os.path.basename(src)}\n")
        if options:
            f.write(f"# options: {' '.join(options)}\n")
        f.write(f"# {len(events)} events, "
                f"{max((e[0] for e in events), default=0):.3f}s\n")
        f.write("# seconds,kind,note,velocity  (kind: on off ped)\n")
        for t, kind, note, vel in events:
            f.write(f"{t:.4f},{kind},{note},{vel:g}\n")


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Convert a .mid into a score openspace_piano.scd can play")
    p.add_argument("midi", help="input .mid")
    p.add_argument("-o", "--out", help="output .score (default: alongside)")
    p.add_argument("--drums", action="store_true",
                   help="keep channel 10 as pitched notes (off by default: "
                        "percussion notes pollute bass, centroid and spread)")
    p.add_argument("--bass-octaves", type=int, default=0, metavar="N",
                   help="transpose notes below --bass-boundary down N octaves, "
                        "so the bass falls under the bridge's BASS_SPLIT and "
                        "the piece can actually steer. Pitch classes are "
                        "preserved, so the destinations do not change")
    p.add_argument("--bass-boundary", type=int, default=60, metavar="MIDI",
                   help="what counts as the left hand for --bass-octaves "
                        "(default 60, middle C)")
    p.add_argument("--bass-split", type=int, default=None, metavar="MIDI",
                   help="the bridge's BASS_SPLIT, for the steering report "
                        "(default: read from openspace_bridge.py)")
    p.add_argument("--transpose", type=int, default=0, metavar="N",
                   help="transpose everything by N semitones")
    p.add_argument("--channels", type=str, default=None,
                   help="comma-separated channels to keep, 1-based")
    a = p.parse_args(argv)

    split = a.bass_split
    if split is None:
        try:
            here = os.path.dirname(os.path.abspath(__file__))
            for d in ( os.path.dirname(here), here ):
                if d not in sys.path:
                    sys.path.insert(0, d)
            import openspace_bridge as ob
            split = ob.BASS_SPLIT
        except Exception:
            split = 37

    chans = None
    if a.channels:
        chans = {int(c) - 1 for c in a.channels.split(",") if c.strip()}

    events, moved, fmt, division, tempo_map = build(
        a.midi, drums=a.drums, bass_octaves=a.bass_octaves,
        bass_boundary=a.bass_boundary, channels=chans, transpose=a.transpose)
    if not events:
        raise SystemExit("nothing to write")

    out = a.out
    if not out:
        # strip every .mid, so Space-Oddity.mid.mid -> Space-Oddity.score
        stem = a.midi
        while stem.lower().endswith((".mid", ".midi")):
            stem = os.path.splitext(stem)[0]
        out = stem + ".score"
    write(events, out, a.midi, options_of(a))
    print(f"{a.midi} -> {out}")
    report(events, moved, fmt, division, tempo_map, split)
    print(f"\nIn SuperCollider:  ~midiLoad.value(~scoreDir +/+ \"{os.path.basename(out)}\"); "
          f"~midiPlay.value;")
    return 0


if __name__ == "__main__":
    sys.exit(main())
