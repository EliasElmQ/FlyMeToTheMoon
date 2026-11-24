#!/usr/bin/env python3
"""
openspace_bridge.py -- the OpenSpace half of the piano instrument.

    MIDI piano -> SuperCollider -> OSC/UDP -> [this bridge] -> TCP -> OpenSpace

`openspace_piano.scd` analyses the playing and streams normalised 0..1 control
values over OSC at 30 Hz. This process translates them into OpenSpace scripting
calls and pushes them down OpenSpace's TCP socket interface.

No third-party packages. OSC is decoded here (60 lines, receive-only) and
OpenSpace's socket API is newline-delimited JSON, so the standard library is
enough. Just:

    python openspace_bridge.py              # normal run
    python openspace_bridge.py --dry-run    # print the Lua, never connect
    python openspace_bridge.py --verbose    # print every message sent

Everything below was checked against the OpenSpace source rather than guessed;
see PROTOCOL NOTES at the bottom of this file for the specifics and where they
live in the tree.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import signal
import socket
import struct
import sys
import time

# ---------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------

OSC_HOST = "127.0.0.1"
OSC_PORT = 7000          # must match ~osPort in openspace_piano.scd
OS_HOST = "127.0.0.1"
OS_PORT = 4681           # OpenSpace DefaultTcpSocketInterface
PREFIX = "/piano"        # must match ~prefix in openspace_piano.scd

TICK = 1 / 30.0          # emit rate; the SC side sends at 30 Hz
STATUS_EVERY = 0.5       # seconds between monitor lines
RECONNECT_EVERY = 2.0

# Operating mode defaults (can also be toggled with --slow, --time-only,
# --no-camera, --no-layers, --time on the command line).
#   SLOW_MODE = True   -> limits camera rotation movement (gentler elevation
#                         orbit, minimal roll turbulence, and slower focus
#                         retarget turns).
#   TIME_ONLY = True   -> stops all camera movement AND leaves scene layers,
#                         point sizes and labels untouched; ONLY simulation time
#                         speed changes with the playing.
#   CAMERA = False     -> stops all camera movement (tour, bass steering, focus
#                         lock, zoom, rotation, roll), while keeping scene
#                         layers active.
#   DRIVE_TIME = False -> in normal mode, leave OpenSpace's simulation time
#                         speed alone (enabled automatically by --time-only).
SLOW_MODE = False
TIME_ONLY = False
CAMERA = True
DRIVE_LAYERS = True
DRIVE_TIME = False

# Scene layers.
#
#   (name, renderable URI, rank, {source: threshold, ...})
#
# Layers are NOT driven continuously off the derived values. They accumulate.
#
#   * While you keep playing, a `progress` counter climbs. Every whole unit it
#     gains activates one more layer. Roughly five seconds of gentle continuous
#     playing is worth one layer; playing faster and harder makes it climb up to
#     about four times quicker (see LAYER_PACE).
#   * An activated layer LATCHES. It stays lit until you actually stop playing,
#     so nothing flickers while you are in the middle of something.
#   * When you stop, progress resets and everything fades back out.
#
# `rank` is the order layers are activated in: low ranks are the near, simple
# things, high ranks the deep universe. It is separate from the table order so
# the table can stay grouped by family and still reveal in a sensible sequence.
#
# The conditions decide which layers are ELIGIBLE at the moment progress ticks
# over. Every condition must be met. So the conditions choose *what* you get and
# the playing duration and intensity choose *how much* -- a layer requiring
# {"polyphony": 0.68} only enters the queue while you are actually holding a
# thick chord, and a single-note passage will never reach it however long it
# lasts.
#
# Sources: energy, centroid, tension, polyphony, density, spread, loudness.
# Any of them may be suffixed "_inv" to drive off (1 - value).
#
# No label layers: nothing here renders text. Layers that carry their own
# embedded labels get `Labels.Enabled` switched off at startup, unless
# --keep-labels is passed.
#
# The URI is the RENDERABLE, not the property: the bridge drives `<uri>.Fade`
# and `<uri>.Enabled`. Enabled matters because most digitaluniverse nodes ship
# disabled, and a disabled renderable does not draw at all whatever Fade says.
# Toggling it also keeps the GPU cost proportional to what is actually showing.
# The final tier -- grids, coordinate spheres, constellation boundaries and
# constellation figures -- is the reference scaffolding of the scene rather
# than anything in it, so it arrives last and takes a while.
#
# High ranks alone do not achieve that: the activation loop skips an ineligible
# layer rather than blocking on it, so a style that happens to satisfy only the
# tier's own conditions would get the tier early. These layers therefore also
# require `earned`, the fraction of all layers already lit.
#
# 0.5 with sixty of the eighty-one layers outside the tier: a chord-based
# passage lights most of those and reaches about 0.74, so there is margin even
# when many of the rest never become eligible for a given style. A threshold no
# playing can reach would make the whole tier dead, which this table has done
# before.
LAST_TIER_EARNED = 0.5

LAYERS = [
    # ---- the local sky: reachable with single notes -------------------
    ("EarthAtmosphere",      "Scene.EarthAtmosphere.Renderable",         1,  {}),
    # The other atmospheres in the scene. Unconditional, like Earth's: an
    # atmosphere is not a reveal, it is detail that only exists when you
    # are at that body. Ranked to fall roughly where the itinerary arrives
    # -- Venus before Mars, Titan around Saturn.
    ("VenusAtmosphere",      "Scene.VenusAtmosphere.Renderable",         14, {}),
    ("MarsAtmosphere",       "Scene.MarsAtmosphere.Renderable",          15, {}),
    ("TitanAtmosphere",      "Scene.TitanAtmosphere.Renderable",         18, {}),
    ("MoonTrail",            "Scene.MoonTrail.Renderable",               2,  {}),
    ("PlanetTrails",         "{planetTrail_solarSystem}.Renderable",     3,  {}),
    ("Stars",                "Scene.Stars.Renderable",                   4,  {}),
    ("Constellations",       "Scene.Constellations.Renderable",          6,  {}),
    # The figures themselves, not one node but ~88 of them -- one per
    # constellation, built in a loop by constellation_art.asset and named
    # "ImageConstellation-" .. abbreviation. The wildcard is expanded by
    # OpenSpace, so this stays two Lua calls a tick. Gated on consonance,
    # like the lines and the bounds: the constellation family answers to
    # harmony rather than to effort.
    ("ConstellationArt",     "Scene.ImageConstellation-*.Renderable",    101,  {"tension_inv": 0.60, "earned": LAST_TIER_EARNED}),
    ("OortSphere",           "Scene.OortSphere.Renderable",              95,  {"energy": 0.25, "earned": LAST_TIER_EARNED}),
    ("MilkyWayVolume",       "Scene.MilkyWayVolume.Renderable",          10, {"energy": 0.30}),
    ("MilkyWayImage",        "Scene.MilkyWayGalaxyImage.Renderable",     12, {"energy": 0.35}),

    # ---- two notes and up ---------------------------------------------
    ("MoonTrails",           "{moonTrail_solarSystem}.Renderable",       5,  {"polyphony": 0.20}),
    # Everything in Earth orbit at once -- 48 groups, from Starlink and GPS
    # to the Kosmos-2251 debris cloud. They all carry Tag =
    # { "earth_satellites" }, so one tag URI drives the lot, the same trick
    # as the planet trails. A swarm, so it answers to holding a chord; and
    # early, because it is only visible while we are still near Earth.
    ("EarthSatellites",      "{earth_satellites}.Renderable",            8,  {"polyphony": 0.35}),

    # ---- spread: keyboard span as spatial scale -----------------------
    # `spread` is 0 for a single note by construction, so the grid ladder is
    # intrinsically gated on playing more than one key at a time.
    # Ordered by ACTUAL size, which the names do not give away: "1lm" is a
    # light-MONTH, not a light-minute, so it belongs above the light-day grid
    # rather than at the bottom. It sat at the bottom until the sizes were
    # read out of the asset (2 * LightMonth = 61 light-days).
    #
    # The two smallest rungs are Earth-centred grids from
    # scene/solarsystem/planets/earth/grids.asset, a different asset from the
    # rest of the ladder, which is why they were missing.
    ("Grid1lsec",            "Scene.1lsecGrid.Renderable",               80,  {"spread": 0.03, "earned": LAST_TIER_EARNED}),
    ("Grid1lmin",            "Scene.1lminGrid.Renderable",               81,  {"spread": 0.06, "earned": LAST_TIER_EARNED}),
    ("Grid1lh",              "Scene.1lhGrid.Renderable",                 82,  {"spread": 0.10, "earned": LAST_TIER_EARNED}),
    ("Grid1ld",              "Scene.1ldGrid.Renderable",                 83, {"spread": 0.15, "earned": LAST_TIER_EARNED}),
    ("Grid1lm",              "Scene.1lmGrid.Renderable",                 84, {"spread": 0.20, "earned": LAST_TIER_EARNED}),
    ("Grid1ly",              "Scene.1lyGrid.Renderable",                 85, {"spread": 0.24, "earned": LAST_TIER_EARNED}),
    ("Grid10ly",             "Scene.10lyGrid.Renderable",                86, {"spread": 0.30, "earned": LAST_TIER_EARNED}),
    ("Grid100ly",            "Scene.100lyGrid.Renderable",               87, {"spread": 0.36, "earned": LAST_TIER_EARNED}),
    ("Grid1kly",             "Scene.1klyGrid.Renderable",                88, {"spread": 0.42, "earned": LAST_TIER_EARNED}),
    ("Grid10kly",            "Scene.10klyGrid.Renderable",               89, {"spread": 0.48, "earned": LAST_TIER_EARNED}),
    ("Grid100kly",           "Scene.100klyGrid.Renderable",              90, {"spread": 0.55, "earned": LAST_TIER_EARNED}),
    ("Grid1Mly",             "Scene.1MlyGrid.Renderable",                91, {"spread": 0.62, "earned": LAST_TIER_EARNED}),
    ("Grid10Mly",            "Scene.10MlyGrid.Renderable",               92, {"spread": 0.70, "earned": LAST_TIER_EARNED}),
    ("Grid100Mly",           "Scene.100MlyGrid.Renderable",              93, {"spread": 0.78, "earned": LAST_TIER_EARNED}),
    ("Grid20Gly",            "Scene.20GlyGrid.Renderable",               94, {"spread": 0.86, "earned": LAST_TIER_EARNED}),

    # ---- polyphony: one star orbit per voice --------------------------
    ("SunOrbit",             "Scene.SunOrbit.Renderable",                14, {"polyphony": 0.26}),
    ("BarnardsOrbit",        "Scene.BarnardsOrbit.Renderable",           17, {"polyphony": 0.38}),
    ("KapteynsOrbit",        "Scene.KapteynsOrbit.Renderable",           20, {"polyphony": 0.48}),
    ("Lacaille9352Orbit",    "Scene.Lacaille9352Orbit.Renderable",       23, {"polyphony": 0.58}),
    ("LSR1826Orbit",         "Scene.LSR1826Orbit.Renderable",            26, {"polyphony": 0.68}),
    ("LSRJ0822Orbit",        "Scene.LSRJ0822Orbit.Renderable",           29, {"polyphony": 0.78}),
    ("PM_J13420Orbit",       "Scene.PM_J13420Orbit.Renderable",          33, {"polyphony": 0.86}),

    # ---- polyphony: clustered things ----------------------------------
    ("OpenStarClusters",     "Scene.OpenStarClusters.Renderable",        15, {"polyphony": 0.32}),
    ("GlobularClusters",     "Scene.GlobularClusters.Renderable",        21, {"polyphony": 0.50}),
    ("OBAssociations",       "Scene.OBAssociations.Renderable",          27, {"polyphony": 0.66}),

    # ---- centroid: register as stellar temperature -------------------
    ("SunStar",              "Scene.SunStar.Renderable",                 18, {"centroid_inv": 0.42}),
    ("BrownDwarfs",          "Scene.BrownDwarfs.Renderable",             24, {"centroid_inv": 0.58}),
    ("WhiteDwarfs",          "Scene.WhiteDwarfs.Renderable",             24, {"centroid": 0.56}),
    ("Pulsars",              "Scene.Pulsars.Renderable",                 30, {"centroid": 0.68}),
    ("Quasars",              "Scene.Quasars.Renderable",                 37, {"centroid": 0.80}),

    # ---- tension: dissonance as violence ----------------------------
    # Asteroids and comets by family -- main belt, Trojans, near-Earth,
    # Halley- and Encke-type comets. Sixteen nodes sharing the sssb_ prefix,
    # so one wildcard covers them; the sssb_data_* identifiers next to them
    # in the assets are download resources, not scene nodes, so they have no
    # properties for the wildcard to hit. Driven by density: it is a swarm,
    # and it fills exactly the part of the tour between Mars and Jupiter.
    ("SmallBodies",          "Scene.sssb_*.Renderable",                  15, {"density": 0.45}),

    ("HIIRegions",           "Scene.HIIRegions.Renderable",              16, {"tension": 0.22}),
    # The Orion Nebula in three dimensions: the nebula model, its shock
    # fronts and its proplyds. One wildcard for all three. It is an HII
    # region, so it joins the dissonance family above rather than the
    # surveys -- a violent place, and it should sound like one.
    ("OrionNebula",          "Scene.OrionNebula*.Renderable",            30, {"tension": 0.45}),
    ("PlanetaryNebulae",     "Scene.PlanetaryNebulae.Renderable",        22, {"tension": 0.36}),
    ("SupernovaRemnants",    "Scene.SupernovaRemnants.Renderable",       28, {"tension": 0.50}),
    ("StarUncertainty",      "Scene.StarUncertainty.Renderable",         34, {"tension": 0.64, "polyphony": 0.28}),

    # ---- consonance: geometric order --------------------------------
    ("EquatorialSphere",     "Scene.EquatorialSphere.Renderable",        96, {"tension_inv": 0.32, "polyphony": 0.20, "earned": LAST_TIER_EARNED}),
    ("EclipticSphere",       "Scene.EclipticSphere.Renderable",          97, {"tension_inv": 0.46, "polyphony": 0.28, "earned": LAST_TIER_EARNED}),
    ("GalacticSphere",       "Scene.GalacticSphere.Renderable",          98, {"tension_inv": 0.60, "polyphony": 0.38, "earned": LAST_TIER_EARNED}),
    ("ConstellationBounds",  "Scene.ConstellationBounds.Renderable",     100, {"tension_inv": 0.72, "polyphony": 0.28, "earned": LAST_TIER_EARNED}),
    ("RadioSphere",          "Scene.RadioSphere.Renderable",             99, {"tension_inv": 0.80, "polyphony": 0.48, "earned": LAST_TIER_EARNED}),

    # ---- density: fast playing fills the sky with points ------------
    ("TwoMASS",              "Scene.2MASS.Renderable",                   17, {"density": 0.26}),
    ("DeepSkyObjects",       "Scene.DeepSkyObjects.Renderable",          20, {"density": 0.32}),
    ("Exoplanets",           "Scene.Exoplanets.Renderable",              23, {"density": 0.38, "polyphony": 0.26}),
    ("SixdFGalaxies",        "Scene.6dF.Renderable",                     27, {"density": 0.44}),
    ("DeepSkyImages",        "Scene.DeepSkyObjectsImages.Renderable",    31, {"density": 0.50}),
    ("TwodFGalaxies",        "Scene.2dF.Renderable",                      35, {"density": 0.56}),
    ("PlanetaryCandidates",  "Scene.PlanetaryCandidates.Renderable",     38, {"density": 0.60, "polyphony": 0.38}),
    ("AllSkyVisible",        "Scene.AllSky_Visible.Renderable",          42, {"density": 0.68, "energy": 0.40}),
    ("HubbleDeepField",      "Scene.HubbleDeepField.Renderable",         45, {"density": 0.74, "energy": 0.55}),
    ("AllSkyHAlpha",         "Scene.AllSky_HAlpha.Renderable",           48, {"density": 0.82, "energy": 0.50}),

    # ---- the deep universe: sustained, loud, and thick --------------
    ("LocalDwarfGalaxies",   "Scene.LocalDwarfGalaxies.Renderable",      39, {"energy": 0.50, "polyphony": 0.32}),
    ("NearbyGalaxyGroups",   "Scene.NearbyGalaxyGroups.Renderable",      43, {"energy": 0.56, "polyphony": 0.40}),
    ("TullyGalaxies",        "Scene.TullyGalaxies.Renderable",           46, {"energy": 0.62, "polyphony": 0.46}),
    ("TullyImages",          "Scene.TullyGalaxiesImages.Renderable",     49, {"energy": 0.66, "polyphony": 0.52}),
    ("GalaxySuperclusters",  "Scene.GalaxySuperclusters.Renderable",     52, {"energy": 0.72, "polyphony": 0.56}),
    ("AbellClusters",        "Scene.Abell.Renderable",                   55, {"energy": 0.76, "polyphony": 0.60}),
    ("Voids",                "Scene.Voids.Renderable",                   58, {"energy": 0.80, "polyphony": 0.64}),
    ("SloanDigitalSkySurvey", "Scene.SloanDigitalSkySurvey.Renderable",  61, {"energy": 0.84, "polyphony": 0.68}),

    # ---- the edge of the observable universe ------------------------
    ("COBE",                 "Scene.COBE.Renderable",                    64, {"energy": 0.88, "polyphony": 0.72, "loudness": 0.70}),
    ("WMAP",                 "Scene.WMAP.Renderable",                    66, {"energy": 0.90, "polyphony": 0.76, "loudness": 0.74}),
    ("Planck",               "Scene.Planck.Renderable",                  68, {"energy": 0.92, "polyphony": 0.80, "loudness": 0.78}),
    ("Multiverse1",          "Scene.PlanckMultiverse1.Renderable",       70, {"energy": 0.94, "polyphony": 0.84, "loudness": 0.82}),
    ("Multiverse2",          "Scene.PlanckMultiverse2.Renderable",       71, {"energy": 0.95, "polyphony": 0.86, "loudness": 0.84}),
    ("Multiverse3",          "Scene.PlanckMultiverse3.Renderable",       72, {"energy": 0.96, "polyphony": 0.88, "loudness": 0.86}),
    ("Multiverse4",          "Scene.PlanckMultiverse4.Renderable",       73, {"energy": 0.97, "polyphony": 0.90, "loudness": 0.88}),
]

# Pace. `progress` gains one unit -- one layer -- every LAYER_PACE seconds at
# gentle continuous playing, and up to PACE_MAX times faster when you play
# rapidly and hard. The multiplier is driven by density (how rapid) and loudness
# (how much velocity), which is exactly what should make more layers appear.
LAYER_PACE = 5.0        # seconds per layer at gentle intensity
PACE_MIN = 0.5          # multiplier floor, so barely-there playing still creeps
PACE_MAX = 4.0          # multiplier ceiling for flat-out playing

# Fades, in seconds. Deliberately slow: this is the "less sensitive" part, and
# what stops a busy passage strobing.
FADE_IN = 1.8
FADE_OUT = 3.0

# How long the playing has to have stopped before the whole thing resets and
# everything fades out. Long enough that phrasing gaps and rests are safe.
HOLD_AFTER_STOP = 10.0

ENABLE_AT = 0.002   # Fade above this -> Renderable.Enabled true, below -> false

# Keeping text off the screen takes more than leaving label layers out of the
# table. OpenSpace draws text from four separate places, and anything this
# project never touches keeps whatever the scene set:
#
#   1. Embedded label components. 23 digitaluniverse point clouds declare
#      Labels = { Enabled = true }, overriding the C++ default of false.
#   2. Dedicated label NODES -- several hundred of them: every moon, planet,
#      dwarf planet, Lagrange point and spacecraft has a `<Name>Label` node
#      whose renderable is nothing but text.
#   3. Globe-browsing overlay layers called `<planet>_labels`, which are map
#      overlays with place names baked in.
#   4. A few odd names that the suffix patterns miss.
#
# parseRegex allows exactly ONE '*', splitting the URI into a prefix and a
# suffix that are then substring-matched (src/scene/scene_lua.inl). So
# `Scene.*.Renderable.Labels.Enabled` reaches every renderable in the scene, and
# `Scene.*Label.Renderable.Enabled` reaches every node whose name ENDS in
# "Label". That is what makes this a handful of calls rather than hundreds.
#
# Tag forms like {solarsystem_labels} are deliberately not used: the tags are
# applied to those same `<Name>Label` nodes, so the suffix patterns already
# cover them.
LABEL_SWEEPS = [
    "Scene.*.Renderable.Labels.Enabled",        # embedded label components
    "Scene.*Label.Renderable.Enabled",          # <Name>Label nodes
    "Scene.*Labels.Renderable.Enabled",         # <Name>Labels nodes
    "Scene.*LabelNear.Renderable.Enabled",      # CarpoLabelNear, S2018J4LabelNear
    "Scene.*_labels.Enabled",                   # globe overlay label layers
    "Scene.StarLabelsAlternate.Renderable.Enabled",
    "Scene.MilkyWayGalaxyArmLabelsImage.Renderable.Enabled",
]

# Breathing point sizes.
#
# Deliberately only the abstract point clouds -- galaxy catalogues, redshift
# surveys, exoplanet data -- where the size of a point is a visual convention
# rather than a physical fact. A galaxy drawn twice as large reads as emphasis;
# a planet drawn twice as large reads as wrong. Stars, trails, grids, spheres
# and the volumetric Milky Way are all left alone.
#
# All of these are RenderablePointCloud or its RenderablePolygonCloud subclass,
# so they share the `Sizing` property owner. `ScaleFactor` is the safe knob of
# the four: "simply just increases or decreases the visual size of the points",
# a plain multiplier applied after the exponential scaling, default 1, range
# 0..100. ScaleExponent would also work but is an absolute exponential and much
# easier to get spectacularly wrong.
#   modules/base/rendering/pointcloud/renderablepointcloud.cpp
#
# This is the one part of the layer system that IS continuously responsive. The
# layers themselves latch deliberately, so nothing flickers; size is modulation
# rather than activation, and having it track the playing gives back the
# immediate gestural feedback the latching takes away.
SIZED = [
    # the extragalactic catalogues
    "TullyGalaxies", "TullyImages", "GalaxySuperclusters", "AbellClusters",
    "Voids", "SloanDigitalSkySurvey", "NearbyGalaxyGroups",
    "LocalDwarfGalaxies", "TwoMASS", "SixdFGalaxies", "TwodFGalaxies",
    "Quasars", "DeepSkyObjects",
    # the exoplanet catalogues
    "Exoplanets", "PlanetaryCandidates",
    # ...and the stellar-scale clouds inside our own galaxy. These are
    # point clouds in the same sense, so there is no reason the reaction
    # should stop at the extragalactic ones. Any of them that turns out
    # not to have a Sizing property is dropped by the startup probe
    # rather than written to.
    "PlanetaryNebulae", "HIIRegions", "SupernovaRemnants",
    "OpenStarClusters", "GlobularClusters", "OBAssociations",
    "BrownDwarfs", "WhiteDwarfs", "Pulsars",
]

# `loudness` is a decaying peak accumulator on the SuperCollider side: each note
# pushes it up to that note's velocity and it bleeds away. That shape -- a jump
# on the attack, then a relax -- is exactly what makes the points pulse with the
# playing rather than drift with it.
# Which register each group of abstract points answers to. The keyboard is
# tiled into four bands by the .scd (~bandLowMax, ~bandMidMax, ~bandHighMax and
# ~trebleSplit), and pitch runs OUTWARD: the bottom of the keyboard moves the
# stellar-scale clouds inside our own galaxy, the middle the exoplanets and
# the nearest catalogues, and the top the deepest surveys and the
# largest-scale structure. Playing in one register therefore lights and
# swells one shell of the sky rather than all of it at once.
#
# This runs the opposite way round from the first version, which put the
# largest structures at the bottom of the keyboard on the grounds that the
# longest wavelengths should move the largest things. Ascending pitch
# reading as increasing distance is the stronger cue, and it is what was
# asked for: the galaxy catalogues answer to the high registers.
BAND_OF = {
    # A0-B2: the Milky Way's own stellar population -- remnants, nebulae,
    # clusters, dwarfs, pulsars
    "PlanetaryNebulae": "bandLow", "HIIRegions": "bandLow",
    "SupernovaRemnants": "bandLow", "OpenStarClusters": "bandLow",
    "GlobularClusters": "bandLow", "OBAssociations": "bandLow",
    "BrownDwarfs": "bandLow", "WhiteDwarfs": "bandLow",
    "Pulsars": "bandLow",
    # C3-B4: the exoplanets, and the intermediate distances -- the Local
    # Group and the bright deep-sky objects. The exoplanets are nearer than
    # anything else in the table and spent a revision in bandLow for that
    # reason; the middle of the keyboard is where they are wanted, and it
    # still keeps them a register clear of 2MASS in bandHigh, which is what
    # separating them was about.
    "Exoplanets": "bandMid", "PlanetaryCandidates": "bandMid",
    "DeepSkyObjects": "bandMid", "LocalDwarfGalaxies": "bandMid",
    # C5-B5: the galaxy groups and the mid-depth surveys. 2MASS is
    # extragalactic, so it belongs up here with them.
    "TwoMASS": "bandHigh",
    "NearbyGalaxyGroups": "bandHigh", "SixdFGalaxies": "bandHigh",
    "TullyGalaxies": "bandHigh", "TullyImages": "bandHigh",
    "AbellClusters": "bandHigh",
    # C6 and up: the deepest surveys and the largest-scale structure
    "TwodFGalaxies": "treble", "SloanDigitalSkySurvey": "treble",
    "GalaxySuperclusters": "treble", "Voids": "treble",
    "Quasars": "treble",
}

# The three redshift surveys still ascend in the order they reach -- 2MASS
# shallowest and all-sky, then 6dF deeper over the southern sky, then 2dF
# deeper still -- but 2MASS and 6dF now share bandHigh. They cannot have a
# band each any more: 2MASS was asked to move up from bandMid, and with
# only bandHigh and treble at or above it, three bands for three surveys
# in depth order is arithmetically impossible. 2dF, the deepest, keeps
# treble to itself.

SIZE_SOURCE = "loudness"
# Deliberately small at rest. These are scatter plots of the universe and at
# their own scene sizes they crowd the view, so they sit at a quarter of it
# until the music does something. The swell from loudness is narrow; most of
# the range now comes from the band boost below, which is what makes them
# react to the playing rather than merely follow it.
SIZE_MIN = 0.35     # multiplier on the baseline ScaleFactor when the source is 0
SIZE_MAX = 0.7      # ...and when it is 1
SIZE_LAG = 0.25     # seconds, so a hard attack reads as a swell not a step

# The band boost: each group swells from its own register.
#
# Every band is a separate accumulator on the SuperCollider side -- a note
# pushes its band up to that note's velocity and it bleeds away, faster than
# `loudness` does. So a band measures playing IN THAT REGISTER rather than
# playing loudly anywhere, and tracks individual notes rather than smearing
# into a general level.
#
# It MULTIPLIES the loudness-driven size rather than replacing it, so the
# gesture reads on top of whatever the objects were already doing. The size
# reaction is deliberately restrained: at full tilt (1 + 1.6) = 2.6x on top
# of the 0.7x from loudness, so 1.8x the catalogue size against 0.35x when
# that register is silent -- about 5x from rest to peak, where an earlier
# version swung nearly 40x and read as strobing rather than as breathing.
# Opacity, which moves over the same band, carries the rest of the emphasis.
# ScaleFactor's range is 0..100, and the result is clamped so a big baseline
# cannot overshoot it.
TREBLE_BOOST = 1.6   # extra size multiplier when a group's band is 1
TREBLE_LAG = 0.07    # seconds. Much shorter than SIZE_LAG: this one is meant
                     #   to snap with the notes, not swell.
SIZE_CEILING = 95.0  # ScaleFactor's documented range tops out at 100

# Opacity is the second half of the reaction, and it is a different channel
# from Fade on purpose. OpenSpace describes Fade as the value "used by the
# system to be able to fade out objects independently from the Opacity value
# selected by the user", which is exactly the accrual ramp's job -- so Fade
# keeps saying whether a layer has been earned, and Opacity says how hard its
# register is being played. A group that has been earned but whose band is
# silent sits at OPACITY_MIN: present, faint, waiting.
OPACITY_MIN = 0.25
OPACITY_MAX = 1.0
OPACITY_EPS = 0.02   # dead-band, as for the other continuous properties

# OpenSpace's own on-screen text: the log, the version string and the camera
# readout. Not scene labels, so this is opt-in via --hide-screen-text.
SCREEN_TEXT = ["RenderEngine.ShowLog", "RenderEngine.ShowVersion",
               "RenderEngine.ShowCamera"]

# Continuous 0..1 OSC values mapped straight onto a numeric property.
# (osc name, candidate URIs in preference order, low, high)
# The first URI that actually matches something in the running scene wins; if
# none match, the mapping is skipped with a note.
#
# EMPTY ON PURPOSE. The field of view used to live here, driven by `spread`
# over 55-100 degrees, and it is deliberately no longer touched: the projection
# is the operator's setting, not the instrument's, and on a dome or a
# multi-window setup a performance quietly rewriting it is a nuisance rather
# than an effect. `spread` still drives the distance grid ladder -- thirteen
# layers -- so the keyboard span is mapped, just not to the lens.
#
# Do not put the FOV back without deciding what happens on a curved screen.
# Kept as the worked example because the pattern was not obvious: the property
# moved out of RenderEngine.HorizFieldOfView into a per-window group, so a
# mapping needs candidate URIs and a probe rather than one fixed name.
#
#   ("spread",
#    ["RenderEngine.Windowing.*.HorizFieldOfView",
#     "RenderEngine.HorizFieldOfView"],
#    55.0, 100.0),
SCALARS = []

# How long OpenSpace takes to swing the camera round when the focus changes.
# Its own description: "The time to interpolate the camera rotation when the
# anchor or aim node is changed, in seconds." Larger is slower.
#
# This is the transition the tour makes visible -- the camera turning to face
# the next body at the halfway handover -- so it is worth being able to set it
# with the rest of the calibration instead of only in a GUI session. But it is
# still a navigation preference, so the bridge leaves it alone unless
# --retarget-time says otherwise, and puts the original back on the way out.
RETARGET_URI = ("NavigationHandler.OrbitalNavigator."
                "RetargetAnchorInterpolationTime")

# Ten seconds by default: the focus handover is the most visible thing the tour
# does, and OpenSpace's own default swings the camera round faster than the
# music moves. This is the one navigation preference the bridge does set
# without being asked, which is only reasonable because it reads the original
# first and writes it back on exit. --retarget-time 0 restores OpenSpace's
# instant behaviour; the restore still happens either way.
RETARGET_TIME = 20.0

# Time speed: how fast AND how long you play decides how fast simulation time
# runs.
#
# Driven by `density` by default -- notes per second over the .scd's analysis
# window (~histWindow, 3 s), normalised so ~densityMax (12 notes/s) is 1.0.
# That is "how fast someone is playing" in the literal sense, independent of
# how hard: a fast pianissimo run speeds time up as much as a loud one.
#
# Two things combine on the 0..1 log-speed scale:
#   1. Instantaneous playing speed, boosted by TIME_GAIN and shaped by
#      TIME_CURVE (< 1 so even gentle playing produces immediate motion).
#   2. Cumulative playing duration (`time_build`, 0..1), which climbs over
#      TIME_BUILD_SECS of continuous playing (faster when you play rapidly) and
#      decays back to zero over TIME_DECAY_SECS when you stop. So the longer a
#      piece goes on, the higher both the baseline and peak time speed climb.
#
# The mapping is EXPONENTIAL between TIME_MIN and TIME_MAX, because the useful
# range spans five or six orders of magnitude.
#
# The value is the delta time in OpenSpace's own terms: simulated seconds per
# real second. The original is read at startup and restored on exit, the same
# promise the retarget time makes. --no-time leaves time alone entirely.
TIME_SOURCE = "density"
TIME_MIN = 1.0            # delta time when nobody is playing; must be > 0
TIME_MAX = 604800.0       # delta time when playing flat out (one week/s)
TIME_GAIN = 1.2           # sensitivity multiplier on the source
TIME_CURVE = 0.8          # exponent on the source (< 1 = more sensitive early)
TIME_BUILD_SECS = 60.0    # seconds of playing to build from initial to full
                          #   long-play boost (0 disables the gradual build-up)
TIME_BUILD_SHARE = 0.45   # how much of the log-speed range comes from playing
                          #   for longer vs instantaneous note speed
TIME_DECAY_SECS = 30.0    # seconds of silence for the long-play build to unwind
TIME_LAG_UP = 0.9         # seconds of smoothing when playing speeds up
TIME_LAG_DOWN = 6.0       # seconds of smoothing when fewer/no notes are playing
TIME_CHORD_WINDOW = 0.055 # notes arriving within 55 ms count as one chord onset
TIME_CHORD_WEIGHT = 0.12  # weight of extra notes in a chord vs sequential notes
TIME_ONSET_WINDOW = 3.0   # seconds over which individual note onsets are counted
TIME_ONSET_MAX = 12.0     # notes/s that counts as "flat out" (1.0)
TIME_EPS = 0.04           # resend only when the rate moved ~4% (log ratio)
TIME_EVERY = 0.20         # ...and at most this often, in seconds
TIME_INTERP = 0.45        # seconds OpenSpace takes to glide to each new rate

# Only resend a property when it has moved this far, so we do not push ten
# identical values into the script queue thirty times a second.
# Probing. OpenSpace accepts a socket connection before its scene graph has
# finished building, so the first probe can legitimately find nothing.
PROBE_TRIES = 4
PROBE_TIMEOUT = 20.0
PROBE_RETRY_WAIT = 4.0

LAYER_EPS = 0.004
SCALAR_EPS = 0.25

# Navigation gains.
#
# READ THIS BEFORE CHANGING THEM. OpenSpace's own documentation says "typically a
# range of [-1000, 1000] produces reasonable results" for truck movement and
# [-250, 250] for rotation. Those figures are for a SINGLE impulse, which is
# decelerated again immediately. We send a continuous stream, which settles at a
# steady velocity, and in that regime the velocities are per-second rates:
#
#   truck    -> a FRACTION OF THE CURRENT ALTITUDE per second, so holding
#               velocity v for one second multiplies your altitude by e^v.
#               (orbitalnavigator.cpp, translateVertically: the displacement is
#               `actualSurfaceToCamera * velocity * deltaTime`.)
#   rotation -> radians per second, times altitude/radius clamped to 1, so it
#               saturates once you are a body-radius up. (rotateAroundAnchorUp)
#   roll     -> radians per second, flat. (roll)
#
# Using the impulse-scale numbers here made a single note multiply the altitude
# by 1.6 million. For scale, Earth orbit out to the Tully galaxies is about 40
# e-folds of altitude in total.
#
# One more factor: we emit at 30 Hz into a renderer running at 60 fps, so half
# the frames have no pending impulse and decelerate instead. The velocity
# actually reached is therefore about HALF the value we send. The numbers below
# are the sent values; the effective rate is half of each.
# Flat-out playing covers ~0.93 e-folds of altitude per second, so roughly 43 s
# to cross from low Earth orbit to the Tully galaxies (about 40 e-folds), and
# ~10 s to reach the Sun. One mf note drifts out by ~10%. Purely a matter of
# taste -- raise it for a shorter, steeper piece:
#
#     gain   one mf note   flat out    cross everything
#     4.0        x1.21      1.87/s          22 s
#     3.0        x1.15      1.40/s          29 s
#     2.0        x1.10      0.93/s          43 s   <- current
#     1.5        x1.07      0.70/s          57 s
#     1.0        x1.05      0.47/s          86 s
TRUCK_GAIN = 2.0       # zoomSpeed -> pull away from the focus node
ELEVATION_GAIN = 0.5   # centroid  -> ~0.25 rad/s maximum, about 14 deg/s
ROLL_GAIN = 0.25       # tension   -> ~0.12 rad/s peak, about 7 deg/s
ROLL_HZ = 0.07         # ...oscillated this slowly, so it does not just spin
NOTE_KICK = 0.0        # per-note-on rotation jitter; 0 = off (can be nauseating)

# Slow mode rotation limits (--slow or SLOW_MODE = True):
SLOW_ELEVATION_GAIN = 0.08  # ~2 deg/s max orbital pitch rotation
SLOW_ROLL_GAIN = 0.03       # < 1 deg/s subtle roll
SLOW_RETARGET_TIME = 40.0   # 40 s gentle turn when switching focus between bodies
SLOW_ORBIT_RATE = 0.005     # 4x slower orbit around a locked focus
SLOW_MAX_ROT = 0.06         # hard per-tick cap on rotation velocity

# The tour.
#
# The camera never uses flyTo. It only ever does two things: change focus, and
# zoom, at whatever speed the music asks for. The itinerary is a state machine
# driven by the camera's actual distance to its focus:
#
#   out  focused on body i, zooming AWAY. When the distance from body i reaches
#        half the separation between body i and body i+1, focus hands over to
#        body i+1 and the phase flips to "in" -- so the camera keeps travelling
#        the same way, but is now approaching rather than receding.
#   in   focused on body i, zooming TOWARDS it. On reaching ARRIVE[i], the phase
#        flips back to "out" and the next leg begins.
#   final after Pluto, focus moves to the Sun and the camera simply zooms out
#        for as long as the playing lasts.
#
# Note this is a DISTANCE rule, not a direction: truck movement recedes radially
# from the focus, which is not generally towards the next body, so the path is a
# dogleg -- out to the halfway radius, then turn and dive in. That is what makes
# the focus handover legible: the camera visibly turns to face the new body
# (setFocus retargets by default).
TOUR = [
    "Earth", "Moon", "Mercury", "Venus", "Mars",
    "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto",
]
TOUR_FINAL = "Sun"      # after Pluto: focus here and keep zooming out

# Distance from the body's CENTRE, in metres, that counts as having reached it.
# Roughly three radii, which frames the body. Earth needs none: the piece starts
# there already, zooming out.
ARRIVE = {
    "Sun":     2.1e9,
    "Earth":   1.9e7,
    "Moon":    5.0e6,
    "Mercury": 7.0e6,
    "Venus":   1.8e7,
    "Mars":    1.0e7,
    "Jupiter": 2.1e8,
    "Saturn":  1.8e8,
    "Uranus":  7.5e7,
    "Neptune": 7.5e7,
    "Pluto":   3.5e6,
}

# The bass note chooses the destination.
#
# Pitch class -> destination. The chromatic scale is a journey outward from the
# Sun, so it is learnable rather than arbitrary:
#
#   C  Sun        E  Earth      G#  Uranus
#   C# Mercury    F  Mars       A   Neptune
#   D  Venus      F# Jupiter    A#  Pluto
#   D# Moon       G  Saturn     B   outward, without end
#
# So playing an F, or any chord rooted on F, sends the camera to Mars. Only the
# pitch class matters, so the octave is free -- and because it is read from the
# LOWEST held note, a chord in root position selects its root. (An inversion
# selects its bass, not its theoretical root: that is what "the note played by
# the left hand" means, and it is the behaviour that is playable.)
#
# B is not a body. It focuses the Sun and then just keeps receding, out through
# the solar system and past it for as long as the playing lasts -- the same
# state the itinerary reaches after its last stop. Kept as a sentinel rather
# than a node name so it can never be probed for or flown to.
OUTWARD = "(outward)"

PITCH_BODY = {
    0: "Sun", 1: "Mercury", 2: "Venus", 3: "Moon", 4: "Earth", 5: "Mars",
    6: "Jupiter", 7: "Saturn", 8: "Uranus", 9: "Neptune", 10: "Pluto",
    11: OUTWARD,
}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Only notes at or below this count as the bass, so a right-hand melody cannot
# steer. Middle C is 60; the default of 59 is the B below it.
BASS_SPLIT = 35

# How long a bass note has to be the lowest held before it takes effect. Stops
# a passing note in a walking bass line from yanking the destination, while
# still feeling immediate when you mean it.
BASS_HOLD = 0.35

# How long a DIFFERENT destination has to be held to abandon a dive that is
# already under way. Longer than BASS_HOLD, because interrupting a dive is a
# bigger decision than choosing where to go in the first place -- but it has to
# be possible at all, or naming a body and then not playing hard enough to
# reach it leaves bass steering permanently unresponsive.
BASS_REDIRECT = 1.0

# --- Holding one body: the focus lock ---------------------------------------
#
# The itinerary is the instrument's default behaviour, and a scored piece can
# want the opposite of it. "Fly Me to the Moon" wants the Moon, for the whole
# song, with nothing able to take the camera anywhere else.
#
# So this is a MODE, not a destination. While a lock is engaged `tour_step`
# is not called at all, and every way the camera can change focus lives
# inside it -- the itinerary's halfway handovers, bass steering, and the
# outward sentinel. Suppressing the method is therefore the difference
# between focus changes being impossible and being unlikely.
#
# It also holds the truck still (`lock_step` returns 0) and suppresses the
# music-driven rotation, roll and note kick, because a smooth orbit and a
# camera that jitters on every note are not the same request. The layers,
# sizes and opacity keep reacting: what is held is the camera, not the scene.
FOCUS_LOCK_NODE = "Moon"   # what a bare "lock on" from the .scd means
# How fast a locked body is orbited, as a per-tick addGlobalRotation. Small:
# at TICK this is a little over a degree a second, so a three-minute song is
# most of one revolution. Negative orbits the other way.
ORBIT_RATE = 0.02
# Closing the gap. Truck movement is fractional -- holding velocity v for
# a second multiplies the altitude by e^v -- so the distance to cover is
# ln(now / wanted) e-folds and the rate is chosen to spend it over
# LOCK_APPROACH seconds. From Earth to the Moon's framing distance is
# about 4 e-folds, so this is a slow, deliberate fall rather than a jump.
LOCK_APPROACH = 20.0   # seconds to close the gap once the lock engages
LOCK_EASE = 0.5        # e-folds over which it eases off, so it settles
# ...and because that ease-off is proportional to what is left, the
# distance approaches the target asymptotically and never crosses it.
# So arrival is a tolerance rather than an inequality: 0.05 e-folds is
# within about 5% of the framing distance, which is indistinguishable
# on screen. Testing `distance <= target` instead means the orbit
# never starts at all.
LOCK_ARRIVED_GAP = 0.05
LOCK_RATE_MAX = 3.0    # cap, as for the drift home

TOUR_MIDPOINT = 0.5    # fraction of the separation at which focus hands over
TOUR_DWELL = 1.5       # minimum seconds between transitions, as a thrash guard
TELEMETRY_EVERY = 0.12 # seconds between distance queries to OpenSpace
TELEMETRY_TIMEOUT = 2.0

# Energy below which the camera is left completely alone. `energy` decays with a
# time constant of about a third of a second, so this is reached roughly a second
# and a half after the last note.
IDLE_FLOOR = 0.01

# Drifting back. During silence the camera falls gently back the way it came, by
# feeding truck movement the other way (positive = towards the focus node).
#
# The drift knows when to stop because the bridge integrates its own commanded
# displacement: `net_efolds` is how far out we have driven the camera, in e-folds
# of altitude, and the drift runs only while that is still positive. So it
# returns to where the playing started and settles there, without ever needing
# to ask OpenSpace where the camera is.
# The parameter is the RETURN TIME, not a rate. A fixed rate does not work here:
# because zoom is exponential, six seconds of hard playing already spends about
# ten e-folds, and a gentle fixed rate would need forty seconds to undo it while
# a small excursion would come back almost instantly. Instead, when the drift
# starts we look at how far out we are and pick the rate that covers it in
# DRIFT_TIME seconds -- so silence always takes about the same time to bring you
# home, wherever you are.
DRIFT_TIME = 20.0      # seconds to drift back from wherever you got to, plus a
                       #   ~2 s settle at the end
DRIFT_MAX = 3.0        # cap on the sent rate, so a 40 e-fold trip cannot come
                       #   home at a jarring speed (~1.5 e-folds/s effective)
DRIFT_AFTER = 2.0      # extra seconds below IDLE_FLOOR before the drift starts,
                       #   on top of the ~1.5 s it takes energy to decay there
DRIFT_EASE = 0.5       # e-folds over which the drift eases off, so it settles
                       #   smoothly instead of stopping dead. Kept short because
                       #   the tail is an exponential approach and a long one
                       #   would make the return overshoot DRIFT_TIME noticeably
                       #   (1.5 here turned a 15 s return into 20 s).
DRIFT_DEADBAND = 0.05  # close enough to home; stop

# The velocity actually reached is about half the value we send (30 Hz of
# impulses into a 60 fps renderer -- see the note on the gains above). Used to
# keep the net_efolds estimate honest.
DUTY = 0.5


# ---------------------------------------------------------------------
# OSC decoding (receive only -- messages and bundles, the types sclang sends)
# ---------------------------------------------------------------------

def _read_string(buf: bytes, i: int) -> tuple[str, int]:
    end = buf.index(b"\x00", i)
    s = buf[i:end].decode("utf-8", "replace")
    return s, i + (((end - i) // 4) + 1) * 4


def _read_blob(buf: bytes, i: int) -> tuple[bytes, int]:
    (n,) = struct.unpack_from(">i", buf, i)
    i += 4
    return buf[i:i + n], i + ((n + 3) // 4) * 4


def _decode_message(buf: bytes) -> tuple[str, list]:
    addr, i = _read_string(buf, 0)
    args: list = []
    if i >= len(buf):
        return addr, args
    tags, i = _read_string(buf, i)
    for tag in tags.lstrip(","):
        if tag == "i":
            args.append(struct.unpack_from(">i", buf, i)[0])
            i += 4
        elif tag == "f":
            args.append(struct.unpack_from(">f", buf, i)[0])
            i += 4
        elif tag == "h":
            args.append(struct.unpack_from(">q", buf, i)[0])
            i += 8
        elif tag == "d":
            args.append(struct.unpack_from(">d", buf, i)[0])
            i += 8
        elif tag in ("s", "S"):
            v, i = _read_string(buf, i)
            args.append(v)
        elif tag == "b":
            v, i = _read_blob(buf, i)
            args.append(v)
        elif tag == "T":
            args.append(True)
        elif tag == "F":
            args.append(False)
        elif tag in ("N", "I"):
            args.append(None)
        else:
            # Unknown type tag: the rest of the argument block is unparseable.
            break
    return addr, args


def decode_packet(buf: bytes) -> list[tuple[str, list]]:
    """Flatten an OSC packet into a list of (address, args)."""
    if buf.startswith(b"#bundle"):
        out: list[tuple[str, list]] = []
        i = 16  # "#bundle\0" plus an 8-byte time tag
        while i < len(buf):
            (n,) = struct.unpack_from(">i", buf, i)
            i += 4
            out.extend(decode_packet(buf[i:i + n]))
            i += n
        return out
    if not buf:
        return []
    try:
        return [_decode_message(buf)]
    except (ValueError, struct.error):
        return []


# ---------------------------------------------------------------------
# OpenSpace socket link
# ---------------------------------------------------------------------

def _all_numbers(obj, acc=None):
    """Numbers out of a script-engine reply, in key order. Multiple Lua return
    values arrive as an array-dictionary ({"1": a, "2": b})."""
    if acc is None:
        acc = []
    if isinstance(obj, bool):
        return acc
    if isinstance(obj, (int, float)):
        acc.append(float(obj))
    elif isinstance(obj, dict):
        for k in sorted(obj.keys(), key=lambda x: (len(str(x)), str(x))):
            _all_numbers(obj[k], acc)
    elif isinstance(obj, list):
        for v in obj:
            _all_numbers(v, acc)
    return acc


def _first_number(obj):
    """The script engine returns an array-dictionary ({"1": v, ...}); dig out
    the first number rather than depending on that shape."""
    if isinstance(obj, bool):
        return None
    if isinstance(obj, (int, float)):
        return obj
    if isinstance(obj, dict):
        for v in obj.values():
            n = _first_number(v)
            if n is not None:
                return n
    if isinstance(obj, list):
        for v in obj:
            n = _first_number(v)
            if n is not None:
                return n
    return None


class OpenSpaceLink:
    """Newline-delimited JSON over TCP to OpenSpace's socket interface."""

    def __init__(self, host: str, port: int, dry_run: bool = False):
        self.host = host
        self.port = port
        self.dry_run = dry_run
        self.sock: socket.socket | None = None
        self.rx = b""
        self.sent = 0
        self._ids = itertools.count(1)

    @property
    def connected(self) -> bool:
        return self.dry_run or self.sock is not None

    def connect(self) -> bool:
        if self.dry_run:
            return True
        try:
            s = socket.create_connection((self.host, self.port), timeout=2.0)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            s.setblocking(False)
            self.sock = s
            self.rx = b""
            # OpenSpace 0.22+ requires an API v1.0.0 handshake before any topic
            # messages are accepted (otherwise Connection::handleJson rejects
            # every message with "Unsupported API version").
            return self._send_raw({
                "type": "apiHandshake",
                "apiVersion": {"major": 1, "minor": 0, "patch": 0},
            })
        except OSError:
            self.sock = None
            return False

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _send_raw(self, msg: dict) -> bool:
        line = json.dumps(msg, separators=(",", ":")).encode() + b"\n"
        if self.dry_run:
            self.sent += 1
            return True
        if self.sock is None:
            return False
        try:
            self.sock.sendall(line)
            self.sent += 1
            return True
        except OSError:
            self.close()
            return False

    def lua(self, script: str, synchronized: bool = True) -> bool:
        """Fire-and-forget Lua. Every message carries `type`, because a
        no-return luascript topic reports isDone() immediately and so is never
        retained by the connection."""
        return self._send_raw({
            "topic": next(self._ids),
            "type": "luascript",
            "payload": {
                "script": script,
                "return": False,
                "shouldBeSynchronized": synchronized,
            },
        })

    def ask(self, script: str, timeout: float = 5.0, want: int = 1):
        """Run Lua and wait for its return value. Startup probing only.
        With want > 1, returns the list of numbers instead of the first."""
        if self.dry_run or self.sock is None:
            return None
        topic = next(self._ids)
        ok = self._send_raw({
            "topic": topic,
            "type": "luascript",
            "payload": {
                "script": script,
                "return": True,
                "shouldBeSynchronized": False,
            },
        })
        if not ok:
            return None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.sock is None:
                return None
            try:
                chunk = self.sock.recv(65536)
            except (BlockingIOError, InterruptedError):
                time.sleep(0.01)
                continue
            except OSError:
                self.close()
                return None
            if not chunk:
                self.close()
                return None
            self.rx += chunk
            while b"\n" in self.rx:
                line, self.rx = self.rx.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("topic") == topic:
                    if want > 1:
                        return _all_numbers(msg.get("payload"))
                    return _first_number(msg.get("payload"))
        return None

    def drain(self):
        """Read whatever OpenSpace has sent without blocking, and return any
        complete replies as a list of (topic, payload). Must be called every
        tick regardless: if nothing reads the socket its buffer fills up and
        our own writes eventually stall."""
        out = []
        if self.dry_run or self.sock is None:
            return out
        try:
            while True:
                chunk = self.sock.recv(65536)
                if not chunk:
                    self.close()
                    return out
                self.rx += chunk
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            self.close()
            return out
        while b"\n" in self.rx:
            line, self.rx = self.rx.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            out.append((msg.get("topic"), msg.get("payload")))
        return out

    def request(self, script: str):
        """Fire off a Lua query and return its topic id; the reply arrives via
        drain(). Returns None if it could not be sent."""
        if self.dry_run or self.sock is None:
            return None
        topic = next(self._ids)
        ok = self._send_raw({
            "topic": topic,
            "type": "luascript",
            "payload": {"script": script, "return": True,
                        "shouldBeSynchronized": False},
        })
        return topic if ok else None


# ---------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------

def smoothstep(x: float, a: float, b: float) -> float:
    """The same curve the .scd used for layers, so nothing pops into existence."""
    if b <= a:
        return 1.0 if x >= b else 0.0
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def _si(m: float) -> str:
    """Distances in the readout, in units a person can picture.

    Goes all the way up because B (outward) is unbounded: without the larger
    units the readout printed things like "2997300560077.92 AU"."""
    au = 1.495978707e11
    ly = 9.4607e15
    if m >= 1e6 * ly:
        return f"{m / (1e6 * ly):.2f} Mly"
    if m >= 1e3 * ly:
        return f"{m / (1e3 * ly):.2f} kly"
    if m >= 0.5 * ly:
        return f"{m / ly:.2f} ly"
    if m >= 0.05 * au:
        return f"{m / au:.2f} AU"
    if m >= 1e6:
        return f"{m / 1e6:.0f} Mm"
    return f"{m / 1e3:.0f} km"


def _rate(d: float) -> str:
    """A delta time (simulated seconds per real second) for the readout."""
    a = abs(d)
    for unit, s in (("y/s", 31557600.0), ("d/s", 86400.0),
                    ("h/s", 3600.0), ("min/s", 60.0)):
        if a >= s:
            return f"{d / s:.1f} {unit}"
    return f"x{d:.3g}"


def lua_num(v: float) -> str:
    if not math.isfinite(v):
        v = 0.0
    return f"{v:.5g}"


class Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.link = OpenSpaceLink(args.os_host, args.os_port, args.dry_run)

        self.values: dict[str, float] = {}
        self.layers: dict[str, float] = {}
        self.notes: list[tuple[int, float]] = []
        self.unknown: set[str] = set()

        self.layer_uri = {n: uri for n, uri, _r, _c in LAYERS}
        self.layer_live = {n: True for n, _uri, _r, _c in LAYERS}
        self.layer_enabled: dict[str, bool] = {}

        # Sustain: layers accumulate while you keep playing rather than
        # tracking the derived values instant by instant.
        self.progress = 0.0          # in layers; one whole unit = one more layer
        self.unlocked: list[str] = []  # activated, in the order they came on
        self.ramp: dict[str, float] = {}  # 0..1 linear fade position per layer
        self.stopped_at: float | None = None

        # Point sizes: baseline ScaleFactor per layer, read from the scene at
        # startup so we modulate around whatever the asset actually set.
        self.size_base: dict[str, float] = {}
        self.size_val = 0.0
        # one lagged value per register band, not a single treble one
        self.band_val = {b: 0.0 for b in set(BAND_OF.values())}
        self.last_opacity: dict[str, str] = {}
        self.last_size: dict[str, str] = {}
        self.scalar_uri: dict[str, str] = {}
        # the value OpenSpace had before we changed it, to hand back
        self.retarget_was: float | None = None
        # Time speed. `time_was` is OpenSpace's delta time before we touched
        # it, to hand back on exit; `time_rate` is the last value we sent.
        self.time_live = False
        self.time_was: float | None = None
        self.time_val = 0.0
        self.time_build = 0.0        # 0..1 long-play accumulator
        self.time_onsets: list[tuple[float, float]] = []  # (timestamp, weight)
        self.time_last_onset = -100.0
        self.time_seen_notes = False
        self.time_rate: float | None = None
        self.time_sent_at = 0.0
        self.scalar_range: dict[str, tuple[float, float]] = {}

        # name -> (float value, serialised text) of the last Fade written
        self.last_layer: dict[str, tuple[float, str]] = {}
        self.last_scalar: dict[str, float] = {}

        self.osc_msgs = 0
        self.last_osc = 0.0
        self.t0 = time.monotonic()

        # None until the first note, so the drift home can never run before
        # anything has been played. See emit().
        self.last_active: float | None = None
        self.drifting = False
        self.drift_rate = 0.0
        # Tour state.
        self.tour_stops = list(TOUR)
        # Where we are and where we are going, by name. Not indices: the bass
        # note can send us to a body that is not on the fallback itinerary at
        # all, so an index into TOUR is not enough to describe the state.
        self.current = TOUR[0]
        self.target: str | None = None
        self.phase = "out"           # "out" | "in" | "final"
        self.bodies: set[str] = set()   # everything reachable, filled by probe

        # Focus lock. `lock_want` is written by the OSC thread and read by
        # the emit loop, which is the only place that may talk to
        # OpenSpace -- so engaging is deferred by one tick rather than
        # sending Lua from a receive callback.
        # --lock-focus engages before the first tick, so a run started with
        # it never shows the itinerary at all.
        self.lock_want: str | None = getattr(args, "lock_focus", None) or None
        self.lock_node: str | None = None
        self.lock_since = 0.0
        self.lock_arrived = False
        self.lock_dist: float | None = None   # metres to close to
        self.lock_rate: float | None = None   # e-folds/s, set on the
                                              #   first fresh reading
        self.lock_missing: set[str] = set()

        # Bass steering.
        self.bass_pc: int | None = None      # debounced pitch class, or None
        self.bass_raw: int | None = None     # what the last message said
        self.bass_since = 0.0
        self.bass_high: int | None = None    # note seen above the split
        self.redirect_to: str | None = None
        self.redirect_since = 0.0
        self.blocked = ""                    # why steering is not acting, for the readout
        self.tour_started = False    # has focus been set to Earth yet
        self.tour_last_change = 0.0

        # Telemetry from OpenSpace: the tour needs the camera's real distance to
        # its focus, which only OpenSpace knows. Requests are fired off and
        # collected asynchronously in drain(); blocking for a reply inside a
        # 30 Hz loop would stall OSC handling.
        self.tel_dist = None         # metres, camera to focus centre
        self.tel_sep = None          # metres, current body to the next
        self.tel_sep_for = None      # the (from, to) pair tel_sep belongs to
        self.tel_sep_pending = None  # ...and the pair currently being asked
        self.tel_topic = None        # outstanding request, or None
        self.tel_sent = 0.0
        self.tel_stale = True        # invalidated on every focus change
        self.last_emit: float | None = None
        # How far out we have driven the camera, in e-folds of altitude. Our own
        # integral of our own commands -- the drift home spends it back down.
        self.net_efolds = 0.0

        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.udp.bind((args.osc_host, args.osc_port))

    # -- startup probing ------------------------------------------------

    def probe(self) -> None:
        """Ask the running scene which of our targets actually exist. The
        default profile does not load the digitaluniverse assets, so most of the
        deep-space layers are legitimately absent -- better to say so once at
        startup than to fire thousands of failing scripts at OpenSpace."""
        if self.args.dry_run or self.args.no_probe:
            for osc_name, uris, lo, hi in SCALARS:
                self.scalar_uri[osc_name] = uris[0]
                self.scalar_range[osc_name] = (lo, hi)
            # Nothing to read the original from, so nothing will be restored;
            # but the dry run should still show the time scripts.
            self.time_live = self.args.time
            return

        if not self.args.layers:
            for name, _uri, _r, _c in LAYERS:
                self.layer_live[name] = False
            print("layers disabled -- leaving scene renderables as they are")
            if not self.args.keep_labels:
                self.hide_text()
            if self.args.camera and self.args.retarget_time is not None:
                self.set_retarget(self.args.retarget_time)
            if self.args.time:
                self.setup_time()
            if not self.args.camera:
                print("camera movement disabled")
                self.tour_stops = []
                return
        else:
            # One round trip for the whole table. At seventy-odd layers, asking
            # individually took long enough that anything played during startup was
            # lost -- the bridge is not in its emit loop while probing.
            #
            # pcall around each lookup so one awkward URI cannot kill the whole
            # batch: a URI that raises is simply reported as absent. Without it a
            # single bad entry loses all seventy answers at once.
            SQ = chr(39)
            uris = ",".join(SQ + uri + ".Fade" + SQ for _n, uri, _r, _c in LAYERS)
            script = ("local u={" + uris + "} local r={} "
                      "for i,v in ipairs(u) do "
                      "local ok,n = pcall(function() return #openspace.property(v) end) "
                      "r[i] = (ok and n) or 0 end return r")

            # Retry: OpenSpace accepts the socket before its scene graph is
            # finished, so an early probe legitimately finds nothing. An all-zero
            # answer means "not ready yet", not "empty scene" -- no real profile
            # has none of these nodes.
            counts = None
            for attempt in range(1, PROBE_TRIES + 1):
                counts = self.link.ask(script, timeout=PROBE_TIMEOUT,
                                       want=len(LAYERS))
                good = (counts is not None and len(counts) >= len(LAYERS)
                        and any(c > 0 for c in counts))
                if good:
                    break
                if attempt < PROBE_TRIES:
                    why = ("no answer" if counts is None
                           else "nothing in the scene yet")
                    print(f"layer probe attempt {attempt}: {why} -- "
                          f"is OpenSpace still loading? retrying in "
                          f"{PROBE_RETRY_WAIT:g}s")
                    time.sleep(PROBE_RETRY_WAIT)
                counts = None

            if counts is None:
                # Never assume the layers are there. Writing to a URI that does not
                # exist makes OpenSpace log "No property matched the requested URI"
                # for every write, every tick -- which is what an earlier version of
                # this fallback did.
                for name, _uri, _r, _c in LAYERS:
                    self.layer_live[name] = False
                print("!! layer probe failed -- ALL LAYERS DISABLED rather than "
                      "written to blindly.")
                print("   Let OpenSpace finish loading its scene, then restart "
                      "the bridge.")
            else:
                missing = []
                for (name, _uri, _r, _c), n in zip(LAYERS, counts):
                    self.layer_live[name] = n > 0
                    if n == 0:
                        missing.append(name)
                if missing:
                    print(f"{len(LAYERS) - len(missing)}/{len(LAYERS)} layers live; "
                          f"not in this scene: {', '.join(missing)}")
                else:
                    print(f"all {len(LAYERS)} layers live")

            if not self.args.keep_labels:
                self.hide_text()
            if not self.args.no_sizes:
                self.read_size_baselines()
            if self.args.camera and self.args.retarget_time is not None:
                self.set_retarget(self.args.retarget_time)
            if self.args.time:
                self.setup_time()

        if not self.args.camera:
            print("camera movement disabled")
            self.tour_stops = []
            return

        for osc_name, uris, lo, hi in SCALARS:
            for uri in uris:
                n = self.link.ask(f"return #openspace.property({uri!r})")
                if n and n > 0:
                    self.scalar_uri[osc_name] = uri
                    self.scalar_range[osc_name] = (lo, hi)
                    break
            else:
                print(f"no property found for '{osc_name}' -- mapping skipped")

        # Tour bodies: setFocus and worldPosition both raise a Lua error for an
        # unknown node, so drop any body this scene does not have. The Sun is
        # checked too, since the final leg focuses it. Skipped entirely with
        # --no-tour: eleven round trips for something that will never run.
        if not self.args.tour:
            self.tour_stops = []
            return
        # Every body the bass note can select, plus the fallback itinerary and
        # the Sun. One batched round trip.
        wanted = [n for n in dict.fromkeys(
            list(PITCH_BODY.values()) + self.tour_stops + [TOUR_FINAL])
            if n != OUTWARD]
        SQB = chr(39)
        counts = self.link.ask(
            "local u={" + ",".join(SQB + n + SQB for n in wanted) + "} "
            "local r={} for i,v in ipairs(u) do "
            "r[i]=openspace.hasSceneGraphNode(v) and 1 or 0 end return r",
            timeout=15.0, want=len(wanted))
        if counts is None or len(counts) < len(wanted):
            print("could not probe the tour bodies -- assuming all present")
            self.bodies = set(wanted)
        else:
            self.bodies = {n for n, c in zip(wanted, counts) if c > 0}
            dropped = [n for n in wanted if n not in self.bodies]
            if dropped:
                print(f"tour: {', '.join(dropped)} not in this scene, skipped")
        live_stops = [n for n in self.tour_stops if n in self.bodies]
        self.tour_stops = live_stops
        missing_arrive = [n for n in self.tour_stops[1:] if n not in ARRIVE]
        if missing_arrive:
            print(f"tour: no ARRIVE distance for {', '.join(missing_arrive)}"
                  f" -- they would be skipped through instantly")
        if self.tour_stops:
            print("tour: " + " -> ".join(self.tour_stops)
                  + f" -> {TOUR_FINAL} (outward) -- the fallback when nothing "
                  f"is steering")
        if self.args.bass:
            live = [f"{NOTE_NAMES[pc]}="
                    + ("outward" if b == OUTWARD else b)
                    for pc, b in sorted(PITCH_BODY.items())
                    if b == OUTWARD or b in self.bodies]
            print(f"bass note steers to: {'  '.join(live)}")
            print(f"  (lowest held note at or below "
                  f"{NOTE_NAMES[self.args.bass_split % 12]}"
                  f"{self.args.bass_split // 12 - 1}, "
                  f"held for {BASS_HOLD}s)")

    def read_size_baselines(self) -> None:
        """Read each sized layer's current Sizing.ScaleFactor.

        Modulating around the value the scene actually has, rather than assuming
        the default of 1, means an asset that sets its own point size keeps its
        proportions. propertyValue logs an LERROR for a URI it cannot find, so
        the existence check is done in the same Lua loop and -1 marks absent."""
        names = [n for n in SIZED if self.layer_live.get(n, False)]
        if not names:
            return
        SQ = chr(39)
        uris = [self.layer_uri[n] + ".Sizing.ScaleFactor" for n in names]
        vals = self.link.ask(
            "local u={" + ",".join(SQ + u + SQ for u in uris) + "} local r={} "
            "for i,v in ipairs(u) do "
            "if #openspace.property(v)>0 then r[i]=openspace.propertyValue(v) "
            "else r[i]=-1 end end return r",
            timeout=15.0, want=len(uris))
        if vals is None or len(vals) < len(uris):
            print("could not read point-size baselines -- sizes left alone")
            return
        for name, v in zip(names, vals):
            if v >= 0.0:
                self.size_base[name] = v if v > 0.0 else 1.0
        # Opacity is a separate property and not every renderable has one,
        # so it is probed rather than assumed -- writing an absent URI is an
        # LERROR on every tick.
        ouris = [self.layer_uri[n] + ".Opacity" for n in names]
        ohave = self.link.ask(
            "local u={" + ",".join(SQ + u + SQ for u in ouris) + "} local r={} "
            "for i,v in ipairs(u) do r[i]=#openspace.property(v) end return r",
            timeout=15.0, want=len(ouris))
        if ohave is not None and len(ohave) >= len(ouris):
            self.opacity_live = {n for n, k in zip(names, ohave) if k and k > 0}
        else:
            self.opacity_live = set()
            print("could not probe point opacity -- opacity left alone")

        missing = [n for n in names if n not in self.size_base]
        print(f"point sizes breathing on {len(self.size_base)} layers, "
              f"driven by {self.args.size_source}")
        print(f"  opacity reacting on {len(self.opacity_live)} of them")
        bands = {}
        for n in self.size_base:
            bands.setdefault(BAND_OF.get(n, "treble"), []).append(n)
        for b in ("bandLow", "bandMid", "bandHigh", "treble"):
            if bands.get(b):
                print(f"  {b:<9} {len(bands[b])}: {', '.join(sorted(bands[b]))}")
        if self.args.treble_boost:
            print(f"  a group's own register multiplies that by up to "
                  f"{1.0 + self.args.treble_boost:.1f}x")
        if missing:
            print(f"  no Sizing property, size left alone: {', '.join(missing)}")

    def set_retarget(self, seconds: float) -> None:
        """Set how long the camera takes to rotate onto a new focus, keeping the
        old value so it can be handed back on exit.

        Probed first like everything else: writing a URI the running build does
        not have makes OpenSpace log an LERROR. This one is registered in C++
        so it should always be there, but "should" is what the probe is for."""
        n = self.link.ask(f"return #openspace.property({RETARGET_URI!r})")
        if not n or n <= 0:
            print(f"no {RETARGET_URI.rsplit('.', 1)[-1]} in this build -- "
                  f"--retarget-time ignored")
            return
        was = self.link.ask(f"return openspace.propertyValue({RETARGET_URI!r})")
        if isinstance(was, (int, float)):
            self.retarget_was = float(was)
        self.link.lua("openspace.setPropertyValue("
                      + _lua_str(RETARGET_URI) + "," + lua_num(seconds) + ")")
        prev = (f"{self.retarget_was:g}s" if self.retarget_was is not None
                else "unknown")
        print(f"focus retarget time {prev} -> {seconds:g}s "
              f"(restored on exit)")

    def setup_time(self) -> None:
        """Read OpenSpace's current delta time so it can be handed back on
        exit, and check that time is not paused -- a paused clock ignores
        delta time completely, and the mapping would look broken.

        pcall-wrapped: a build without these functions answers with a string
        rather than raising, so the bridge disables the feature instead of
        stalling on a reply that never comes."""
        was = self.link.ask(
            "local ok,d = pcall(openspace.time.deltaTime) "
            "if ok then return d else return 'none' end")
        if not isinstance(was, (int, float)):
            print("could not read openspace.time.deltaTime -- "
                  "time speed left alone")
            return
        self.time_was = float(was)
        self.time_live = True
        print(f"time speed driven by {self.args.time_source}: "
              f"{_rate(self.args.time_min)} at rest -> "
              f"{_rate(self.args.time_max)} flat out "
              f"(was {_rate(self.time_was)}, restored on exit)")
        paused = self.link.ask(
            "local ok,p = pcall(openspace.time.isPaused) "
            "return (ok and p) and 1 or 0")
        if paused:
            print("  !! simulation time is PAUSED in OpenSpace -- the speed "
                  "will change but nothing will move until it is unpaused")

    def note_density(self, now: float) -> float:
        """Rate of sequential note onsets (0..1), where simultaneous keys in a
        chord (within TIME_CHORD_WINDOW) count mostly as a single onset rather
        than N separate notes."""
        cutoff = now - TIME_ONSET_WINDOW
        while self.time_onsets and self.time_onsets[0][0] < cutoff:
            self.time_onsets.pop(0)
        if self.time_seen_notes:
            total = sum(w for _, w in self.time_onsets)
            return min(1.0, max(0.0, total / TIME_ONSET_WINDOW / TIME_ONSET_MAX))
        # Fallback if /piano/note messages are not arriving: discount density
        # when polyphony (held chord size) is high.
        d = self.source(self.args.time_source)
        poly = self.source("polyphony")
        return d / (1.0 + 1.8 * poly)

    def time_step(self, now: float, dt: float) -> str | None:
        """The Lua to set the new time speed, or None if it has not moved
        enough to be worth sending."""
        raw = (self.note_density(now)
               if self.args.time_source == "density"
               else self.source(self.args.time_source))
        target = min(1.0, raw * self.args.time_gain)
        # Asymmetric smoothing: climb quickly when notes arrive, coast down
        # slowly when playing thins out or stops.
        lag = TIME_LAG_UP if target >= self.time_val else TIME_LAG_DOWN
        self.time_val += (target - self.time_val) * min(1.0, dt / max(0.05, lag))
        fast = min(1.0, max(0.0, self.time_val)) ** self.args.time_curve

        # Long-play build: while playing, `time_build` climbs steadily from 0
        # to 1 over --time-build seconds (and up to ~1.8x faster during rapid
        # passages). During silence it unwinds slowly over --time-decay seconds
        # so time coasts gently back to real-time when nobody is playing.
        playing = (self.values.get("energy", 0.0) >= self.args.idle_floor
                   or raw > 0.01)
        if self.args.time_build > 0:
            if playing:
                pace = 0.6 + 1.2 * target
                self.time_build = min(
                    1.0, self.time_build + (dt / self.args.time_build) * pace)
            else:
                self.time_build = max(
                    0.0, self.time_build - dt / max(0.1, self.args.time_decay))
            share = TIME_BUILD_SHARE
            b = self.time_build
            # The build both lifts the baseline speed and unlocks the upper
            # part of the range, and unwinds smoothly when playing stops.
            x = min(1.0, fast * ((1.0 - share) + share * b) + share * b)
        else:
            x = fast

        lo, hi = self.args.time_min, self.args.time_max
        # The lag only approaches zero, so snap the tail: silence has to land
        # on exactly TIME_MIN, not on a hair above it for ever.
        rate = lo if x < 1e-3 else lo * (hi / lo) ** x

        last = self.time_rate
        if last is not None:
            if now - self.time_sent_at < TIME_EVERY:
                return None
            settling = rate == lo and last != lo
            if not settling and abs(math.log(rate / last)) < TIME_EPS:
                return None
        self.time_rate = rate
        self.time_sent_at = now
        # interpolateDeltaTime rather than setDeltaTime: each step glides
        # instead of jumping, and a new call simply supersedes one in flight.
        return ("openspace.time.interpolateDeltaTime("
                + lua_num(rate) + "," + lua_num(TIME_INTERP) + ")")

    def restore(self) -> None:
        """Put back anything this run changed that is not ours to keep. Called
        from the shutdown path, so it has to tolerate a half-open link."""
        # lua() reports failure by returning False rather than raising, so
        # a dead link on the way out is a message, not a traceback over the
        # top of the shutdown.
        if self.time_was is not None and self.time_rate is not None:
            if self.link.lua("openspace.time.setDeltaTime("
                             + lua_num(self.time_was) + ")"):
                print(f"time speed restored to {_rate(self.time_was)}")
            else:
                print("could not restore the time speed -- OpenSpace is gone")
        if self.retarget_was is None:
            return
        if self.link.lua("openspace.setPropertyValue("
                         + _lua_str(RETARGET_URI) + ","
                         + lua_num(self.retarget_was) + ")"):
            print(f"focus retarget time restored to {self.retarget_was:g}s")
        else:
            print("could not restore the retarget time -- OpenSpace is gone")

    def hide_text(self) -> None:
        """Switch off every source of on-screen text in the scene.

        Each pattern is probed first: applying a wildcard or tag that matches
        nothing makes OpenSpace log an LERROR ("No property matched the
        requested URI"), so an unprobed sweep would fill its log with errors on
        every start."""
        patterns = list(LABEL_SWEEPS)
        if self.args.hide_screen_text:
            patterns += SCREEN_TEXT

        SQ = chr(39)
        counts = self.link.ask(
            "local u={" + ",".join(SQ + p + SQ for p in patterns) + "} "
            "local r={} for i,v in ipairs(u) do r[i]=#openspace.property(v) end "
            "return r", timeout=15.0, want=len(patterns))
        if counts is None or len(counts) < len(patterns):
            # Could not tell what exists; do nothing rather than spam the log.
            print("could not probe the label patterns -- text left as it is")
            return

        applied, total = [], 0
        for pat, n in zip(patterns, counts):
            if n > 0:
                applied.append("openspace.setPropertyValue("
                               + _lua_str(pat) + ",false)")
                total += int(n)
        if applied:
            self.link.lua(";".join(applied), synchronized=True)
        print(f"text hidden: {total} properties across {len(applied)} patterns "
              f"(--keep-labels to leave them alone)")

    def telemetry(self, now: float, replies) -> None:
        """Keep tel_dist / tel_sep up to date from OpenSpace, asynchronously."""
        for topic, payload in replies:
            if topic is not None and topic == self.tel_topic:
                nums = _all_numbers(payload)
                if nums:
                    self.tel_dist = nums[0]
                    self.tel_sep = nums[1] if len(nums) > 1 else None
                    self.tel_sep_for = self.tel_sep_pending
                    self.tel_stale = False
                self.tel_topic = None

        if self.tel_topic is not None:
            if now - self.tel_sent > TELEMETRY_TIMEOUT:
                self.tel_topic = None      # give up on it and ask again
            return
        if now - self.tel_sent < TELEMETRY_EVERY:
            return

        # Ask for the distance to the focus, and -- during an "out" leg -- the
        # separation between the body we are leaving and the one we are heading
        # for. Both are computed in Lua so this stays one round trip.
        nxt = self.target or self.next_body()
        if nxt == "hold":
            nxt = None
        cur = self.current
        if self.phase == "out" and nxt is not None:
            script = (
                "local d=openspace.navigation.distanceToFocus() "
                f"local a=openspace.worldPosition('{cur}') "
                f"local b=openspace.worldPosition('{nxt}') "
                "local s=math.sqrt((a[1]-b[1])^2+(a[2]-b[2])^2+(a[3]-b[3])^2) "
                "return d,s")
            self.tel_sep_pending = (cur, nxt)
        else:
            script = "return openspace.navigation.distanceToFocus()"
            self.tel_sep_pending = None
        self.tel_topic = self.link.request(script)
        self.tel_sent = now

    def bass_body(self):
        """The body the debounced bass note names, or None if nothing is being
        asked for. May be the body we are already at -- see next_body."""
        if self.bass_pc is None or not self.args.bass:
            return None
        body = PITCH_BODY.get(self.bass_pc)
        if body is None:
            return None
        if body == OUTWARD:      # a mode, not a place; nothing to look up
            return body
        if body not in self.bodies:
            return None
        return body

    def note_body(self):
        """The bass note's choice of DESTINATION, when it is somewhere else.

        None if the note names where we already are, if nothing is being asked
        for, or if the note is B -- outward is a mode and tour_step handles it
        separately, so it must not leak in here as a place to travel to."""
        body = self.bass_body()
        if body is None or body == OUTWARD:
            return None
        return None if body == self.current else body

    def next_body(self):
        """Where to head next.

        Returns the string "hold" when the bass note names the body we are
        already at: holding a note should PARK the camera there rather than
        hand it on to the next body in the itinerary, otherwise naming a
        destination and arriving at it would immediately throw you onward,
        which is not what asking for a destination means."""
        if self.bass_body() == self.current:
            return "hold"
        chosen = self.note_body()
        if chosen is not None:
            return chosen
        if self.current in self.tour_stops:
            i = self.tour_stops.index(self.current)
            if i + 1 < len(self.tour_stops):
                return self.tour_stops[i + 1]
            return None
        # Bass steering took us somewhere off the itinerary and the player has
        # stopped asking for anything: hold here rather than guessing.
        return None

    def track_bass(self, now: float) -> None:
        """Debounce the bass note. `bass` arrives as a raw MIDI note number, or
        -1 when nothing is held."""
        raw = self.values.get("bass", -1.0)
        note = int(raw)
        # A note above the split is not bass and does not steer. Remember it so
        # the readout can say so, rather than looking simply broken.
        self.bass_high = note if note > self.args.bass_split else None
        pc = note % 12 if 0 <= note <= self.args.bass_split else None
        if pc != self.bass_raw:
            self.bass_raw = pc
            self.bass_since = now
        elif pc is not None and now - self.bass_since >= BASS_HOLD:
            self.bass_pc = pc
        elif pc is None:
            # Releasing does not clear the choice: the destination should
            # survive letting go of the chord to play something else.
            pass

    def body_exists(self, name: str) -> bool:
        """Is this node in the scene? `setFocus` raises a Lua error for one
        that is not, so a lock arriving over OSC is probed before it is
        obeyed. Cached in `self.bodies`, which the tour probe has usually
        already filled -- but not under --no-tour, where this is the only
        check there is. Called from the emit loop only: it blocks."""
        if name in self.bodies:
            return True
        got = self.link.ask("return openspace.hasSceneGraphNode("
                            + _lua_str(name) + ") and 1 or 0",
                            timeout=5.0, want=1)
        # ask() returns the FIRST number when want == 1, not a list of one --
        # subscripting it raises, and an exception in the emit loop takes the
        # bridge down with it. The reply comes from outside, so a value that
        # is not a number at all is treated as "no" rather than trusted.
        try:
            here = got is not None and float(got) > 0
        except (TypeError, ValueError):
            here = False
        if here:
            self.bodies.add(name)
            return True
        return False

    def apply_focus_lock(self, nav: list) -> None:
        """Engage or release the lock that `lock_want` asks for."""
        want = self.lock_want
        if want is not None and not self.body_exists(want):
            if want not in self.lock_missing:
                self.lock_missing.add(want)
                print(f"focus lock: no node called '{want}' in this "
                      f"scene -- ignored, the itinerary keeps steering")
            self.lock_want = None
            return

        self.lock_node = want
        now = time.monotonic()
        if want is not None:
            self.lock_since = now
            self.lock_arrived = False
            nav.append("openspace.navigation.setFocus("
                       + _lua_str(want) + ")")
            # Tell the itinerary where the camera actually is, so that
            # releasing the lock resumes from the Moon rather than from
            # wherever the tour last thought it was.
            self.current = want
            self.target = None
            self.redirect_to = None
            # "in": diving at the body. Says the right thing to the
            # readout, and makes telemetry() ask the simple question
            # (distance to focus) rather than a separation to a body the
            # bass happens to be naming.
            self.phase = "in"
            self.tel_stale = True
            self.lock_rate = None
            # How close to get. ARRIVE is the tour's own framing distance
            # for a body, about three radii. A node that has no entry --
            # anything off the itinerary -- has no known radius, so the
            # camera holds its distance there instead of guessing.
            self.lock_dist = (self.args.lock_distance
                              if self.args.lock_distance
                              else ARRIVE.get(want))
            if self.lock_dist:
                print(f"initial destination {want} -- flying to {want} first "
                      f"({self.lock_dist / 1e6:.1f} Mm over "
                      f"{self.args.lock_approach:g}s), then continuing to "
                      f"other planets")
            else:
                print(f"initial destination {want} -- turning to {want} first "
                      f"({self.args.retarget_time:g}s), then continuing to "
                      f"other planets")
        else:
            self.phase = "out"
            self.tel_stale = True
            self.tour_last_change = now
            print("focus lock released -- the itinerary steers again")

    def lock_step(self, now: float, nav: list) -> int:
        """Fly to the initial/locked body. Once arrived, release the lock (unless
        --lock-focus was pinned on the command line) so the camera continues on
        to the other planets."""
        # Still tracked, so the readout can show what the left hand is
        # playing -- it simply cannot steer until we arrive at this first body.
        self.track_bass(now)

        # The rotation onto the body has to have settled before moving on,
        # however close we already are.
        turned = now - self.lock_since >= max(0.0, self.args.retarget_time)

        if not self.lock_arrived:
            if self.lock_dist is None:
                self.lock_arrived = turned
            elif self.tel_stale or self.tel_dist is None:
                # A reading taken before the focus changed describes the
                # body we left, and acting on it would fly the wrong way.
                # Waiting a tick is the whole cost of not guessing.
                return 0
            elif (math.log(max(1e-9, self.tel_dist / self.lock_dist))
                    <= LOCK_ARRIVED_GAP):
                if turned:
                    self.lock_arrived = True
            else:
                gap = math.log(self.tel_dist / self.lock_dist)
                if self.lock_rate is None:
                    self.lock_rate = min(
                        LOCK_RATE_MAX,
                        gap / max(0.1, self.args.lock_approach) / DUTY)
                # Ease off over the last stretch, so it settles smoothly
                # rather than arriving at full speed.
                rate = self.lock_rate * min(1.0, gap / LOCK_EASE)
                # POSITIVE truck movement pulls towards the focus node.
                nav.append("openspace.navigation.addTruckMovement("
                           + lua_num(rate) + ")")
                return 0

        if self.lock_arrived:
            # If the user did not pin --lock-focus on the CLI, arriving at the
            # first body (e.g. Moon in FlyMeToTheMoon) releases the lock so the
            # camera continues to other planets.
            if self.args.lock_focus is None:
                arrived = self.lock_node
                dist_str = (f"{self.tel_dist / 1e6:.1f} Mm"
                            if self.tel_dist is not None else "arrived")
                print(f"arrived at {arrived} ({dist_str}) -- releasing focus "
                      f"lock to continue to other planets")
                self.lock_node = None
                self.lock_want = None
                self.tour_started = True
                self.current = arrived
                self.target = None
                self.redirect_to = None
                self.bass_pc = None
                self.bass_raw = None
                self.phase = "out"
                self.tel_stale = True
                self.tour_last_change = now
                return -1
            if self.args.orbit_rate:
                nav.append("openspace.navigation.addGlobalRotation("
                           + lua_num(self.args.orbit_rate) + ",0)")
        return 0

    def tour_step(self, now: float, nav: list) -> int:
        """Advance the itinerary. Returns the truck direction the current phase
        wants: -1 to zoom out, +1 to zoom in, 0 to hold."""
        self.track_bass(now)

        if not self.tour_started:
            # "In the beginning, focus should be on Earth."
            self.tour_started = True
            self.tour_last_change = now
            self.tel_stale = True
            self.current = self.tour_stops[0]
            nav.append("openspace.navigation.setFocus("
                       + _lua_str(self.current) + ")")
            return 0

        # A transition needs a reading taken since the last focus change, and a
        # little dwell -- right after a handover tel_dist still describes the
        # body we left.
        ready = (not self.tel_stale
                 and self.tel_dist is not None
                 and now - self.tour_last_change >= TOUR_DWELL)

        # B: focus the Sun and keep receding, for as long as it is held. Not a
        # destination, so it is handled before the phase machinery rather than
        # inside it.
        if self.bass_body() == OUTWARD:
            if self.phase != "final" and ready:
                self.phase = "final"
                self.current = TOUR_FINAL
                self.target = None
                self.redirect_to = None
                self.tour_last_change = now
                self.tel_stale = True
                nav.append("openspace.navigation.setFocus("
                           + _lua_str(TOUR_FINAL) + ")")
            return -1

        if self.phase == "final":
            # Zooming out past the end of the itinerary. A bass note can still
            # pull us back into the solar system.
            chosen = self.note_body()
            if chosen is not None and ready:
                self.phase = "out"
                self.target = chosen
                self.tour_last_change = now
                self.tel_stale = True
            return -1

        if self.phase == "out":
            # The destination is live while we recede: play a different bass
            # note and the camera re-aims before it commits.
            nxt = self.next_body()
            if nxt == "hold":
                # Parked: the player is naming this body. Do not recede.
                self.target = None
                return 0
            self.target = nxt
            if self.target is None:
                return -1
            # The separation has to belong to the pair we are actually
            # travelling between. Right after the destination changes, the
            # cached tel_sep still describes the OLD target, and acting on it
            # would hand focus over at the wrong distance.
            sep_ok = (self.tel_sep is not None
                      and self.tel_sep_for == (self.current, self.target))
            if ready and sep_ok \
                    and self.tel_dist >= self.args.tour_midpoint * self.tel_sep:
                # Halfway there: hand focus over and dive in.
                self.current = self.target
                self.phase = "in"
                self.tour_last_change = now
                self.tel_stale = True
                nav.append("openspace.navigation.setFocus("
                           + _lua_str(self.current) + ")")
                return 1
            return -1

        # phase == "in": diving at the body. Re-aiming is deliberately harder
        # here than in the "out" phase -- swinging the focus round while already
        # moving reads as a mistake rather than a choice -- but it must be
        # POSSIBLE, because a dive only completes if the playing is committed
        # enough to cover the distance. Naming a body, then playing too gently
        # to reach it, used to leave steering unresponsive indefinitely.
        chosen = self.note_body()
        if chosen is not None:
            if chosen != self.redirect_to:
                self.redirect_to = chosen
                self.redirect_since = now
            elif now - self.redirect_since >= BASS_REDIRECT:
                self.redirect_to = None
                self.redirect_since = 0.0
                self.target = chosen
                self.phase = "out"
                self.tour_last_change = now
                self.tel_stale = True
                return -1
        else:
            self.redirect_to = None

        if ready and self.tel_dist <= ARRIVE.get(self.current, 0.0):
            self.target = None
            self.tour_last_change = now
            self.tel_stale = True
            nxt = self.next_body()
            if nxt == "hold":
                # Arrived where the player asked for. Stay.
                self.phase = "out"
                return 0
            if nxt is None:
                # Nothing further asked for and the itinerary is done: turn to
                # the Sun and keep zooming out.
                self.phase = "final"
                self.current = TOUR_FINAL
                nav.append("openspace.navigation.setFocus("
                           + _lua_str(TOUR_FINAL) + ")")
                return -1
            self.phase = "out"
            return -1
        return 1

    def tour_where(self) -> str:
        if self.lock_node is not None:
            if self.lock_arrived:
                return self.lock_node + ", locked, orbiting"
            if self.lock_dist and self.tel_dist and not self.tel_stale:
                return (f"{self.lock_node}, locked, closing in "
                        f"({self.tel_dist / 1e6:.0f} -> "
                        f"{self.lock_dist / 1e6:.1f} Mm)")
            return self.lock_node + ", locked, arriving"
        """One line saying where the camera is, where it is going, and -- when
        nothing appears to be happening -- WHY.

        Worth the detail: "the focus does not switch" has several completely
        different causes (the note is above the split, it has not been held long
        enough, the dwell after the last change, or simply that the handover
        happens at the midpoint and you are not there yet), and they are
        indistinguishable from the outside."""
        note = ("" if self.bass_pc is None
                else f" [{NOTE_NAMES[self.bass_pc]}]")
        if self.bass_high is not None:
            note += (f" ({NOTE_NAMES[self.bass_high % 12]}"
                     f"{self.bass_high // 12 - 1} too high to steer)")

        if not self.tour_started:
            return "starting"
        if self.phase == "final":
            return f"{TOUR_FINAL}, outward without end{note}"

        if self.phase == "in":
            arrive = ARRIVE.get(self.current, 0.0)
            near = ""
            if self.tel_dist and arrive > 0:
                # how much of the dive is left, in e-folds
                left = math.log(max(self.tel_dist, arrive) / arrive)
                near = f" {left:.1f} to go"
            if self.redirect_to:
                near += f" (holding {self.redirect_to}...)"
            return f"-> {self.current}{note}{near}"

        nxt = self.target or self.next_body()
        if nxt == "hold":
            return f"at {self.current}{note}"
        if nxt is None:
            return f"{self.current}, outward{note}"

        # "out" phase: how much further to recede before focus hands over.
        # In e-folds rather than a percentage, because the distances are
        # exponential -- a percentage sits at 0% for ten seconds on the way to
        # Pluto and tells you nothing. Only shown when the cached separation
        # belongs to this pair; otherwise it would be a number about the
        # previous destination.
        prog = ""
        if (self.tel_dist and self.tel_sep
                and self.tel_sep_for == (self.current, nxt)):
            goal = self.args.tour_midpoint * self.tel_sep
            if goal > 0:
                if self.tel_dist >= goal:
                    prog = " handing over"
                else:
                    prog = f" {math.log(goal / self.tel_dist):.1f} to go"
        return f"{self.current} -> {nxt}{note}{prog}"

    def eligible(self, conds: dict) -> bool:
        """Are all of a layer's conditions currently satisfied? This decides
        WHAT can come on; the accrual decides how much."""
        return all(self.source(src) >= th for src, th in conds.items())

    def accrue(self, now: float, dt: float) -> None:
        """Advance the sustain counter and latch in new layers.

        Playing continuously is what earns layers: `progress` climbs while there
        is sound and every whole unit activates one more. Playing rapidly and
        with more velocity makes it climb faster. Stopping resets it, and
        everything fades out."""
        playing = self.values.get("energy", 0.0) >= self.args.idle_floor

        if not playing:
            if self.stopped_at is None:
                self.stopped_at = now
            elif now - self.stopped_at >= self.args.hold:
                # A real stop, not a rest or a phrasing gap.
                self.progress = 0.0
                self.unlocked.clear()
            return

        self.stopped_at = None

        # How rapid, and how much velocity -- exactly the two things that should
        # buy more layers.
        intensity = 0.5 * self.source("density") + 0.5 * self.source("loudness")
        mult = PACE_MIN + (PACE_MAX - PACE_MIN) * min(1.0, max(0.0, intensity))
        self.progress += (dt / self.args.layer_pace) * mult

        # Activate as many as we have earned, cheapest rank first, from whatever
        # is eligible right now. A layer that is not eligible is skipped rather
        # than blocking the queue, so the playing chooses which families open.
        while len(self.unlocked) < int(self.progress):
            nxt = None
            for name, _uri, rank, conds in sorted(LAYERS, key=lambda e: e[2]):
                if name in self.unlocked:
                    continue
                if not self.layer_live.get(name, False):
                    continue
                if self.eligible(conds):
                    nxt = name
                    break
            if nxt is None:
                # Nothing is eligible: hold the credit at the current level
                # rather than letting it run away while you play single notes,
                # or the moment you did play a chord the sky would pop open.
                self.progress = float(len(self.unlocked))
                break
            self.unlocked.append(nxt)

    def source(self, name: str) -> float:
        """The derived value a layer is driven by. Any name may be suffixed
        "_inv" to drive off (1 - value) instead -- that is how the low register
        and consonance get layers of their own."""
        if name.endswith("_inv"):
            return 1.0 - self.source(name[:-4])
        if name == "earned":
            # Not an OSC value: how far through the table we already are. This
            # is what holds the final tier back until the rest of the scene is
            # up, regardless of which families the playing happens to open.
            return len(self.unlocked) / max(1, len(LAYERS))
        # centroid holds mid-keyboard when nothing is playing; everything else
        # rests at zero.
        default = 0.5 if name == "centroid" else 0.0
        return min(1.0, max(0.0, self.values.get(name, default)))

    # -- receive --------------------------------------------------------

    def receive(self, budget: float) -> None:
        self.receive_until(time.monotonic() + budget)

    def receive_until(self, end: float) -> None:
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            self.udp.settimeout(remaining)
            try:
                data, _ = self.udp.recvfrom(65536)
            except (socket.timeout, TimeoutError):
                return
            except OSError:
                return
            for addr, oscargs in decode_packet(data):
                self.handle(addr, oscargs)

    def handle(self, addr: str, oscargs: list) -> None:
        self.osc_msgs += 1
        self.last_osc = time.monotonic()
        if not addr.startswith(self.args.prefix):
            return
        tail = addr[len(self.args.prefix):].lstrip("/")

        if tail.startswith("layer/") or tail == "layerCount":
            # Legacy. Layer opacities used to be computed in the .scd and sent
            # over; the bridge derives them from the raw values now, so that one
            # table defines them instead of two in two languages. Ignore these,
            # but say so once -- it means an older openspace_piano.scd.
            if "legacy" not in self.unknown:
                self.unknown.add("legacy")
                print("note: ignoring /piano/layer/* -- layers are computed "
                      "here now. Update openspace_piano.scd (block 4) to stop "
                      "sending them.")
            return

        if tail == "note":
            if len(oscargs) >= 2:
                self.notes.append((int(oscargs[0]), float(oscargs[1])))
                now = time.monotonic()
                self.time_seen_notes = True
                if now - self.time_last_onset > TIME_CHORD_WINDOW:
                    self.time_onsets.append((now, 1.0))
                    self.time_last_onset = now
                else:
                    self.time_onsets.append((now, TIME_CHORD_WEIGHT))
            return

        if tail == "focusLock":
            if not self.args.camera:
                return
            # A string names the node; a number is the toggle, where
            # non-zero means the default body and 0 releases. Recorded
            # only -- the emit loop does the talking.
            arg = oscargs[0] if oscargs else 0
            if isinstance(arg, str):
                self.lock_want = arg.strip() or None
            else:
                self.lock_want = (FOCUS_LOCK_NODE
                                  if float(arg) > 0.5 else None)
            return

        if oscargs and isinstance(oscargs[0], (int, float)):
            self.values[tail] = float(oscargs[0])

    # -- emit -----------------------------------------------------------

    def emit(self) -> None:
        if not self.link.connected:
            return

        # Navigation: continuous impulses, deliberately not synchronised.
        # ScriptCameraStates feeds these through a first-order filter with a
        # roughly one-second time constant, so a 30 Hz stream reads as a steady
        # velocity, does not pulse against a 60 fps renderer, and coasts to a
        # stop on its own when the playing stops. synchronized=False keeps
        # thirty messages a second off the cluster network -- on a multi-node
        # setup the camera is synchronised by the engine, not by these scripts.
        nav: list[str] = []

        # Silence has to mean stillness, and that cannot be read off the
        # character values alone: `centroid` deliberately HOLDS its last value
        # when the playing stops (so that stopping does not yank the camera) and
        # `tension` only lags towards neutral. Left ungated, a held centroid
        # reads as a standing instruction to keep orbiting, and the camera
        # rotates forever. `energy` is the one value that genuinely decays to
        # zero, so everything about the camera is gated and scaled by it. Below
        # the floor we emit nothing at all and OpenSpace's own deceleration
        # brings the camera to rest over about a second.
        energy = self.values.get("energy", 0.0)
        now = time.monotonic()

        # Measured, not assumed. The loop cannot hold exactly 1/TICK Hz -- the
        # UDP wait plus Windows' ~16 ms timer granularity make it slower and
        # variable -- and using a nominal TICK here made the drift home take
        # twice its configured time.
        dt = now - self.last_emit if self.last_emit is not None else TICK
        dt = min(max(dt, 0.0), 0.5)
        self.last_emit = now

        if self.args.camera:
            touring = self.args.tour and bool(self.tour_stops)
            flying = False   # nothing flies any more; the tour only zooms

            # A pending lock change is applied here rather than in the OSC
            # callback: this is the thread that is allowed to send Lua.
            if self.lock_want != self.lock_node:
                self.apply_focus_lock(nav)

            # The itinerary decides which way to zoom: -1 away from the focus,
            # +1 towards it, 0 hold. Focus changes are the only other thing it does.
            # A lock replaces it outright -- see FOCUS_LOCK_NODE.
            if self.lock_node is not None:
                direction = self.lock_step(now, nav)
            else:
                direction = self.tour_step(now, nav) \
                    if (touring and self.last_osc > 0.0) else -1

            if energy >= self.args.idle_floor:
                self.last_active = now
                self.drifting = False

                zoom = self.values.get("zoomSpeed", 0.0)
                if zoom > 1e-4 and self.args.truck_gain and direction != 0:
                    # A positive truck movement pulls *towards* the focus node, so
                    # receding needs a negative value. During an "in" leg the sign
                    # flips and the same playing carries the camera inward instead.
                    rate = zoom * self.args.truck_gain
                    nav.append("openspace.navigation.addTruckMovement("
                               + lua_num(direction * rate) + ")")
                    if not touring:
                        self.net_efolds += rate * DUTY * dt

                # Everything below is suppressed while a focus is locked: the
                # orbit is meant to be smooth, and these three are what make
                # the camera react to individual notes.
                locked = self.lock_node is not None

                elevation = (self.values.get("centroid", 0.5) - 0.5) * 2.0 * energy
                if not flying and not locked and abs(elevation) > 1e-3 \
                        and self.args.elevation_gain:
                    rot_y = elevation * self.args.elevation_gain
                    if self.args.slow:
                        rot_y = max(-SLOW_MAX_ROT, min(SLOW_MAX_ROT, rot_y))
                    nav.append("openspace.navigation.addGlobalRotation(0,"
                               + lua_num(rot_y) + ")")

                tension = self.values.get("tension", 0.0) * energy
                if not flying and not locked and tension > 1e-3 \
                        and self.args.roll_gain:
                    phase = 2 * math.pi * ROLL_HZ * (time.monotonic() - self.t0)
                    roll = tension * self.args.roll_gain * math.sin(phase)
                    if self.args.slow:
                        roll = max(-SLOW_MAX_ROT, min(SLOW_MAX_ROT, roll))
                    nav.append("openspace.navigation.addLocalRoll("
                               + lua_num(roll) + ")")

                if not flying and not locked and self.notes and NOTE_KICK:
                    kick = sum(v for _, v in self.notes) * NOTE_KICK
                    nav.append("openspace.navigation.addLocalRotation("
                               + lua_num(kick) + ",0)")

            # No drift home while touring: zoom IS the tour's mechanism, so pushing
            # it in silence would walk the itinerary backwards, and the state
            # machine only moves forward. Silence simply holds position.
            elif (not touring
                    and self.lock_node is None
                    and self.last_active is not None
                    and self.args.drift_time > 0
                    and now - self.last_active >= self.args.drift_after
                    and self.net_efolds > DRIFT_DEADBAND):
                # Silence: fall gently back the way we came. Positive truck movement
                # is towards the focus node. Nothing else about the camera is
                # touched, so the drift is a pure retreat with no rotation.
                #
                # `last_active is None` until the first note, so leaving the bridge
                # running will never drag the camera off a view you have parked.
                if not self.drifting:
                    # Entering the drift: pick the rate that covers the distance we
                    # actually travelled in the configured return time. Recomputed
                    # every time the drift restarts, so a short phrase comes back
                    # gently and a long climb comes back faster but still smoothly.
                    self.drifting = True
                    self.drift_rate = min(
                        DRIFT_MAX,
                        self.net_efolds / self.args.drift_time / DUTY)

                rate = self.drift_rate
                # Ease off over the last stretch so it settles rather than stopping
                # dead at the deadband.
                rate *= min(1.0, self.net_efolds / DRIFT_EASE)
                nav.append("openspace.navigation.addTruckMovement("
                           + lua_num(rate) + ")")
                self.net_efolds = max(0.0, self.net_efolds - (rate * DUTY * dt))
            else:
                self.drifting = False

        self.notes.clear()

        if nav:
            self.send(";".join(nav), synchronized=False)

        # Property changes: dead-banded, and synchronised so every node of a
        # cluster fades together.
        props: list[str] = []

        # Only drive the scene once the piano is actually talking to us --
        # otherwise merely starting the bridge would blank whatever the
        # performer has set up.
        if self.args.layers and self.last_osc > 0.0:
            self.accrue(now, dt)

            for name, uri, _rank, _conds in LAYERS:
                if not self.layer_live.get(name, False):
                    continue

                # Slow linear ramp towards the latched state, shaped by
                # smoothstep so it eases at both ends. This is the
                # "less sensitive" part: nothing can strobe.
                target = 1.0 if name in self.unlocked else 0.0
                r = self.ramp.get(name, 0.0)
                span = FADE_IN if target > r else FADE_OUT
                step = dt / max(span, 1e-6)
                r = min(target, r + step) if target > r else max(target, r - step)
                self.ramp[name] = r
                value = smoothstep(r, 0.0, 1.0)
                self.layers[name] = value

                # Renderable.Enabled: most digitaluniverse nodes ship
                # disabled, and a disabled renderable draws nothing whatever
                # Fade says. Switching it off again at zero also keeps the GPU
                # cost proportional to how much is actually visible, which
                # matters at this many layers.
                want_on = value > ENABLE_AT
                if self.layer_enabled.get(name) is not want_on:
                    self.layer_enabled[name] = want_on
                    props.append("openspace.setPropertyValue("
                                 + _lua_str(uri + ".Enabled") + ","
                                 + ("true" if want_on else "false") + ")")

                # Dead-band on the FORMATTED value, not the float: lua_num is
                # 5 significant figures, so near the ends of the ramp two
                # distinct floats serialise identically and comparing the
                # floats let a redundant write through.
                txt = lua_num(value)
                last = self.last_layer.get(name)
                if last is not None and txt == last[1]:
                    continue
                # Always let the endpoints through, so a layer settles at
                # exactly 0 or 1 instead of stalling a hair short.
                if last is not None and abs(value - last[0]) < LAYER_EPS \
                        and value not in (0.0, 1.0):
                    continue
                self.last_layer[name] = (value, txt)
                props.append("openspace.setPropertyValue("
                             + _lua_str(uri + ".Fade") + "," + txt + ")")

        for osc_name, uri in self.scalar_uri.items():
            if osc_name not in self.values:
                continue
            lo, hi = self.scalar_range[osc_name]
            value = lo + (hi - lo) * min(1.0, max(0.0, self.values[osc_name]))
            last = self.last_scalar.get(osc_name)
            if last is not None and abs(value - last) < SCALAR_EPS:
                continue
            self.last_scalar[osc_name] = value
            props.append("openspace.setPropertyValue("
                         + _lua_str(uri) + "," + lua_num(value) + ")")

        # Point sizes. Only for layers that are actually showing: writing a
        # size to something invisible is pure traffic.
        if self.size_base and self.last_osc > 0.0:
            target = self.source(self.args.size_source)
            self.size_val += (target - self.size_val) * min(1.0, dt / SIZE_LAG)
            common = (self.args.size_min
                      + (self.args.size_max - self.args.size_min)
                      * self.size_val)

            # Each band on a much shorter lag than loudness, so it snaps with
            # the notes instead of swelling. The band multiplies rather than
            # replaces, so playing in a register explodes whatever that group
            # was already doing.
            for band in self.band_val:
                b_target = self.source(band)
                self.band_val[band] += ((b_target - self.band_val[band])
                                        * min(1.0, dt / TREBLE_LAG))

            for name, base in self.size_base.items():
                if self.ramp.get(name, 0.0) <= 0.0:
                    continue
                bv = self.band_val.get(BAND_OF.get(name, "treble"), 0.0)
                mult = common * (1.0 + self.args.treble_boost * bv)
                txt = lua_num(min(base * mult, SIZE_CEILING))
                if self.last_size.get(name) != txt:
                    self.last_size[name] = txt
                    props.append("openspace.setPropertyValue("
                                 + _lua_str(self.layer_uri[name]
                                            + ".Sizing.ScaleFactor")
                                 + "," + txt + ")")
                # ...and the same band drives how solid the group looks
                if name in getattr(self, "opacity_live", ()):
                    op = OPACITY_MIN + (OPACITY_MAX - OPACITY_MIN) * bv
                    otxt = lua_num(op)
                    if self.last_opacity.get(name) != otxt:
                        self.last_opacity[name] = otxt
                        props.append("openspace.setPropertyValue("
                                     + _lua_str(self.layer_uri[name]
                                                + ".Opacity")
                                     + "," + otxt + ")")

        if props:
            self.send(";".join(props), synchronized=True)

        # Time speed. Not synchronised, like the camera: in a cluster the
        # master owns the clock and OpenSpace's own time sync carries it to
        # every node, so sending it to them as well would be redundant.
        if self.time_live and self.last_osc > 0.0:
            script = self.time_step(now, dt)
            if script:
                self.send(script, synchronized=False)

    def send(self, script: str, synchronized: bool) -> None:
        if self.args.verbose:
            print(f"  lua{'' if synchronized else ' (local)'}: {script}")
        self.link.lua(script, synchronized=synchronized)

    # -- monitor --------------------------------------------------------

    def status(self) -> None:
        if self.args.verbose:
            return
        v = self.values
        live = sum(1 for n, o in self.layers.items()
                   if o > 0.5 and self.layer_live.get(n))
        total = sum(1 for x in self.layer_live.values() if x)
        # Per-source breakdown, so it is obvious at a glance which quality of
        # playing is currently revealing things: E)nergy, C)entroid, T)ension,
        # P)olyphony, D)ensity.
        groups = f" +{self.progress - len(self.unlocked):.2f}"
        stale = time.monotonic() - self.last_osc
        if self.last_osc == 0.0:
            state = "waiting for OSC"
        elif not self.link.connected:
            state = "OpenSpace offline"
        elif stale > 1.0:
            state = f"no OSC for {stale:.0f}s"
        elif not self.args.camera:
            state = "camera off"
        elif self.args.tour and self.tour_stops:
            d = self.tel_dist
            state = self.tour_where()
            if d:
                state += f"  {_si(d)}"
        elif self.drifting:
            state = f"drifting back, {self.net_efolds:.1f} e-folds out"
        elif v.get("energy", 0.0) < self.args.idle_floor:
            state = f"idle, {self.net_efolds:.1f} e-folds out"
        else:
            state = "ok"
        # The C6-and-up size boost, only shown when it is actually doing
        # something -- it is the most dramatic thing on screen and worth being
        # able to correlate with what you played.
        boost = ""
        hottest = max(self.band_val.values(), default=0.0)
        if hottest > 0.02 and self.args.treble_boost:
            boost = f" x{1.0 + self.args.treble_boost * hottest:.1f}"
        if self.time_live and self.time_rate is not None:
            state += f"  time {_rate(self.time_rate)}"
        print(f"energy {v.get('energy', 0.0):5.2f}  "
              f"zoom {v.get('zoomSpeed', 0.0):5.2f}  "
              f"cent {v.get('centroid', 0.5):5.2f}  "
              f"sprd {v.get('spread', 0.0):5.2f}  "
              f"tens {v.get('tension', 0.0):5.2f}"
              f" | on {len(self.unlocked):2d}/{total:2d}{groups}{boost}"
              f" | osc {self.osc_msgs:6d}  tx {self.link.sent:6d}  {state}")

    # -- main loop ------------------------------------------------------

    def run(self) -> None:
        a = self.args
        print(f"OSC in   : {a.osc_host}:{a.osc_port}  (prefix {a.prefix})")
        print(f"OpenSpace: {a.os_host}:{a.os_port}"
              f"{'  [DRY RUN, nothing is sent]' if a.dry_run else ''}")

        probed = False
        if self.link.connect():
            print("connected")
            self.probe()
            probed = True
        else:
            print("OpenSpace not reachable yet -- will keep retrying")
        print("Ctrl+C to stop.\n")

        next_status = time.monotonic() + STATUS_EVERY
        next_retry = 0.0

        next_emit = time.monotonic()
        while True:
            next_emit += TICK
            # If we fell behind (a slow frame, a reconnect), resynchronise
            # rather than trying to catch up with a burst of emits.
            if next_emit < time.monotonic():
                next_emit = time.monotonic()
            self.receive_until(next_emit)

            now = time.monotonic()
            if not self.link.connected and now >= next_retry:
                next_retry = now + RECONNECT_EVERY
                if self.link.connect():
                    print("reconnected")
                    # The scene may have been reloaded, so re-send every value.
                    self.last_layer.clear()
                    self.last_scalar.clear()
                    self.time_rate = None
                    if not probed:
                        self.probe()
                        probed = True

            replies = self.link.drain()
            # The tour needs the camera's distance to its focus, and so does a
            # focus lock now that it flies to the body -- without a reading the
            # approach has nothing to close and would wait for ever, which is
            # exactly what --no-tour used to do to it.
            if self.args.camera and (self.args.tour or self.lock_node or self.lock_want):
                self.telemetry(now, replies)
            self.emit()

            if now >= next_status:
                next_status = now + STATUS_EVERY
                self.status()


def _lua_str(s: str) -> str:
    """Quote a string as a Lua literal. Property URIs contain braces and dots
    but never quotes or backslashes; escape anyway rather than assume."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Bridge piano-derived OSC values into OpenSpace.")
    p.add_argument("--osc-host", default=OSC_HOST)
    p.add_argument("--osc-port", type=int, default=OSC_PORT)
    p.add_argument("--os-host", default=OS_HOST)
    p.add_argument("--os-port", type=int, default=OS_PORT)
    p.add_argument("--prefix", default=PREFIX)
    p.add_argument("--truck-gain", type=float, default=TRUCK_GAIN,
                   help="zoomSpeed -> pull-away, in e-folds of altitude per "
                        "second at full tilt (halved in practice); 0 disables")
    p.add_argument("--elevation-gain", type=float, default=ELEVATION_GAIN,
                   help="centroid -> orbit up/down, radians per second at full "
                        "tilt (halved in practice); 0 disables")
    p.add_argument("--roll-gain", type=float, default=ROLL_GAIN,
                   help="tension -> roll turbulence, radians per second peak "
                        "(halved in practice); 0 disables")
    p.add_argument("--layer-pace", type=float, default=LAYER_PACE,
                   help="seconds of gentle continuous playing per layer; "
                        "rapid, loud playing is up to 4x faster")
    p.add_argument("--hold", type=float, default=HOLD_AFTER_STOP,
                   help="seconds of silence before the layers reset")
    p.add_argument("--no-sizes", action="store_true",
                   help="do not modulate point sizes with the playing")
    p.add_argument("--size-source", default=SIZE_SOURCE,
                   help="derived value that drives point size "
                        "(loudness, energy, density, tension, ...)")
    p.add_argument("--size-min", type=float, default=SIZE_MIN,
                   help="point size multiplier when the source is 0")
    p.add_argument("--size-max", type=float, default=SIZE_MAX,
                   help="point size multiplier when the source is 1")
    p.add_argument("--treble-boost", type=float, default=TREBLE_BOOST,
                   help="extra size multiplier for a group of abstract point "
                        "clouds when its own register is played flat out; "
                        "0 disables")
    p.add_argument("--keep-labels", action="store_true",
                   help="do not switch off the scene's text labels")
    p.add_argument("--hide-screen-text", action="store_true",
                   help="also hide OpenSpace's own on-screen log, version "
                        "string and camera readout")
    p.add_argument("--idle-floor", type=float, default=IDLE_FLOOR,
                   help="energy below which the camera is left completely alone")
    p.add_argument("--no-bass", dest="bass", action="store_false",
                   help="ignore the bass note; follow the fixed itinerary only")
    p.add_argument("--bass-split", type=int, default=BASS_SPLIT,
                   help="highest MIDI note that counts as bass (59 = B below "
                        "middle C), so a right-hand melody cannot steer")
    p.add_argument("--retarget-time", type=float, default=RETARGET_TIME,
                   metavar="SEC",
                   help="seconds OpenSpace takes to swing the camera round to "
                        "a new focus (NavigationHandler.OrbitalNavigator."
                        "RetargetAnchorInterpolationTime). The original is "
                        "read first and restored on exit; 0 leaves OpenSpace's "
                        "own instant retarget alone")
    p.add_argument("--slow", action="store_true", default=SLOW_MODE,
                   help="slow mode: limit camera rotation movement (gentler "
                        "elevation rotation, minimal roll, and 40s focus "
                        "retarget turns)")
    p.add_argument("--time-only", action="store_true", default=TIME_ONLY,
                   help="stop all camera movement and leave scene layers, "
                        "point sizes and labels untouched; ONLY change the "
                        "simulation time speed with the playing")
    p.add_argument("--no-camera", dest="camera", action="store_false",
                   default=CAMERA,
                   help="stop all camera movement (tour, bass steering, focus "
                        "lock, zoom, rotation, roll), keeping time speed and "
                        "scene layers active")
    p.add_argument("--no-layers", dest="layers", action="store_false",
                   default=DRIVE_LAYERS,
                   help="do not toggle or fade scene layers")
    p.add_argument("--time", dest="time", action="store_true",
                   default=DRIVE_TIME,
                   help="also drive OpenSpace's simulation time speed in "
                        "normal mode (on automatically with --time-only)")
    p.add_argument("--no-time", dest="time", action="store_false",
                   help="leave OpenSpace's simulation time speed alone "
                        "(default in normal mode)")
    p.add_argument("--time-source", default=TIME_SOURCE,
                   help="derived value that drives the time speed "
                        "(density = notes per second; energy, loudness, ...)")
    p.add_argument("--time-min", type=float, default=TIME_MIN, metavar="DT",
                   help="delta time (simulated s per real s) in silence; "
                        "1 is real time. Must be > 0")
    p.add_argument("--time-max", type=float, default=TIME_MAX, metavar="DT",
                   help="delta time when playing flat out "
                        "(default 604800 = one week per second)")
    p.add_argument("--time-curve", type=float, default=TIME_CURVE,
                   help="exponent on the source; >1 needs faster playing "
                        "before time speeds up, <1 reacts sooner")
    p.add_argument("--time-gain", type=float, default=TIME_GAIN,
                   help="sensitivity multiplier on the playing speed before "
                        "mapping to time speed (default 1.2)")
    p.add_argument("--time-build", type=float, default=TIME_BUILD_SECS,
                   metavar="SEC",
                   help="seconds of continuous playing over which the time "
                        "speed climbs toward its full range (default 60; "
                        "0 disables the gradual build-up)")
    p.add_argument("--time-decay", type=float, default=TIME_DECAY_SECS,
                   metavar="SEC",
                   help="seconds of silence for the accumulated time speed "
                        "to unwind back to rest (default 30)")
    p.add_argument("--no-tour", dest="tour", action="store_false",
                   help="disable the planet tour; fly continuously outward "
                        "with truck movement and drift back on silence instead")
    p.add_argument("--lock-focus", metavar="NODE", default=None,
                   help="hold the camera on NODE for the whole run: the "
                        "itinerary and bass steering cannot change focus, "
                        "and the camera orbits it once it arrives")
    p.add_argument("--lock-approach", type=float, default=LOCK_APPROACH,
                   metavar="SEC",
                   help="seconds a locked focus takes to close the gap to "
                        "its framing distance before it starts orbiting")
    p.add_argument("--lock-distance", type=float, default=0.0,
                   metavar="M",
                   help="how close to get to a locked focus, in metres "
                        "from its centre; 0 uses the body's own ARRIVE "
                        "distance, about three radii")
    p.add_argument("--orbit-rate", type=float, default=ORBIT_RATE,
                   help="how fast a locked focus is orbited, per tick; "
                        "0 holds still, negative orbits the other way")
    p.add_argument("--tour-midpoint", type=float, default=TOUR_MIDPOINT,
                   help="fraction of the gap to the next body at which focus "
                        "hands over (0.5 = halfway). Set 0 to hand over "
                        "IMMEDIATELY, so a bass note switches focus at once "
                        "instead of after receding -- much more responsive, at "
                        "the cost of the sense of travelling there")
    p.add_argument("--drift-time", type=float, default=DRIFT_TIME,
                   help="seconds for silence to drift the camera back to where "
                        "the playing started; 0 = stay put")
    p.add_argument("--drift-after", type=float, default=DRIFT_AFTER,
                   help="extra seconds of silence before the drift begins")
    p.add_argument("--dry-run", action="store_true",
                   help="decode OSC and print Lua without touching OpenSpace")
    p.add_argument("--no-probe", action="store_true",
                   help="skip the startup existence check for scene nodes")
    p.add_argument("--verbose", action="store_true",
                   help="print every script instead of the monitor readout")
    args = p.parse_args(argv)

    # The readout is meant to be watched live, including when piped to a log or
    # a second terminal, so do not sit in a block buffer.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, OSError):
        pass

    if args.slow:
        args.elevation_gain = min(args.elevation_gain, SLOW_ELEVATION_GAIN)
        args.roll_gain = min(args.roll_gain, SLOW_ROLL_GAIN)
        args.orbit_rate = min(abs(args.orbit_rate), SLOW_ORBIT_RATE) * (
            -1 if args.orbit_rate < 0 else 1)
        if args.retarget_time is not None and args.retarget_time > 0:
            args.retarget_time = max(args.retarget_time, SLOW_RETARGET_TIME)
    if args.time_only:
        args.camera = False
        args.layers = False
        args.no_sizes = True
        args.keep_labels = True
        args.time = True
    if not args.camera:
        args.tour = False
        args.retarget_time = None
        args.lock_focus = None

    if args.retarget_time is not None and args.retarget_time < 0:
        print("--retarget-time cannot be negative")
        return 2
    if args.time and not (0 < args.time_min <= args.time_max):
        # The mapping is exponential, so zero or a negative rate has no
        # logarithm -- refuse it here rather than crash in the emit loop.
        print("--time-min must be > 0 and no larger than --time-max")
        return 2
    if args.time_curve <= 0:
        print("--time-curve must be > 0")
        return 2

    # Ctrl+C already unwinds: Python raises KeyboardInterrupt and the `finally`
    # below runs. Ctrl+Break and SIGTERM do not -- Python installs no handler
    # for either, so the process dies where it stands. That was harmless while
    # the bridge only wrote scene properties it owned, but it now borrows
    # OpenSpace's retarget time and promises to hand it back, so every ordinary
    # way of stopping it has to reach the restore.
    def _interrupt(_signum, _frame):
        raise KeyboardInterrupt

    for name in ("SIGBREAK", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _interrupt)
            except (ValueError, OSError):
                pass          # not the main thread, or not supported here

    bridge = Bridge(args)
    try:
        bridge.run()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        # before closing the link: restoring needs it
        bridge.restore()
        bridge.link.close()
        bridge.udp.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())


# =====================================================================
# PROTOCOL NOTES
#
# All of this comes from reading the OpenSpace tree, not from the docs, which
# are thinner and in places out of date.
#
# * OpenSpace does NOT receive OSC. Its telemetry module only *sends* OSC (to
#   127.0.0.1:57120, i.e. straight at sclang) for sonification. Inbound control
#   is the server module's socket API. So the OSC port in the original
#   openspace_piano.scd could never have worked, and a bridge is required
#   rather than optional.  openspace.cfg -> Server.Interfaces
#
# * Transport: TcpSocket on 4681, WebSocket on 4682. The TCP one is plain
#   newline-delimited JSON -- ghoul's TcpSocket uses '\n' as its delimiter
#   (ext/ghoul/src/io/socket/tcpsocket.cpp, DefaultDelimiter) -- so no
#   handshake or framing library is needed.
#
# * Authorisation: DefaultAccess is "Deny", but AllowAddresses contains
#   127.0.0.1 and localhost, so a local connection is authorised with no
#   password.  modules/server/src/serverinterface.cpp
#
# * Handshake (OpenSpace 0.22+): immediately on connect, the client must send
#   {"type": "apiHandshake", "apiVersion": {"major": 1, "minor": 0, "patch": 0}}
#   before any topic messages, or Connection::handleJson rejects every message
#   with "Unsupported API version".
#
# * Envelope: {"topic": <int>, "type": "<name>", "payload": {...}}.
#   modules/server/src/connection.cpp. Topic names are registered in
#   servermodule.cpp -- "luascript", "set", "get", "subscribe", and so on.
#
# * luascript payload: {"script": "...", "return": bool,
#   "shouldBeSynchronized": bool}, or {"function": "openspace.x.y",
#   "arguments": [...]} -- note that `arguments` must be present and an array.
#   We use `script`, which lets a whole tick go out as one message.
#   modules/server/src/topics/luascripttopic.cpp
#
# * A luascript topic with "return": false is done immediately and is never
#   retained, so `type` has to be resent every time and topic ids cannot leak.
#
# * addTruckMovement: a POSITIVE value moves the camera CLOSER to the focus
#   node. Flying away from Earth needs a negative value.
#   src/navigation/navigationhandler_lua.inl
#
# * These impulses are not applied directly. ScriptCameraStates writes them
#   into a DelayedVariable with scaleFactor 1.0, which at 60 fps moves about
#   1.7% towards the target per frame -- a first-order filter with roughly a
#   one-second time constant. Hence: a continuous stream reads as a steady
#   velocity, a 30 Hz stream into a 60 fps renderer does not pulse, and
#   stopping decelerates smoothly with no extra work here.
#   src/interaction/scriptcamerastates.cpp,
#   include/openspace/interaction/delayedvariable.inl
#
# * setPropertyValue (not ...Single) accepts one '*' wildcard or a tag
#   expression such as {planetTrail_solarSystem}. Tags are how OpenSpace's own
#   assets address groups, and they are written WITHOUT a "Scene." prefix.
#   src/scene/scene.cpp
#
# * openspace.property(uri) returns the list of matching URIs, which is what
#   the startup probe counts.  src/scene/scene_lua.inl
#
# * Every Renderable has a Fade property; Opacity is only added by some
#   subclasses.  src/rendering/renderable.cpp, src/rendering/fadeable.cpp
# =====================================================================
