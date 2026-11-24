// Constants, scene layer table, and helpers ported from openspace_bridge.py
// and openspace_piano.scd.

export const TICK = 1 / 30;
export const STATUS_EVERY = 0.5;
export const RECONNECT_EVERY = 2.0;

// ---------------------------------------------------------------------
// Bridge tuning defaults (openspace_bridge.py)
// ---------------------------------------------------------------------
export const SLOW_MODE = false;
export const TIME_ONLY = false;
export const CAMERA = true;
export const DRIVE_LAYERS = true;
export const DRIVE_TIME = false;

export const LAST_TIER_EARNED = 0.5;

export const LAYERS = [
  // ---- the local sky: reachable with single notes -------------------
  { name: "EarthAtmosphere", uri: "Scene.EarthAtmosphere.Renderable", rank: 1, conds: {} },
  { name: "VenusAtmosphere", uri: "Scene.VenusAtmosphere.Renderable", rank: 14, conds: {} },
  { name: "MarsAtmosphere", uri: "Scene.MarsAtmosphere.Renderable", rank: 15, conds: {} },
  { name: "TitanAtmosphere", uri: "Scene.TitanAtmosphere.Renderable", rank: 18, conds: {} },
  { name: "MoonTrail", uri: "Scene.MoonTrail.Renderable", rank: 2, conds: {} },
  { name: "PlanetTrails", uri: "{planetTrail_solarSystem}.Renderable", rank: 3, conds: {} },
  { name: "Stars", uri: "Scene.Stars.Renderable", rank: 4, conds: {} },
  { name: "Constellations", uri: "Scene.Constellations.Renderable", rank: 6, conds: {} },
  { name: "ConstellationArt", uri: "Scene.ImageConstellation-*.Renderable", rank: 101, conds: { tension_inv: 0.60, earned: LAST_TIER_EARNED } },
  { name: "OortSphere", uri: "Scene.OortSphere.Renderable", rank: 95, conds: { energy: 0.25, earned: LAST_TIER_EARNED } },
  { name: "MilkyWayVolume", uri: "Scene.MilkyWayVolume.Renderable", rank: 10, conds: { energy: 0.30 } },
  { name: "MilkyWayImage", uri: "Scene.MilkyWayGalaxyImage.Renderable", rank: 12, conds: { energy: 0.35 } },

  // ---- two notes and up ---------------------------------------------
  { name: "MoonTrails", uri: "{moonTrail_solarSystem}.Renderable", rank: 5, conds: { polyphony: 0.20 } },
  { name: "EarthSatellites", uri: "{earth_satellites}.Renderable", rank: 8, conds: { polyphony: 0.35 } },

  // ---- spread: keyboard span as spatial scale -----------------------
  { name: "Grid1lsec", uri: "Scene.1lsecGrid.Renderable", rank: 80, conds: { spread: 0.03, earned: LAST_TIER_EARNED } },
  { name: "Grid1lmin", uri: "Scene.1lminGrid.Renderable", rank: 81, conds: { spread: 0.06, earned: LAST_TIER_EARNED } },
  { name: "Grid1lh", uri: "Scene.1lhGrid.Renderable", rank: 82, conds: { spread: 0.10, earned: LAST_TIER_EARNED } },
  { name: "Grid1ld", uri: "Scene.1ldGrid.Renderable", rank: 83, conds: { spread: 0.15, earned: LAST_TIER_EARNED } },
  { name: "Grid1lm", uri: "Scene.1lmGrid.Renderable", rank: 84, conds: { spread: 0.20, earned: LAST_TIER_EARNED } },
  { name: "Grid1ly", uri: "Scene.1lyGrid.Renderable", rank: 85, conds: { spread: 0.24, earned: LAST_TIER_EARNED } },
  { name: "Grid10ly", uri: "Scene.10lyGrid.Renderable", rank: 86, conds: { spread: 0.30, earned: LAST_TIER_EARNED } },
  { name: "Grid100ly", uri: "Scene.100lyGrid.Renderable", rank: 87, conds: { spread: 0.36, earned: LAST_TIER_EARNED } },
  { name: "Grid1kly", uri: "Scene.1klyGrid.Renderable", rank: 88, conds: { spread: 0.42, earned: LAST_TIER_EARNED } },
  { name: "Grid10kly", uri: "Scene.10klyGrid.Renderable", rank: 89, conds: { spread: 0.48, earned: LAST_TIER_EARNED } },
  { name: "Grid100kly", uri: "Scene.100klyGrid.Renderable", rank: 90, conds: { spread: 0.55, earned: LAST_TIER_EARNED } },
  { name: "Grid1Mly", uri: "Scene.1MlyGrid.Renderable", rank: 91, conds: { spread: 0.62, earned: LAST_TIER_EARNED } },
  { name: "Grid10Mly", uri: "Scene.10MlyGrid.Renderable", rank: 92, conds: { spread: 0.70, earned: LAST_TIER_EARNED } },
  { name: "Grid100Mly", uri: "Scene.100MlyGrid.Renderable", rank: 93, conds: { spread: 0.78, earned: LAST_TIER_EARNED } },
  { name: "Grid20Gly", uri: "Scene.20GlyGrid.Renderable", rank: 94, conds: { spread: 0.86, earned: LAST_TIER_EARNED } },

  // ---- polyphony: one star orbit per voice --------------------------
  { name: "SunOrbit", uri: "Scene.SunOrbit.Renderable", rank: 14, conds: { polyphony: 0.26 } },
  { name: "BarnardsOrbit", uri: "Scene.BarnardsOrbit.Renderable", rank: 17, conds: { polyphony: 0.38 } },
  { name: "KapteynsOrbit", uri: "Scene.KapteynsOrbit.Renderable", rank: 20, conds: { polyphony: 0.48 } },
  { name: "Lacaille9352Orbit", uri: "Scene.Lacaille9352Orbit.Renderable", rank: 23, conds: { polyphony: 0.58 } },
  { name: "LSR1826Orbit", uri: "Scene.LSR1826Orbit.Renderable", rank: 26, conds: { polyphony: 0.68 } },
  { name: "LSRJ0822Orbit", uri: "Scene.LSRJ0822Orbit.Renderable", rank: 29, conds: { polyphony: 0.78 } },
  { name: "PM_J13420Orbit", uri: "Scene.PM_J13420Orbit.Renderable", rank: 33, conds: { polyphony: 0.86 } },

  // ---- polyphony: clustered things ----------------------------------
  { name: "OpenStarClusters", uri: "Scene.OpenStarClusters.Renderable", rank: 15, conds: { polyphony: 0.32 } },
  { name: "GlobularClusters", uri: "Scene.GlobularClusters.Renderable", rank: 21, conds: { polyphony: 0.50 } },
  { name: "OBAssociations", uri: "Scene.OBAssociations.Renderable", rank: 27, conds: { polyphony: 0.66 } },

  // ---- centroid: register as stellar temperature -------------------
  { name: "SunStar", uri: "Scene.SunStar.Renderable", rank: 18, conds: { centroid_inv: 0.42 } },
  { name: "BrownDwarfs", uri: "Scene.BrownDwarfs.Renderable", rank: 24, conds: { centroid_inv: 0.58 } },
  { name: "WhiteDwarfs", uri: "Scene.WhiteDwarfs.Renderable", rank: 24, conds: { centroid: 0.56 } },
  { name: "Pulsars", uri: "Scene.Pulsars.Renderable", rank: 30, conds: { centroid: 0.68 } },
  { name: "Quasars", uri: "Scene.Quasars.Renderable", rank: 37, conds: { centroid: 0.80 } },

  // ---- tension: dissonance as violence ----------------------------
  { name: "SmallBodies", uri: "Scene.sssb_*.Renderable", rank: 15, conds: { density: 0.45 } },
  { name: "HIIRegions", uri: "Scene.HIIRegions.Renderable", rank: 16, conds: { tension: 0.22 } },
  { name: "OrionNebula", uri: "Scene.OrionNebula*.Renderable", rank: 30, conds: { tension: 0.45 } },
  { name: "PlanetaryNebulae", uri: "Scene.PlanetaryNebulae.Renderable", rank: 22, conds: { tension: 0.36 } },
  { name: "SupernovaRemnants", uri: "Scene.SupernovaRemnants.Renderable", rank: 28, conds: { tension: 0.50 } },
  { name: "StarUncertainty", uri: "Scene.StarUncertainty.Renderable", rank: 34, conds: { tension: 0.64, polyphony: 0.28 } },

  // ---- consonance: geometric order --------------------------------
  { name: "EquatorialSphere", uri: "Scene.EquatorialSphere.Renderable", rank: 96, conds: { tension_inv: 0.32, polyphony: 0.20, earned: LAST_TIER_EARNED } },
  { name: "EclipticSphere", uri: "Scene.EclipticSphere.Renderable", rank: 97, conds: { tension_inv: 0.46, polyphony: 0.28, earned: LAST_TIER_EARNED } },
  { name: "GalacticSphere", uri: "Scene.GalacticSphere.Renderable", rank: 98, conds: { tension_inv: 0.60, polyphony: 0.38, earned: LAST_TIER_EARNED } },
  { name: "ConstellationBounds", uri: "Scene.ConstellationBounds.Renderable", rank: 100, conds: { tension_inv: 0.72, polyphony: 0.28, earned: LAST_TIER_EARNED } },
  { name: "RadioSphere", uri: "Scene.RadioSphere.Renderable", rank: 99, conds: { tension_inv: 0.80, polyphony: 0.48, earned: LAST_TIER_EARNED } },

  // ---- density: fast playing fills the sky with points ------------
  { name: "TwoMASS", uri: "Scene.2MASS.Renderable", rank: 17, conds: { density: 0.26 } },
  { name: "DeepSkyObjects", uri: "Scene.DeepSkyObjects.Renderable", rank: 20, conds: { density: 0.32 } },
  { name: "Exoplanets", uri: "Scene.Exoplanets.Renderable", rank: 23, conds: { density: 0.38, polyphony: 0.26 } },
  { name: "SixdFGalaxies", uri: "Scene.6dF.Renderable", rank: 27, conds: { density: 0.44 } },
  { name: "DeepSkyImages", uri: "Scene.DeepSkyObjectsImages.Renderable", rank: 31, conds: { density: 0.50 } },
  { name: "TwodFGalaxies", uri: "Scene.2dF.Renderable", rank: 35, conds: { density: 0.56 } },
  { name: "PlanetaryCandidates", uri: "Scene.PlanetaryCandidates.Renderable", rank: 38, conds: { density: 0.60, polyphony: 0.38 } },
  { name: "AllSkyVisible", uri: "Scene.AllSky_Visible.Renderable", rank: 42, conds: { density: 0.68, energy: 0.40 } },
  { name: "HubbleDeepField", uri: "Scene.HubbleDeepField.Renderable", rank: 45, conds: { density: 0.74, energy: 0.55 } },
  { name: "AllSkyHAlpha", uri: "Scene.AllSky_HAlpha.Renderable", rank: 48, conds: { density: 0.82, energy: 0.50 } },

  // ---- the deep universe: sustained, loud, and thick --------------
  { name: "LocalDwarfGalaxies", uri: "Scene.LocalDwarfGalaxies.Renderable", rank: 39, conds: { energy: 0.50, polyphony: 0.32 } },
  { name: "NearbyGalaxyGroups", uri: "Scene.NearbyGalaxyGroups.Renderable", rank: 43, conds: { energy: 0.56, polyphony: 0.40 } },
  { name: "TullyGalaxies", uri: "Scene.TullyGalaxies.Renderable", rank: 46, conds: { energy: 0.62, polyphony: 0.46 } },
  { name: "TullyImages", uri: "Scene.TullyGalaxiesImages.Renderable", rank: 49, conds: { energy: 0.66, polyphony: 0.52 } },
  { name: "GalaxySuperclusters", uri: "Scene.GalaxySuperclusters.Renderable", rank: 52, conds: { energy: 0.72, polyphony: 0.56 } },
  { name: "AbellClusters", uri: "Scene.Abell.Renderable", rank: 55, conds: { energy: 0.76, polyphony: 0.60 } },
  { name: "Voids", uri: "Scene.Voids.Renderable", rank: 58, conds: { energy: 0.80, polyphony: 0.64 } },
  { name: "SloanDigitalSkySurvey", uri: "Scene.SloanDigitalSkySurvey.Renderable", rank: 61, conds: { energy: 0.84, polyphony: 0.68 } },

  // ---- the edge of the observable universe ------------------------
  { name: "COBE", uri: "Scene.COBE.Renderable", rank: 64, conds: { energy: 0.88, polyphony: 0.72, loudness: 0.70 } },
  { name: "WMAP", uri: "Scene.WMAP.Renderable", rank: 66, conds: { energy: 0.90, polyphony: 0.76, loudness: 0.74 } },
  { name: "Planck", uri: "Scene.Planck.Renderable", rank: 68, conds: { energy: 0.92, polyphony: 0.80, loudness: 0.78 } },
  { name: "Multiverse1", uri: "Scene.PlanckMultiverse1.Renderable", rank: 70, conds: { energy: 0.94, polyphony: 0.84, loudness: 0.82 } },
  { name: "Multiverse2", uri: "Scene.PlanckMultiverse2.Renderable", rank: 71, conds: { energy: 0.95, polyphony: 0.86, loudness: 0.84 } },
  { name: "Multiverse3", uri: "Scene.PlanckMultiverse3.Renderable", rank: 72, conds: { energy: 0.96, polyphony: 0.88, loudness: 0.86 } },
  { name: "Multiverse4", uri: "Scene.PlanckMultiverse4.Renderable", rank: 73, conds: { energy: 0.97, polyphony: 0.90, loudness: 0.88 } },
];

export const LAYER_PACE = 5.0;
export const PACE_MIN = 0.5;
export const PACE_MAX = 4.0;
export const FADE_IN = 1.8;
export const FADE_OUT = 3.0;
export const HOLD_AFTER_STOP = 10.0;
export const ENABLE_AT = 0.002;
export const LAYER_EPS = 0.004;
export const SCALAR_EPS = 0.25;

export const LABEL_SWEEPS = [
  "Scene.*.Renderable.Labels.Enabled",
  "Scene.*Label.Renderable.Enabled",
  "Scene.*Labels.Renderable.Enabled",
  "Scene.*LabelNear.Renderable.Enabled",
  "Scene.*_labels.Enabled",
  "Scene.StarLabelsAlternate.Renderable.Enabled",
  "Scene.MilkyWayGalaxyArmLabelsImage.Renderable.Enabled",
];

export const SCREEN_TEXT = [
  "RenderEngine.ShowLog",
  "RenderEngine.ShowVersion",
  "RenderEngine.ShowCamera",
];

export const SIZED = [
  "TullyGalaxies", "TullyImages", "GalaxySuperclusters", "AbellClusters",
  "Voids", "SloanDigitalSkySurvey", "NearbyGalaxyGroups",
  "LocalDwarfGalaxies", "TwoMASS", "SixdFGalaxies", "TwodFGalaxies",
  "Quasars", "DeepSkyObjects",
  "Exoplanets", "PlanetaryCandidates",
  "PlanetaryNebulae", "HIIRegions", "SupernovaRemnants",
  "OpenStarClusters", "GlobularClusters", "OBAssociations",
  "BrownDwarfs", "WhiteDwarfs", "Pulsars",
];

export const BAND_OF = {
  PlanetaryNebulae: "bandLow",
  HIIRegions: "bandLow",
  SupernovaRemnants: "bandLow",
  OpenStarClusters: "bandLow",
  GlobularClusters: "bandLow",
  OBAssociations: "bandLow",
  BrownDwarfs: "bandLow",
  WhiteDwarfs: "bandLow",
  Pulsars: "bandLow",

  Exoplanets: "bandMid",
  PlanetaryCandidates: "bandMid",
  DeepSkyObjects: "bandMid",
  LocalDwarfGalaxies: "bandMid",

  TwoMASS: "bandHigh",
  NearbyGalaxyGroups: "bandHigh",
  SixdFGalaxies: "bandHigh",
  TullyGalaxies: "bandHigh",
  TullyImages: "bandHigh",
  AbellClusters: "bandHigh",

  TwodFGalaxies: "treble",
  SloanDigitalSkySurvey: "treble",
  GalaxySuperclusters: "treble",
  Voids: "treble",
  Quasars: "treble",
};

export const SIZE_SOURCE = "loudness";
export const SIZE_MIN = 0.35;
export const SIZE_MAX = 0.7;
export const SIZE_LAG = 0.25;
export const TREBLE_BOOST = 1.6;
export const TREBLE_LAG = 0.07;
export const SIZE_CEILING = 95.0;

export const OPACITY_MIN = 0.25;
export const OPACITY_MAX = 1.0;
export const OPACITY_EPS = 0.02;

export const SCALARS = [];

export const RETARGET_URI = "NavigationHandler.OrbitalNavigator.RetargetAnchorInterpolationTime";
export const RETARGET_TIME = 20.0;

export const TIME_SOURCE = "density";
export const TIME_MIN = 1.0;
export const TIME_MAX = 604800.0;
export const TIME_GAIN = 1.2;
export const TIME_CURVE = 0.8;
export const TIME_BUILD_SECS = 60.0;
export const TIME_BUILD_SHARE = 0.45;
export const TIME_DECAY_SECS = 30.0;
export const TIME_LAG_UP = 0.9;
export const TIME_LAG_DOWN = 6.0;
export const TIME_CHORD_WINDOW = 0.055;
export const TIME_CHORD_WEIGHT = 0.12;
export const TIME_ONSET_WINDOW = 3.0;
export const TIME_ONSET_MAX = 12.0;
export const TIME_EPS = 0.04;
export const TIME_EVERY = 0.20;
export const TIME_INTERP = 0.45;

export const PROBE_TRIES = 4;
export const PROBE_TIMEOUT = 20.0;
export const PROBE_RETRY_WAIT = 4.0;

export const TRUCK_GAIN = 2.0;
export const ELEVATION_GAIN = 0.5;
export const ROLL_GAIN = 0.25;
export const ROLL_HZ = 0.07;
export const NOTE_KICK = 0.0;

export const SLOW_ELEVATION_GAIN = 0.08;
export const SLOW_ROLL_GAIN = 0.03;
export const SLOW_RETARGET_TIME = 40.0;
export const SLOW_ORBIT_RATE = 0.005;
export const SLOW_MAX_ROT = 0.06;

export const TOUR = [
  "Earth", "Moon", "Mercury", "Venus", "Mars",
  "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto",
];
export const TOUR_FINAL = "Sun";

export const ARRIVE = {
  Sun: 2.1e9,
  Earth: 1.9e7,
  Moon: 5.0e6,
  Mercury: 7.0e6,
  Venus: 1.8e7,
  Mars: 1.0e7,
  Jupiter: 2.1e8,
  Saturn: 1.8e8,
  Uranus: 7.5e7,
  Neptune: 7.5e7,
  Pluto: 3.5e6,
};

export const OUTWARD = "(outward)";

export const PITCH_BODY = {
  0: "Sun",
  1: "Mercury",
  2: "Venus",
  3: "Moon",
  4: "Earth",
  5: "Mars",
  6: "Jupiter",
  7: "Saturn",
  8: "Uranus",
  9: "Neptune",
  10: "Pluto",
  11: OUTWARD,
};

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const BASS_SPLIT = 35;
export const BASS_HOLD = 0.35;
export const BASS_REDIRECT = 1.0;

export const FOCUS_LOCK_NODE = "Moon";
export const ORBIT_RATE = 0.02;
export const LOCK_APPROACH = 20.0;
export const LOCK_EASE = 0.5;
export const LOCK_ARRIVED_GAP = 0.05;
export const LOCK_RATE_MAX = 3.0;

export const TOUR_MIDPOINT = 0.5;
export const TOUR_DWELL = 1.5;
export const TELEMETRY_EVERY = 0.12;
export const TELEMETRY_TIMEOUT = 2.0;

export const IDLE_FLOOR = 0.01;

export const DRIFT_TIME = 20.0;
export const DRIFT_MAX = 3.0;
export const DRIFT_AFTER = 2.0;
export const DRIFT_EASE = 0.5;
export const DRIFT_DEADBAND = 0.05;
export const DUTY = 0.5;

// ---------------------------------------------------------------------
// SuperCollider analysis defaults (openspace_piano.scd)
// ---------------------------------------------------------------------
export const HIST_WINDOW = 3.0;
export const DENSITY_MAX = 12.0;
export const CHORD_WINDOW = 0.055;
export const CHORD_WEIGHT = 0.12;
export const LOUD_DECAY = 0.975;
export const ENERGY_SMOOTH = 0.12;
export const POLY_MAX = 8;
export const TREBLE_SPLIT = 84;
export const BAND_LOW_MAX = 47;
export const BAND_MID_MAX = 71;
export const BAND_HIGH_MAX = 83;
export const TREBLE_DECAY = 0.955;
export const IC_WEIGHT = [0.0, 1.0, 0.7, 0.35, 0.25, 0.3, 0.85];

// ---------------------------------------------------------------------
// Songs, playback & demo (openspace_piano.scd)
// ---------------------------------------------------------------------
export const BUNDLED_SONGS = [
  "FlyMeToTheMoon.score",
  "LifeonMars.score",
  "Hans-Zimmer-Time-Inception.score",
  "InterstellarCornfieldChase.score",
  "Rocket-Man-2.score",
  "Space-Oddity.score",
  "A Sky Full of Stars.score",
];

export const VEL_TRIM = [["Rocket-Man", 0.5]];
export const FOCUS_LOCK_FOR = [["FlyMeToTheMoon", "Moon"]];

function demoArp(notes, dur, vel1, vel2 = vel1) {
  const last = Math.max(notes.length - 1, 1);
  return notes.map((note, i) => {
    const v = Math.min(1.0, Math.max(0.05, vel1 + (vel2 - vel1) * (i / last)));
    return { wait: dur, notes: [note], vel: v, hold: dur * 3 };
  });
}

function dup(arr, times) {
  const out = [];
  for (let i = 0; i < times; i++) out.push(...arr);
  return out;
}

export const DEMO_SCORE = [
  {
    label: "Earth    E in the bass, one voice, quiet",
    events: [
      { wait: 0, notes: [28], vel: 0.30, hold: 16 },
      { wait: 4, notes: [64], vel: 0.32, hold: 3 },
      { wait: 2, notes: [71], vel: 0.30, hold: 2 },
      { wait: 2, notes: [69], vel: 0.28, hold: 3 },
      { wait: 3, notes: [67], vel: 0.30, hold: 3 },
      { wait: 3, notes: [64], vel: 0.26, hold: 4 },
      { wait: 2, rest: true },
    ],
  },
  {
    label: "Moon     Eb, two voices moving",
    events: [
      { wait: 0, notes: [27], vel: 0.38, hold: 16 },
      { wait: 1.5, notes: [63, 70], vel: 0.40, hold: 1.5 },
      { wait: 1.5, notes: [67], vel: 0.36, hold: 1 },
      { wait: 1, notes: [70], vel: 0.38, hold: 1 },
      { wait: 1, notes: [72], vel: 0.42, hold: 1.5 },
      { wait: 1, notes: [70], vel: 0.36, hold: 1 },
      { wait: 2, notes: [67], vel: 0.34, hold: 2 },
      { wait: 2, notes: [63, 67, 70], vel: 0.44, hold: 3 },
      { wait: 3, notes: [65], vel: 0.36, hold: 2 },
      { wait: 2, notes: [63], vel: 0.34, hold: 3 },
      { wait: 1, rest: true },
    ],
  },
  {
    label: "Mars     F, triads, mezzo-forte",
    events: [
      { wait: 0, notes: [29], vel: 0.55, hold: 16 },
      { wait: 1, notes: [65, 69, 72], vel: 0.58, hold: 1 },
      { wait: 1, notes: [65, 69, 72], vel: 0.50, hold: 1 },
      { wait: 1, notes: [67, 70, 74], vel: 0.60, hold: 1 },
      { wait: 1, notes: [65, 69, 72], vel: 0.52, hold: 1 },
      { wait: 1, notes: [72], vel: 0.62, hold: 0.5 },
      { wait: 0.5, notes: [74], vel: 0.58, hold: 0.5 },
      { wait: 0.5, notes: [76], vel: 0.60, hold: 1 },
      { wait: 1, notes: [69, 72, 77], vel: 0.64, hold: 2 },
      { wait: 2, notes: [76], vel: 0.56, hold: 1 },
      { wait: 1, notes: [74], vel: 0.54, hold: 1 },
      { wait: 1, notes: [72, 77], vel: 0.62, hold: 2 },
      { wait: 2, notes: [70, 74], vel: 0.58, hold: 2 },
      { wait: 2, notes: [69], vel: 0.52, hold: 2 },
      { wait: 1, rest: true },
    ],
  },
  {
    label: "Jupiter  F#, sixteenth arpeggios",
    events: [
      { wait: 0, notes: [30], vel: 0.66, hold: 16 },
      ...demoArp(
        dup([66, 69, 73, 76, 81, 76, 73, 69, 66, 69, 73, 78, 83, 78, 73, 69], 4),
        0.25, 0.52, 0.72
      ),
    ],
  },
  {
    label: "Saturn   G, pedal down, wide chords",
    events: [
      { wait: 0, pedal: true },
      { wait: 0, notes: [31], vel: 0.75, hold: 14 },
      { wait: 2, notes: [67, 74, 79], vel: 0.78, hold: 6 },
      { wait: 2, notes: [71, 76, 83], vel: 0.72, hold: 6 },
      { wait: 2, notes: [69, 74, 81], vel: 0.80, hold: 6 },
      { wait: 2, notes: [67, 79, 86], vel: 0.85, hold: 8 },
      { wait: 4, notes: [74, 81, 88], vel: 0.82, hold: 6 },
      { wait: 4, pedal: false },
    ],
  },
  {
    label: "Neptune  A, first notes above C6",
    events: [
      { wait: 0, notes: [33], vel: 0.70, hold: 16 },
      { wait: 1, notes: [69, 76, 81], vel: 0.68, hold: 4 },
      { wait: 2, notes: [88], vel: 0.55, hold: 1 },
      { wait: 0.5, notes: [91], vel: 0.58, hold: 1 },
      { wait: 0.5, notes: [93], vel: 0.62, hold: 1.5 },
      { wait: 1, notes: [88], vel: 0.52, hold: 1 },
      { wait: 1, notes: [76, 81], vel: 0.60, hold: 3 },
      { wait: 2, notes: [93], vel: 0.66, hold: 1 },
      { wait: 0.5, notes: [96], vel: 0.70, hold: 1 },
      { wait: 0.5, notes: [100], vel: 0.74, hold: 2 },
      { wait: 1, notes: [93], vel: 0.60, hold: 1 },
      { wait: 1, notes: [81, 88], vel: 0.64, hold: 4 },
      { wait: 3, notes: [76], vel: 0.55, hold: 3 },
      { wait: 2, rest: true },
    ],
  },
  {
    label: "Pluto    Bb, cascade entirely above C6 -- the size explosion",
    events: [
      { wait: 0, pedal: true },
      { wait: 0, notes: [34], vel: 0.85, hold: 16 },
      { wait: 0.5, notes: [70, 77, 82], vel: 0.85, hold: 8 },
      ...demoArp(dup([86, 89, 93, 96, 101, 96, 93, 89], 15), 0.125, 0.78, 0.92),
      { wait: 0.5, pedal: false },
    ],
  },
  {
    label: "Outward  B, held, long diminuendo",
    events: [
      { wait: 0, pedal: true },
      { wait: 0, notes: [35], vel: 0.90, hold: 24 },
      { wait: 0, notes: [59, 66, 71, 78], vel: 0.88, hold: 22 },
      { wait: 2, notes: [83, 90], vel: 0.82, hold: 20 },
      ...demoArp(dup([86, 93, 98, 90, 96, 101], 12), 0.25, 0.75, 0.10),
      { wait: 0, pedal: false },
      { wait: 4, rest: true },
    ],
  },
  {
    label: "silence  everything fades, the camera comes to rest",
    events: [
      { wait: 16, rest: true },
    ],
  },
];

// ---------------------------------------------------------------------
// Shared formatting & math helpers
// ---------------------------------------------------------------------

export function smoothstep(x, a, b) {
  if (b <= a) return x >= b ? 1.0 : 0.0;
  const t = Math.min(1.0, Math.max(0.0, (x - a) / (b - a)));
  return t * t * (3.0 - 2.0 * t);
}

export function luaStr(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function luaNum(v) {
  if (!Number.isFinite(v)) v = 0.0;
  if (Object.is(v, -0) || v === 0) return "0";
  return Number(v.toPrecision(5)).toString();
}

export function formatSI(m) {
  if (m == null || !Number.isFinite(m)) return "";
  const au = 1.495978707e11;
  const ly = 9.4607e15;
  if (m >= 1e6 * ly) return `${(m / (1e6 * ly)).toFixed(2)} Mly`;
  if (m >= 1e3 * ly) return `${(m / (1e3 * ly)).toFixed(2)} kly`;
  if (m >= 0.5 * ly) return `${(m / ly).toFixed(2)} ly`;
  if (m >= 0.05 * au) return `${(m / au).toFixed(2)} AU`;
  if (m >= 1e6) return `${(m / 1e6).toFixed(0)} Mm`;
  return `${(m / 1e3).toFixed(0)} km`;
}

export function formatRate(d) {
  if (d == null || !Number.isFinite(d)) return "--";
  const a = Math.abs(d);
  const units = [
    ["y/s", 31557600.0],
    ["d/s", 86400.0],
    ["h/s", 3600.0],
    ["min/s", 60.0],
  ];
  for (const [unit, s] of units) {
    if (a >= s) return `${(d / s).toFixed(1)} ${unit}`;
  }
  return `x${Number(d.toPrecision(3))}`;
}

export function noteName(n) {
  if (n < 0 || n == null) return "--";
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}
