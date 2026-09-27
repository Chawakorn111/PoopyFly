// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Kernel } from "../src/sim/kernel";
import { loadGraph, makeGraph, DATA } from "./helpers";
import type { Populations } from "../src/sim/protocol";
import { DEFAULT_CONFIG } from "../src/sim/protocol";

const NOPOPS: Populations = { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] };

describe("MaleCNS graph integrity (real processed data)", () => {
  const { g, neurons, edges, bodyIds } = loadGraph("debug");
  const man = JSON.parse(readFileSync(join(DATA, "debug", "manifest.json"), "utf8"));
  const k = new Kernel(g, DEFAULT_CONFIG, man.populations, man.region_names);

  it("loads the measured neuron/edge counts (not theoretical)", () => {
    expect(neurons).toBe(man.neurons);
    expect(edges).toBe(man.edges);
    expect(neurons).toBeGreaterThan(100);
    expect(edges).toBeGreaterThan(1000);
  });

  it("preserves unique MaleCNS body ids for every runtime index", () => {
    expect(new Set(Array.from(bodyIds, (b) => String(b))).size).toBe(neurons);
    for (const b of [0, 1, neurons >> 1, neurons - 1]) {
      expect(Number(bodyIds[b])).toBeGreaterThan(0);
    }
  });

  it("runtime index -> body id -> correct outgoing edges (CSR)", () => {
    const i = 5;
    const lo = g.indptr[i], hi = g.indptr[i + 1];
    expect(hi - lo).toBe(g.outDeg[i]);
    const conns = k.connections(i, "out", 10000);
    expect(conns.length).toBe(hi - lo);
    for (let c = 0; c < conns.length; c++) {
      expect(conns[c].index).toBe(g.indices[lo + c]);
      expect(conns[c].index).toBeGreaterThanOrEqual(0);
      expect(conns[c].index).toBeLessThan(neurons);
      expect(conns[c].weight).toBeGreaterThan(0);
    }
  });

  it("incoming edges (CSC) are consistent and reversible", () => {
    const j = 7;
    const rlo = g.indptrR[j], rhi = g.indptrR[j + 1];
    expect(rhi - rlo).toBe(g.inDeg[j]);
    // every incoming source must list j among its outgoing targets
    for (let c = rlo; c < Math.min(rhi, rlo + 5); c++) {
      const src = g.indicesR[c];
      const fwd = g.rev2fwd[c];
      expect(g.indices[fwd]).toBe(j);
      const lo = g.indptr[src], hi = g.indptr[src + 1];
      let found = false;
      for (let p = lo; p < hi; p++) if (g.indices[p] === j) found = true;
      expect(found).toBe(true);
    }
  });

  it("a forced real spike propagates through the actual connectome", () => {
    const startSpikes = k.totalSpikes();
    // pick a neuron with outgoing edges
    let src = 0;
    for (let i = 0; i < neurons; i++) if (g.outDeg[i] > 5) { src = i; break; }
    k.queueSpike(src);
    for (let t = 0; t < 30; t++) k.step();
    expect(k.totalSpikes()).toBeGreaterThan(startSpikes);
  });
});

describe("FULL mode loads the complete processed graph", () => {
  const man = JSON.parse(readFileSync(join(DATA, "full", "manifest.json"), "utf8"));
  it("manifest reports the measured full-scale counts", () => {
    expect(man.mode).toBe("full");
    expect(man.neurons).toBe(1745204);          // measured (not 166,700 theoretical)
    expect(man.edges).toBe(32751675);           // measured (not 25,582,938 theoretical)
    expect(man.integrity.connectome_validation.filtered_edges).toBe(119105009);
  });
  it("binary files exactly encode that complete graph (sizes, without loading)", () => {
    const dir = join(DATA, "full");
    const sz = (f: string) => statSync(join(dir, f)).size;
    expect(sz("graph.indptr.u32.bin")).toBe((man.neurons + 1) * 4);
    expect(sz("graph.indices.i32.bin")).toBe(man.edges * 4);
    expect(sz("graph.weights.f32.bin")).toBe(man.edges * 4);
    expect(sz("neurons.bodyid.i64.bin")).toBe(man.neurons * 8);
    // last indptr entry == E: read only the final 4 bytes
    const fd = readFileSync(join(dir, "graph.indptr.u32.bin"));
    expect(fd.readUInt32LE((man.neurons) * 4)).toBe(man.edges);
  });
});

describe("Input does not directly determine output", () => {
  // synthetic: INPUT_6 -> [0] -w-> [2]=READOUT_6 ; INPUT_7 -> [1] -w-> [3]=READOUT_7
  const pre = Int32Array.from([0, 1]);
  const post = Int32Array.from([2, 3]);
  const w = Float32Array.from([60, 60]);
  const g = makeGraph(pre, post, w, 5);
  const pops: Populations = { INPUT_6: [0], INPUT_7: [1], READOUT_6: [2], READOUT_7: [3], NO_ACTION: [4] };
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.deterministic = true; cfg.noise.enabled = false;
  cfg.lif = { dt: 0.1, vRest: 0, vThresh: 1, vReset: 0, tauM: 1, tRef: 0.2, weightScale: 1, delayMs: 0.2 };
  cfg.input = { populationSize: 4, rateHz: 400, durationMs: 200, latencyMs: 2, noise: 0 };
  cfg.readout = { windowMs: 100, noActionThresholdHz: 0.5 };

  const drive = (digit: 6 | 7) => {
    const k = new Kernel(g, cfg, pops, ["UNKNOWN"]);
    k.inject(digit);
    for (let t = 0; t < 3000; t++) k.step();
    return k.getReadout();
  };

  it("injecting 6 vs 7 produces DIFFERENT neural activity signatures", () => {
    const r6 = drive(6), r7 = drive(7);
    expect(r6.rate6Hz + r6.rate7Hz).toBeGreaterThan(0);
    // activity is population-specific: 6 lights READOUT_6, 7 lights READOUT_7
    expect(r6.rate6Hz).toBeGreaterThan(r6.rate7Hz);
    expect(r7.rate7Hz).toBeGreaterThan(r7.rate6Hz);
  });

  it("the decision is computed from readout activity", () => {
    expect(drive(6).decision).toBe(6);
    expect(drive(7).decision).toBe(7);
  });

  it("with no input the network does not emit a forced answer", () => {
    const k = new Kernel(g, cfg, pops, ["UNKNOWN"]);
    for (let t = 0; t < 200; t++) k.step();
    expect(k.getReadout().decision).toBe(0);
  });
});
