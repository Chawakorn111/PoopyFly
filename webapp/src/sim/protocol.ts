// Shared message protocol + configuration types for the whole-MaleCNS simulator.
// These types are used by BOTH the main thread (React/Three.js) and the worker.

export type SimMode = "debug" | "partial_10000" | "partial_50000" | "partial_100000" | "core" | "full";

export const MODE_LABELS: Record<SimMode, string> = {
  debug: "DEBUG (~3k hubs)",
  partial_10000: "PARTIAL 10k",
  partial_50000: "PARTIAL 50k",
  partial_100000: "PARTIAL 100k",
  core: "FULL — MaleCNS neurons",
  full: "FULL+ — all segments (not only neurons)",
};

// ---------------------------------------------------------------------------
// LIF neuron model parameters. ALL are computational-model assumptions, not
// measured MaleCNS values (MaleCNS gives anatomy/connectivity, not kinetics).
// Defaults are biologically motivated for Drosophila CNS LIF neurons and are
// fully configurable at runtime.
// ---------------------------------------------------------------------------
export interface LifConfig {
  dt: number;          // integration timestep (ms)
  vRest: number;       // resting potential (mV)
  vThresh: number;     // spike threshold (mV)
  vReset: number;      // reset potential after spike (mV)
  tauM: number;        // membrane time constant (ms)
  tauSyn: number;      // synaptic current time constant (ms) — EPSPs leak with this, so they can summate
  tRef: number;        // absolute refractory period (ms)
  weightScale: number; // maps MaleCNS synapse-count weight -> mV of synaptic drive
  delayMs: number;     // synaptic transmission delay (ms); quantised to dt
}

// Per-neurotransmitter synaptic effect (signed multiplier on the male CNS
// weight). This is an explicit, configurable model mapping - NOT a receptor
// level biological model. Positive = excitatory, negative = inhibitory,
// small magnitude = modulatory.
export type NtEffect = Record<string, number>;

export interface PlasticityConfig {
  enabled: boolean;
  mode: "stdp" | "three";          // two-factor STDP or three-factor (eligibility x dopamine)
  aPlus: number;    // potentiation amplitude (STDP)
  aMinus: number;   // depression amplitude (STDP)
  tauPlus: number;  // potentiation window (ms)
  tauMinus: number; // depression window (ms)
  maxDelta: number; // clamp on learned delta (additive, in weight units)
  // three-factor parameters:
  eligDecayMs: number;
  preAmp: number;
  postAmp: number;
  eligCap: number;
  rewardGain: number;
  punishGain: number;
  weightMin: number;   // absolute lower bound of effective (base+delta)
  weightMax: number;   // absolute upper bound of effective (base+delta)
}

export interface NoiseConfig {
  enabled: boolean;
  amplitude: number; // std-dev of injected membrane noise (mV) per tick
  seed: number;      // RNG seed -> deterministic when fixed
}

export interface InputConfig {
  populationSize: number; // how many neurons of the population to drive
  rateHz: number;         // Poisson drive rate per input neuron
  durationMs: number;     // episode length
  latencyMs: number;      // delay before drive starts
  noise: number;          // extra jitter on spike timing
}

export interface ReadoutConfig {
  windowMs: number; // integration window for the decision
  noActionThresholdHz: number; // below this total rate -> NO_ACTION
}

// ---------------------------------------------------------------------------
// PoopFly: physiology / interoception / behaviour / music / dopamine.
// All are MODEL ASSUMPTIONS (configurable, documented) — see docs/ASSUMPTIONS.md.
// ---------------------------------------------------------------------------
export interface PhysioConfig {
  contentStart: number;    // initial gut fullness 0..1
  eatRate: number;         // gut_content per second while eating (neural EAT action)
  appetite: number;        // passive environmental gut fill rate (content/s)
  digestRate: number;      // slow background content loss
  defecateRate: number;    // gut_content per second while defecating
  defecateMinMs: number;   // minimum defecation duration
  movementSpeed: number;   // world units / second
  bounds: number;          // 1D track length
  toiletPos: number;       // toilet location on the track
  foodPos: number;         // food location on the track
  pressureGain: number;    // gut_content -> gut_pressure
  comfortRelief: number;   // comfort gain rate when pressure drops
}


export interface EncodeConfig {
  pressureBaseHz: number;  // firing rate at pressure 0
  pressureMaxHz: number;   // firing rate at pressure 1 (sustained)
  pressureExp: number;     // encoding nonlinearity exponent
  hungerMaxHz: number;
  musicSensoryHz: number;  // drive of a played song's sensory population
}

export interface ActionConfig {
  popSize: number;         // neurons per motor population
  motorThresholdHz: number;// min readout rate to select an action (winner-take-all)
  defecateRequiresToilet: boolean; // environment constraint
  explore: number;         // action-selection exploration probability (behavioural variability)
}

export interface MusicConfig {
  songs: string[];         // ['A','B','C']
  valence: Record<string, number>; // simulated hedonic consequence of each song
  contextDriveHz: number;  // extra intero-like drive while listening
}

export interface DopamineConfig {
  gain: number;            // dopamine = clip(gain * homeostatic_improvement)
  clip: number;            // +/- clamp
  windowMs: number;        // homeostatic error sampling window
}

export interface SimConfig {
  lif: LifConfig;
  ntEffect: NtEffect;
  plasticity: PlasticityConfig;
  noise: NoiseConfig;
  input: InputConfig;
  readout: ReadoutConfig;
  ticksPerFrame: number; // simulation speed (ticks advanced per ~16ms frame)
  deterministic: boolean; // disables noise + plasticity when true
  physio: PhysioConfig;
  encode: EncodeConfig;
  action: ActionConfig;
  music: MusicConfig;
  dopamine: DopamineConfig;
}

// Behavioural action + interoceptive drive channel identifiers.
export const ACTION_NAMES = [
  "MOVE_LEFT", "MOVE_RIGHT", "MOVE_FORWARD", "STOP", "EAT", "DEFECATE",
  "PLAY_MUSIC", "STOP_MUSIC", "SONG_A", "SONG_B", "SONG_C",
] as const;
export const DRIVE_CHANNELS = ["PRESSURE", "HUNGER", "MUSIC_A", "MUSIC_B", "MUSIC_C"] as const;
export type ActionName = typeof ACTION_NAMES[number];


export const NT_NAMES = ["ACh", "GABA", "Glu", "DA", "5HT", "OA", "HA", "UNKNOWN"] as const;

export const DEFAULT_CONFIG: SimConfig = {
  lif: {
    dt: 0.1,
    vRest: -60,
    vThresh: -46,
    vReset: -60,
    tauM: 8,
    tauSyn: 8,
    tRef: 2.5,
    weightScale: 0.05,
    delayMs: 1.0,
  },
  // Documented synaptic-effect mapping (see docs/ASSUMPTIONS.md):
  ntEffect: { ACh: 1.0, Glu: 1.0, GABA: -1.0, HA: -1.0, DA: 0.3, "5HT": 0.2, OA: 0.2, UNKNOWN: 0.5 },
  plasticity: {
    enabled: false, mode: "three",
    aPlus: 0.01, aMinus: 0.011, tauPlus: 20, tauMinus: 20, maxDelta: 2.0,
    eligDecayMs: 150, preAmp: 1, postAmp: 1, eligCap: 6, rewardGain: 0.9, punishGain: 0.6,
    weightMin: 0, weightMax: 8000,
  },
  noise: { enabled: false, amplitude: 0.3, seed: 20240101 },
  input: { populationSize: 96, rateHz: 120, durationMs: 120, latencyMs: 5, noise: 0.15 },
  readout: { windowMs: 150, noActionThresholdHz: 2 },
  ticksPerFrame: 40,
  deterministic: true,
  physio: {
    contentStart: 0.35, eatRate: 0.6, appetite: 0.05, digestRate: 0.004, defecateRate: 2.2, defecateMinMs: 250,
    movementSpeed: 1.5, bounds: 1.0, toiletPos: 0.7, foodPos: 0.2, pressureGain: 1.0, comfortRelief: 1.5,
  },
  encode: {
    pressureBaseHz: 3, pressureMaxHz: 160, pressureExp: 1.6, hungerMaxHz: 120, musicSensoryHz: 60,
  },
  action: { popSize: 16, motorThresholdHz: 4, defecateRequiresToilet: true, explore: 0.3 },
  music: { songs: ["A", "B", "C"], valence: { A: 0.6, B: 0.0, C: -0.5 }, contextDriveHz: 40 },
  dopamine: { gain: 6.0, clip: 1.0, windowMs: 120 },
};


// ---------------------------------------------------------------------------
// Runtime manifest (mirrors the JSON produced by the Python pipeline).
// ---------------------------------------------------------------------------
export interface Populations {
  INPUT_6: number[];
  INPUT_7: number[];
  READOUT_6: number[];
  READOUT_7: number[];
  NO_ACTION: number[];
}

export interface Manifest {
  format_version: number;
  mode: string;
  generated_at: string;
  dataset: string;
  counts_are_measured: boolean;
  neurons: number;
  edges: number;
  id_dtype: string;
  all_body_ids_fit_int32: boolean;
  endianness: string;
  files: Record<string, number>;
  nt_codes: Record<string, number>;
  nt_names: string[];
  region_codes: Record<string, number>;
  region_names: string[];
  populations: Populations;
  population_policy: string;
  integrity: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Worker <-> main messages
// ---------------------------------------------------------------------------
export type MainToWorker =
  | { type: "init"; baseUrl: string; mode: SimMode; config: SimConfig; manifest: Manifest }
  | { type: "start" }
  | { type: "stop" }
  | { type: "step"; n: number }
  | { type: "setConfig"; config: Partial<SimConfig> }
  | { type: "inject"; digit: 6 | 7 }
  | { type: "reset" }
  | { type: "selectNeuron"; index: number }
  | { type: "ablate"; kind: "neuron" | "region"; value: number }
  | { type: "restore" }
  | { type: "benchmark"; ticks: number }
  | { type: "setSpeed"; ticksPerFrame: number }
  | { type: "queryConnections"; index: number; direction: "out" | "in"; limit: number }
  | { type: "resetWorld" }
  | { type: "forceEat"; amount: number }
  | { type: "setPlasticity"; on: boolean; mode?: "stdp" | "three" }
  | { type: "runExperiment"; id: string; trials?: number };

export interface FrameStats {
  tick: number;
  simTimeMs: number;
  spikesThisFrame: number;
  spikesPerSec: number;       // network-wide
  activeNeurons: number;
  meanRateHz: number;
  realTimeFactor: number;     // simulated ms / wall-clock ms
  msPerTick: number;
  pendingEvents: number;
}

export interface ReadoutState {
  count6: number;
  count7: number;
  countNo: number;
  rate6Hz: number;
  rate7Hz: number;
  rateNoHz: number;
  decision: 6 | 7 | 0; // 0 = NO_ACTION / undecided
  confidence: number;
  windowMs: number;
}

export interface RegionStat {
  code: number;
  name: string;
  neurons: number;
  spikes: number;       // spikes within the last reporting window
  activeNeurons: number;
  rateHz: number;
}

export interface NeuronDetail {
  index: number;
  bodyId: string;
  nt: string;
  region: string;
  inDegree: number;
  outDegree: number;
  v: number;
  spikeCount: number;
  rateHz: number;
  lastSpikeTick: number;
  disabled: boolean;
  refractory: boolean;
}

export type WorkerToMain =
  | { type: "ready"; manifest: Manifest; memoryBytes: number; loadSeconds: number }
  | { type: "frame"; spikes: Int32Array; stats: FrameStats; readout: ReadoutState; regions: RegionStat[] | null }
  | { type: "snapshot"; snap: Snapshot }
  | { type: "experiment"; result: ExperimentResult }
  | { type: "neuron"; detail: NeuronDetail }
  | { type: "connections"; index: number; direction: "out" | "in"; partners: { index: number; bodyId: string; weight: number; nt: string; region: string }[] }
  | { type: "benchmark"; result: BenchmarkResult }
  | { type: "log"; msg: string }
  | { type: "error"; msg: string };

export interface BenchmarkResult {
  mode: SimMode;
  neurons: number;
  edges: number;
  initSeconds: number;
  ticks: number;
  wallSeconds: number;
  msPerTick: number;
  spikesPerTick: number;
  realTimeFactor: number;
  approxMemoryBytes: number;
  peakActiveNeurons: number;
}

// ---------------------------------------------------------------------------
// PoopFly closed-loop state pushed to the UI (all derived from real sim state)
// ---------------------------------------------------------------------------
export interface Vitals {
  position: number; gutContent: number; gutPressure: number; urge: number;
  comfort: number; energy: number; hydration: number;
  state: string; atToilet: boolean; nearFood: boolean; defecating: boolean;
}
export interface ActionRate { name: string; rate: number; selected: boolean; }
export interface MusicPref { song: string; value: number; picks: number; defecations: number; }
export interface MusicState { current: string | null; prefs: MusicPref[]; }
export interface PlasticityState {
  enabled: boolean; mode: string; changedEdges: number; meanAbsDelta: number;
  maxAbsDelta: number; activeEligible: number; potentiated: number; depressed: number;
}
export interface Metrics {
  trials: number; successPoops: number; avgTimeToDefecateMs: number;
  timeToDefecateSeries: number[]; actionCounts: Record<string, number>;
  rewardEvents: number; punishmentEvents: number; dopaminePulses: number;
  weightChangeEvents: number; songPicks: Record<string, number>;
  interoFiringHz: number; motorDriveHz: number;
}
export interface Snapshot {
  tick: number; simMs: number; vitals: Vitals; actionRates: ActionRate[];
  currentAction: string | null; reward: number; dopamine: number;
  music: MusicState; plasticity: PlasticityState; metrics: Metrics; stats: FrameStats;
}
export interface ExperimentResult {
  id: string; label: string; note: string; summary: Record<string, number | string>;
}

