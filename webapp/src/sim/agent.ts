// PoopFly agent: the closed control loop.
//
//   physiology (World) --interoceptive encoding--> drive channels --spikes-->
//   Kernel (real MaleCNS LIF) --motor population activity--> WTA decode -->
//   action --consequence--> World --> homeostatic improvement --> dopamine -->
//   three-factor plasticity --> future behaviour.
//
// The neural readout, NOT any "if pressure>thr" rule, selects the action.
// Exploration noise is behavioural variability so the fly can *discover* the
// rewarded action; after that, reinforcement strengthens the active pathway.

import { ACTION_NAMES, DRIVE_CHANNELS, type SimConfig, type Snapshot, type ActionRate, type Vitals, type Metrics, type MusicState, type ExperimentResult } from "./protocol";
import { Kernel } from "./kernel";
import { World } from "./env";
import { selectPopulations, type PopGraph, type SelectedPops } from "./populations";

const PRIMARY = ["MOVE_LEFT", "MOVE_RIGHT", "MOVE_FORWARD", "STOP", "EAT", "DEFECATE"];
const MUSIC = ["PLAY_MUSIC", "STOP_MUSIC", "SONG_A", "SONG_B", "SONG_C"];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GraphArrays { N: number; outDeg: Int32Array; inDeg: Int32Array; ntCode: Uint8Array; }

export class Agent {
  k: Kernel; w: World; cfg: SimConfig; pop: SelectedPops;
  private rng: () => number;
  currentAction: string | null = null;
  musicAction: string | null = null;

  private actionCounts: Record<string, number> = {};
  private songPicks: Record<string, number> = {};
  private songDefec: Record<string, number> = {};
  timeToDefecateSeries: number[] = [];
  trials = 0; successPoops = 0;
  rewardEvents = 0; punishmentEvents = 0; dopaminePulses = 0;
  lastReward = 0; lastDopamine = 0;
  ablateIntero = false;
  private trialActive = false; private trialStart = 0;

  constructor(k: Kernel, cfg: SimConfig, g: GraphArrays) {
    this.k = k; this.cfg = cfg;
    const gp: PopGraph = { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode };
    this.pop = selectPopulations(gp, ACTION_NAMES as unknown as string[], DRIVE_CHANNELS as unknown as string[],
      cfg.action.popSize, cfg.input.populationSize);
    k.setActionPopulations(ACTION_NAMES as unknown as string[], this.pop.actions);
    k.setChannels(DRIVE_CHANNELS as unknown as string[]);
    for (const d of DRIVE_CHANNELS as unknown as string[]) k.setChannelPop(d, this.pop.drives[d]);
    this.w = new World(cfg.physio, cfg.music, cfg.dopamine, cfg.action.defecateRequiresToilet);
    this.rng = mulberry32(cfg.noise.seed ^ 0x9e3779b9);
    for (const a of [...PRIMARY, ...MUSIC]) this.actionCounts[a] = 0;
    for (const s of cfg.music.songs) { this.songPicks[s] = 0; this.songDefec[s] = 0; }
  }

  resetWorld(content: number) { this.w.reset(content); this.trialActive = false; }

  private encode() {
    if (this.ablateIntero) {
      this.k.setChannelDrive("PRESSURE", 0); this.k.setChannelDrive("HUNGER", 0);
      for (const s of this.cfg.music.songs) this.k.setChannelDrive("MUSIC_" + s, 0);
      return;
    }
    const e = this.cfg.encode, w = this.w;
    const p = Math.max(0, Math.min(1, w.pressure));
    const prate = e.pressureBaseHz + (e.pressureMaxHz - e.pressureBaseHz) * Math.pow(p, e.pressureExp);
    this.k.setChannelDrive("PRESSURE", prate);
    const hunger = e.hungerMaxHz * Math.max(0, 0.6 - w.energy) / 0.6;
    this.k.setChannelDrive("HUNGER", w.nearFood() ? hunger : hunger * 0.3);
    for (const s of this.cfg.music.songs) {
      this.k.setChannelDrive("MUSIC_" + s, w.currentSong === s ? e.musicSensoryHz : 0);
    }
  }

  private wta(rates: Map<string, number>, subset: string[]): string | null {
    if (this.rng() < this.cfg.action.explore) {
      const pick = subset[Math.floor(this.rng() * subset.length) % subset.length];
      return pick;
    }
    let best: string | null = null, bv = this.cfg.action.motorThresholdHz;
    for (const n of subset) { const r = rates.get(n) ?? 0; if (r > bv) { bv = r; best = n; } }
    return best;
  }

  private applyMusic(m: string | null) {
    const prev = this.musicAction;
    this.musicAction = m;
    if (m === "PLAY_MUSIC") { if (this.w.currentSong === null) this.w.setSong(this.cfg.music.songs[0]); }
    else if (m === "STOP_MUSIC") this.w.setSong(null);
    else if (m && m.startsWith("SONG_")) {
      const s = m.slice(5);
      this.w.setSong(s);
      if (m !== prev) { this.songPicks[s] = (this.songPicks[s] ?? 0) + 1; if (this.w.defecating) this.songDefec[s] = (this.songDefec[s] ?? 0) + 1; }
    }
  }

  step(dt: number): { ev: ReturnType<World["step"]> } {
    this.encode();
    this.k.step();
    const rates = new Map(this.k.getActionRates().map((a) => [a.name, a.rate] as const));
    const primary = this.wta(rates, PRIMARY);
    const music = this.wta(rates, MUSIC);
    this.currentAction = primary;
    const ev = this.w.step(dt, primary);
    this.applyMusic(music);
    this.k.setDopamine(ev.dopamine);
    this.lastReward = ev.reward; this.lastDopamine = ev.dopamine;
    this.record(primary, ev, dt);
    return { ev };
  }

  private record(primary: string | null, ev: { reward: number; dopamine: number; trialEnded: boolean; defecated?: boolean }, dt: number) {
    if (primary) this.actionCounts[primary] = (this.actionCounts[primary] ?? 0) + 1;
    if (ev.reward > 0.02) this.rewardEvents++; else if (ev.reward < -0.02) this.punishmentEvents++;
    if (Math.abs(ev.dopamine) > 0.05) this.dopaminePulses++;
    const p = this.w.pressure;
    if (!this.trialActive && p > 0.8) { this.trialActive = true; this.trialStart = this.k.tick; }
    // Every completed defecation counts as a successful poop (this is the number
    // the stage shows). Only pressure-triggered episodes count as measured trials.
    if (ev.defecated) this.successPoops++;
    if (ev.trialEnded) {
      if (this.trialActive) {
        const ms = (this.k.tick - this.trialStart) * dt * 1000;
        this.timeToDefecateSeries.push(ms); this.trials++;
      }
      this.trialActive = false;
      this.trialStart = this.k.tick;
    }
  }

  resetMetrics() {
    this.timeToDefecateSeries = []; this.trials = 0; this.successPoops = 0;
    this.rewardEvents = 0; this.punishmentEvents = 0; this.dopaminePulses = 0;
    for (const a of Object.keys(this.actionCounts)) this.actionCounts[a] = 0;
    for (const s of this.cfg.music.songs) { this.songPicks[s] = 0; this.songDefec[s] = 0; }
  }

  private simTrials(o: { plasticity: boolean; dopamineGain: number; intero: boolean; explore: number; trials: number; maxTicks: number }) {
    const dt = this.cfg.lif.dt / 1000;
    this.cfg.plasticity.enabled = o.plasticity; this.cfg.plasticity.mode = "three";
    this.cfg.deterministic = false; this.cfg.noise.enabled = false;
    this.cfg.dopamine.gain = o.dopamineGain; this.cfg.action.explore = o.explore; this.ablateIntero = o.intero;
    this.k.reset(); this.k.resetPlasticity(); this.resetMetrics();
    const times: number[] = []; let success = 0;
    const songTotals: Record<string, number> = {}; const songEarly: Record<string, number> = {}; const songLate: Record<string, number> = {};
    const half = Math.ceil(o.trials / 2);
    for (let t = 0; t < o.trials; t++) {
      const before: Record<string, number> = {}; for (const s of this.cfg.music.songs) before[s] = this.songPicks[s];
      this.resetWorld(0.85); const s0 = this.successPoops; const start = this.k.tick; let ok = false;
      for (let n = 0; n < o.maxTicks; n++) { this.step(dt); if (this.successPoops > s0) { ok = true; break; } }
      if (ok) { success++; times.push((this.k.tick - start) * dt * 1000); } else times.push(o.maxTicks * dt * 1000);
      for (const s of this.cfg.music.songs) {
        const d = this.songPicks[s] - before[s];
        songTotals[s] = (songTotals[s] ?? 0) + d;
        if (t < half) songEarly[s] = (songEarly[s] ?? 0) + d; else songLate[s] = (songLate[s] ?? 0) + d;
      }
    }
    const ps = this.k.plasticityStats();
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const firstHalf = mean(times.slice(0, half)), lastHalf = mean(times.slice(half));
    return { success, trials: o.trials, times, changedEdges: ps.changedEdges, potentiated: ps.potentiated,
      rewardEvents: this.rewardEvents, dopaminePulses: this.dopaminePulses, firstHalf, lastHalf,
      adaptation: lastHalf - firstHalf, songTotals, songEarly, songLate };
  }

  runExperiment(id: string, trials = 8): ExperimentResult {
    const save = { p: this.cfg.plasticity.enabled, mode: this.cfg.plasticity.mode, det: this.cfg.deterministic, g: this.cfg.dopamine.gain,
      ex: this.cfg.action.explore, noise: this.cfg.noise.enabled, intero: this.ablateIntero, maxTicks: 6000 };
    const maxT = save.maxTicks;
    const R = (label: string, note: string, summary: Record<string, number | string>): ExperimentResult => ({ id, label, note, summary });
    try {
      switch (id) {
        case "A": { const r = this.simTrials({ plasticity: false, dopamineGain: 6, intero: false, explore: 0.4, trials: 1, maxTicks: maxT }); return R("High gut pressure", "does the brain produce a defecation decision under interoceptive pressure?", { defecated: r.success > 0 ? "yes" : "no", timeToDefecateMs: Math.round(r.times[0] ?? 0), rewardEvents: r.rewardEvents, dopaminePulses: r.dopaminePulses }); }
        case "B": { const r = this.simTrials({ plasticity: true, dopamineGain: 6, intero: false, explore: 0.4, trials: 1, maxTicks: maxT }); return R("Defecation homeostasis", "defecation lowers pressure -> measurable homeostatic improvement", { defecated: r.success > 0 ? "yes" : "no", rewardEvents: r.rewardEvents, dopaminePulses: r.dopaminePulses, changedEdges: r.changedEdges }); }
        case "C": { const r = this.simTrials({ plasticity: true, dopamineGain: 0, intero: false, explore: 0.4, trials, maxTicks: maxT }); return R("No reward", "reinforcement gain 0 -> weights must not drift, no adaptation", { changedEdges: r.changedEdges, adaptationMs: Math.round(r.adaptation), success: `${r.success}/${trials}` }); }
        case "D": { const r = this.simTrials({ plasticity: true, dopamineGain: 6, intero: false, explore: 0.4, trials, maxTicks: maxT }); return R("Reward enabled", "reinforcement from relief -> plasticity", { changedEdges: r.changedEdges, firstHalfMs: Math.round(r.firstHalf), lastHalfMs: Math.round(r.lastHalf), adaptationMs: Math.round(r.adaptation), success: `${r.success}/${trials}` }); }
        case "E": { const r = this.simTrials({ plasticity: false, dopamineGain: 6, intero: false, explore: 0.4, trials, maxTicks: maxT }); return R("Plasticity OFF", "behaviour should not adapt across trials", { adaptationMs: Math.round(r.adaptation), firstHalfMs: Math.round(r.firstHalf), lastHalfMs: Math.round(r.lastHalf), success: `${r.success}/${trials}`, changedEdges: r.changedEdges }); }
        case "F": { const r = this.simTrials({ plasticity: true, dopamineGain: 6, intero: false, explore: 0.4, trials, maxTicks: maxT }); return R("Plasticity ON (learning)", "repeated trials -> decreasing time-to-defecate (behavioural adaptation)", { adaptationMs: Math.round(r.adaptation), firstHalfMs: Math.round(r.firstHalf), lastHalfMs: Math.round(r.lastHalf), success: `${r.success}/${trials}`, changedEdges: r.changedEdges, potentiated: r.potentiated }); }
        case "G": { const r = this.simTrials({ plasticity: true, dopamineGain: 6, intero: false, explore: 0.3, trials: Math.max(trials, 8), maxTicks: maxT }); const tot = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0) || 1; const sh = (o: Record<string, number>, k: string) => ((o[k] ?? 0) / tot(o)).toFixed(2); return R("Song preference", "learn to favour the pleasant song via dopaminergic consequence", { picksA: r.songTotals.A ?? 0, picksB: r.songTotals.B ?? 0, picksC: r.songTotals.C ?? 0, earlyAshare: sh(r.songEarly, "A"), lateAshare: sh(r.songLate, "A"), lateCshare: sh(r.songLate, "C") }); }
        case "H": { const r = this.simTrials({ plasticity: true, dopamineGain: 0, intero: false, explore: 0.4, trials, maxTicks: maxT }); return R("Ablate reinforcement", "cut the dopamine pathway -> learning impaired", { changedEdges: r.changedEdges, adaptationMs: Math.round(r.adaptation), success: `${r.success}/${trials}` }); }
        case "I": { const r = this.simTrials({ plasticity: true, dopamineGain: 6, intero: true, explore: 0.4, trials, maxTicks: maxT }); return R("Ablate interoception", "no gut-pressure signal to the brain -> little pressure-driven responding", { success: `${r.success}/${trials}`, rewardEvents: r.rewardEvents, adaptationMs: Math.round(r.adaptation) }); }
        default: return R(id, "unknown experiment", {});
      }
    } finally {
      this.cfg.plasticity.enabled = save.p; this.cfg.plasticity.mode = save.mode; this.cfg.deterministic = save.det; this.cfg.dopamine.gain = save.g;
      this.cfg.action.explore = save.ex; this.cfg.noise.enabled = save.noise; this.ablateIntero = save.intero;
    }
  }

  metrics(): Metrics {
    const ps = this.k.plasticityStats();
    const avg = this.timeToDefecateSeries.length ? this.timeToDefecateSeries.reduce((a, b) => a + b, 0) / this.timeToDefecateSeries.length : 0;
    return {
      trials: this.trials, successPoops: this.successPoops, avgTimeToDefecateMs: avg,
      timeToDefecateSeries: this.timeToDefecateSeries.slice(-40), actionCounts: this.actionCounts,
      rewardEvents: this.rewardEvents, punishmentEvents: this.punishmentEvents, dopaminePulses: this.dopaminePulses,
      weightChangeEvents: ps.changedEdges, songPicks: this.songPicks,
      interoFiringHz: this.k.driveFiringHz(), motorDriveHz: this.k.motorDriveHz(),
    };
  }

  snapshot(stats: Snapshot["stats"]): Snapshot {
    const w = this.w;
    const rates = this.k.getActionRates();
    const actionRates: ActionRate[] = rates.map((r) => ({ name: r.name, rate: r.rate, selected: r.name === this.currentAction || r.name === this.musicAction }));
    const vitals: Vitals = {
      position: w.position, gutContent: w.content, gutPressure: w.pressure, urge: w.pressure,
      comfort: w.comfort, energy: w.energy, hydration: w.hydration, state: w.state(),
      atToilet: w.atToilet(), nearFood: w.nearFood(), defecating: w.defecating,
    };
    const ps = this.k.plasticityStats();
    const music: MusicState = {
      current: w.currentSong,
      prefs: this.cfg.music.songs.map((s) => ({ song: s, value: this.cfg.music.valence[s] ?? 0, picks: this.songPicks[s] ?? 0, defecations: this.songDefec[s] ?? 0 })),
    };
    return {
      tick: this.k.tick, simMs: stats.simTimeMs, vitals, actionRates,
      currentAction: this.currentAction, reward: this.lastReward, dopamine: this.lastDopamine,
      music, plasticity: { enabled: this.cfg.plasticity.enabled && !this.cfg.deterministic, mode: this.cfg.plasticity.mode,
        changedEdges: ps.changedEdges, meanAbsDelta: ps.meanAbsDelta, maxAbsDelta: ps.maxAbsDelta,
        activeEligible: ps.activeEligible, potentiated: ps.potentiated, depressed: ps.depressed },
      metrics: this.metrics(), stats,
    };
  }
}
