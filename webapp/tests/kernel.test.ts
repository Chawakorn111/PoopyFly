// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Kernel } from "../src/sim/kernel";
import { makeGraph, testConfig } from "./helpers";
import type { Populations } from "../src/sim/protocol";

const NOPOPS: Populations = { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] };

function newKernel(pre: number[], post: number[], w: number[], N: number, nt?: Uint8Array, lif?: any) {
  const g = makeGraph(Int32Array.from(pre), Int32Array.from(post), Float32Array.from(w), N, nt);
  return new Kernel(g, testConfig(lif), NOPOPS, ["UNKNOWN"]);
}
const ls = (k: Kernel) => (k as any).lastSpike as Int32Array;
const sc = (k: Kernel) => (k as any).spikeCount as Int32Array;

describe("LIF neuron dynamics", () => {
  it("subthreshold input does not spike the target", () => {
    const k = newKernel([0], [1], [0.5], 2); // weight*effect = 0.5 < threshold 1
    k.queueSpike(0);
    for (let t = 0; t < 20; t++) k.step();
    expect(ls(k)[1]).toBeLessThan(0); // never fired
    expect(sc(k)[1]).toBe(0);
  });

  it("suprathreshold input crosses threshold, fires and resets", () => {
    const k = newKernel([0], [1], [50], 2);
    k.queueSpike(0);
    for (let t = 0; t < 5; t++) k.step();
    expect(ls(k)[1]).toBeGreaterThan(0); // fired after the delay
    expect((k as any).V[1]).toBeLessThanOrEqual(0); // at/under reset (not still spiking high)
  });

  it("refractory period blocks an immediate re-spike", () => {
    const k = newKernel([0], [1], [50], 2, undefined, { tRef: 5 }); // 50 ticks refractory
    k.queueSpike(0); k.step();               // tick0 fires neuron0
    expect(ls(k)[0]).toBe(0);
    k.queueSpike(0); k.step();               // tick1 tries again during refractory
    expect(ls(k)[0]).toBe(0);                // unchanged
    expect(sc(k)[0]).toBe(1);                // still exactly one spike
  });
});

describe("Synaptic delay", () => {
  it("a spike affects its target only after the configured delay", () => {
    const k = newKernel([0], [1], [50], 2, undefined, { delayMs: 0.5 }); // 5 ticks
    k.queueSpike(0);
    for (let t = 0; t < 5; t++) { k.step(); expect(ls(k)[1]).toBeLessThan(0); } // ticks 0..4
    k.step(); // tick5 -> delivered, target fires
    expect(ls(k)[1]).toBeGreaterThan(0);
  });
});

describe("Neurotransmitter effect", () => {
  it("an inhibitory source hyperpolarises the target (no spike)", () => {
    const nt = new Uint8Array([1, 0]); // neuron0 = GABA (index 1)
    const c = testConfig(); c.ntEffect["GABA"] = -1;
    const g = makeGraph(Int32Array.from([0]), Int32Array.from([1]), Float32Array.from([50]), 2, nt);
    const k = new Kernel(g, c, NOPOPS, ["UNKNOWN"]);
    k.queueSpike(0);
    for (let t = 0; t < 8; t++) k.step();
    expect(ls(k)[1]).toBeLessThan(0);
    expect(k.getV(1)).toBeLessThanOrEqual(0);
  });
});

describe("Determinism", () => {
  it("two runs with identical params + noise seed produce identical spike counts", () => {
    const N = 6;
    const pre = Int32Array.from([0, 1, 2, 3, 4, 5, 0, 2]);
    const post = Int32Array.from([1, 2, 3, 4, 5, 0, 3, 5]);
    const w = Float32Array.from([9, 9, 9, 9, 9, 9, 4, 4]);
    const run = () => {
      const c = testConfig({}); c.deterministic = false; c.noise = { enabled: true, amplitude: 0.5, seed: 42 };
      const k = new Kernel(makeGraph(pre, post, w, N), c, NOPOPS, ["UNKNOWN"]);
      k.queueSpike(0);
      for (let t = 0; t < 60; t++) k.step();
      return k.totalSpikes();
    };
    expect(run()).toBe(run());
  });
});

describe("Lazy reverse graph", () => {
  it("is inert until attached, then enables incoming edges and post-side plasticity", () => {
    const g = makeGraph(Int32Array.from([0, 1]), Int32Array.from([1, 0]), Float32Array.from([4, 4]), 2);
    const indptrR = g.indptrR!, indicesR = g.indicesR!, rev2fwd = g.rev2fwd!;
    // simulate the worker path: the forward graph arrives without the reverse half
    delete g.indptrR; delete g.indicesR; delete g.rev2fwd;

    const c = testConfig({});
    c.deterministic = false; c.plasticity.enabled = true; c.plasticity.mode = "three";
    const k = new Kernel(g, c, NOPOPS, ["UNKNOWN"]);

    expect(k.reverseReady()).toBe(false);
    expect(k.connections(0, "in", 8)).toEqual([]);      // nothing to walk yet
    k.queueSpike(0); k.step();                           // must not throw

    k.setReverseGraph(indptrR, indicesR, rev2fwd);
    expect(k.reverseReady()).toBe(true);
    expect(k.connections(0, "in", 8).length).toBeGreaterThan(0);
  });
});
