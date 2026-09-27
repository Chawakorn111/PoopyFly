// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Kernel } from "../src/sim/kernel";
import { Agent } from "../src/sim/agent";
import { World } from "../src/sim/env";
import { makeGraph, loadGraph } from "./helpers";
import { DEFAULT_CONFIG, type SimConfig } from "../src/sim/protocol";

function cfg(over: any = {}): SimConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.deterministic = true; c.noise.enabled = false;
  c.plasticity.enabled = false; c.plasticity.mode = "three";
  c.action.popSize = 1; c.input.populationSize = 1; c.action.explore = 0;
  c.lif.weightScale = 0.4;
  c.physio = { ...c.physio, foodPos: 0, toiletPos: 0, contentStart: 0.9, appetite: 0, digestRate: 0, defecateRate: 4, defecateMinMs: 200 };
  c.music.valence = { A: 0.8, B: 0.0, C: -0.8 };
  Object.assign(c, over.cfg || {});
  return c;
}

function smallGraph(N = 60, fan = 6) {
  // deterministic dense-ish ring: every neuron -> next `fan` neurons, weight 3
  const pre: number[] = []; const post: number[] = []; const w: number[] = [];
  for (let i = 0; i < N; i++) for (let k = 1; k <= fan; k++) { pre.push(i); post.push((i + k) % N); w.push(3); }
  return makeGraph(Int32Array.from(pre), Int32Array.from(post), Float32Array.from(w), N);
}
const dt = () => DEFAULT_CONFIG.lif.dt / 1000;

describe("PoopFly causal chain (neural, not scripted)", () => {
  it("a chosen motor population's activity IS the action (drive it -> action selected)", () => {
    const g = smallGraph();
    const c = cfg();
    const k = new Kernel(g, c, { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] }, ["UNKNOWN"]);
    const a = new Agent(k, c, { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode });
    a.resetWorld(0);
    const defNeuron = a.pop.actions["DEFECATE"][0];
    // with pressure 0 nothing special; force the DEFECATE motor neurons to fire every tick
    for (let t = 0; t < 300; t++) { k.queueSpike(defNeuron); a.step(dt()); }
    expect(a.currentAction).toBe("DEFECATE");
    const rates = new Map(k.getActionRates().map((r) => [r.name, r.rate] as const));
    expect(rates.get("DEFECATE")!).toBeGreaterThan(0);
  });

  it("gut pressure alone (no motor activation) never hardcodes DEFECATE", () => {
    const g = smallGraph();
    const c = cfg();
    const k = new Kernel(g, c, { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] }, ["UNKNOWN"]);
    const a = new Agent(k, c, { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode });
    a.resetWorld(0.95); // very high pressure, but pressure only drives the intero CHANNEL
    for (let t = 0; t < 400; t++) a.step(dt());
    // pressure raised the interoceptive drive; the action (if any) came from readout rates
    const m = a.metrics();
    expect(m.interoFiringHz).toBeGreaterThan(0);
    // currentAction, if set, must be a real motor readout, not a thresholded pressure
    const rates = new Map(k.getActionRates().map((r) => [r.name, r.rate] as const));
    if (a.currentAction) expect((rates.get(a.currentAction) ?? 0)).toBeGreaterThanOrEqual(c.action.motorThresholdHz);
  });

  it("defecation lowers gut pressure and yields positive homeostatic reward (World unit)", () => {
    const c = cfg(); c.physio.defecateMinMs = 50; const w = new World(c.physio, c.music, c.dopamine, true);
    w.reset(0.5); const p0 = w.pressure;
    let maxDopa = 0, sumReward = 0, defecated = false;
    for (let t = 0; t < 4000; t++) { const ev = w.step(dt(), "DEFECATE"); sumReward += ev.reward; maxDopa = Math.max(maxDopa, ev.dopamine); if (ev.defecated) defecated = true; }
    expect(w.pressure).toBeLessThan(p0);           // relief
    expect(defecated).toBe(true);
    expect(sumReward).toBeGreaterThan(0);           // homeostatic improvement
    expect(maxDopa).toBeGreaterThan(0);             // dopamine-like reinforcement
  });

  it("defecation gated by environment: not at toilet -> no relief", () => {
    const c = cfg(); c.physio.toiletPos = 0.9; const w = new World(c.physio, c.music, c.dopamine, true);
    w.reset(0.9); w.position = 0.4; // far from toilet on the loop (0.5 either way)
    let defecated = false;
    for (let t = 0; t < 400; t++) defecated = defecated || w.step(dt(), "DEFECATE").defecated;
    expect(defecated).toBe(false);
  });
});

describe("Three-factor plasticity (dopamine-gated)", () => {
  function plasticGraph() {
    // 0 -> 1 single edge (CSR slot e=0)
    return makeGraph(Int32Array.from([0]), Int32Array.from([1]), Float32Array.from([4]), 2);
  }
  it("coactive pre+post synapse is potentiated when dopamine > 0", () => {
    const c = cfg(); c.deterministic = false; c.plasticity.enabled = true;
    const g = plasticGraph();
    const k = new Kernel(g, c, { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] }, ["UNKNOWN"]);
    k.queueSpike(0); k.step();        // pre fires -> eligibility on edge 0 (and incoming of 0)
    k.queueSpike(1); k.step();        // post fires -> eligibility
    k.setDopamine(1);
    k.step(); k.step();
    expect(k.deltaOf(0)).toBeGreaterThan(0);
    expect(k.plasticityStats().changedEdges).toBeGreaterThan(0);
    expect(k.potentiated).toBeGreaterThan(0);
  });

  it("with dopamine = 0 (ablate reinforcement) nothing changes", () => {
    const c = cfg(); c.deterministic = false; c.plasticity.enabled = true;
    const g = plasticGraph();
    const k = new Kernel(g, c, { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] }, ["UNKNOWN"]);
    k.queueSpike(0); k.step(); k.queueSpike(1); k.step();
    k.setDopamine(0); k.step(); k.step();
    expect(k.deltaOf(0)).toBe(0);
    expect(k.plasticityStats().changedEdges).toBe(0);
  });
});

describe("Music learning signal", () => {
  it("a pleasant song during defecation produces more dopamine than an aversive one", () => {
    const c = cfg();
    const run = (song: string) => {
      const w = new World(c.physio, { ...c.music, valence: { A: 0.9, B: 0, C: -0.9 } }, c.dopamine, false);
      w.reset(0.9); let dopa = 0;
      for (let t = 0; t < 300; t++) { w.setSong(song); dopa = Math.max(dopa, w.step(dt(), "DEFECATE").dopamine); }
      return dopa;
    };
    expect(run("A")).toBeGreaterThan(run("C"));
  });
});

describe("Determinism", () => {
  it("same seed + config -> identical behaviour trace", () => {
    const mk = () => {
      const g = smallGraph(); const c = cfg(); c.action.explore = 0.3; c.deterministic = true;
      const k = new Kernel(g, c, { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] }, ["UNKNOWN"]);
      const a = new Agent(k, c, { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode });
      a.resetWorld(0.9); const acts: string[] = [];
      for (let t = 0; t < 2000; t++) { a.step(dt()); acts.push(a.currentAction ?? "-"); }
      return acts.join(",");
    };
    expect(mk()).toBe(mk());
  });
});

describe("Real-data wiring (debug mode)", () => {
  it("PoopFly agent wires on the actual MaleCNS graph and runs a full trial", () => {
    const { g } = loadGraph("debug");
    const c = cfg(); c.action.explore = 0.5; c.deterministic = true;
    const pops = { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] };
    const k = new Kernel(g, c, pops, ["UNKNOWN"]);
    const a = new Agent(k, c, { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode });
    expect(Object.keys(a.pop.actions).length).toBe(11);
    expect(a.pop.drives.PRESSURE.length).toBeGreaterThan(0);
    a.resetWorld(0.95);
    for (let t = 0; t < 6000; t++) a.step(dt());
    const m = a.metrics();
    expect(m.interoFiringHz).toBeGreaterThan(0);
    // behaviour is produced by the connectome; total spikes must be >0 (real activity)
    expect(k.totalSpikes()).toBeGreaterThan(0);
  });
});
