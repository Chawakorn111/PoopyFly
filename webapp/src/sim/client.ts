// Main-thread client wrapping the simulation Web Worker.
// Fetches the manifest, boots the worker, and routes compact messages.

import type {
  Manifest, SimConfig, SimMode, FrameStats, ReadoutState, RegionStat,
  NeuronDetail, BenchmarkResult, WorkerToMain, Snapshot, ExperimentResult,
} from "./protocol";
import { DEFAULT_CONFIG } from "./protocol";

export const DATA_BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export interface SimClientCallbacks {
  onReady?(manifest: Manifest, memoryBytes: number, loadSeconds: number): void;
  onFrame?(spikes: Int32Array, stats: FrameStats, readout: ReadoutState, regions: RegionStat[] | null): void;
  onSnapshot?(snap: Snapshot): void;
  onExperiment?(result: ExperimentResult): void;
  onNeuron?(d: NeuronDetail): void;
  onConnections?(index: number, direction: "out" | "in", partners: { index: number; bodyId: string; weight: number; nt: string; region: string }[]): void;
  onBenchmark?(r: BenchmarkResult): void;
  onLog?(msg: string): void;
  onError?(msg: string): void;
}


export async function fetchManifest(mode: SimMode): Promise<Manifest> {
  const r = await fetch(`${DATA_BASE}/data/${mode}/manifest.json`);
  if (!r.ok) throw new Error(`manifest ${mode}: ${r.status}`);
  return await r.json();
}

export async function fetchPositions(mode: SimMode, n: number): Promise<Float32Array> {
  const r = await fetch(`${DATA_BASE}/data/${mode}/neurons.pos.f32.bin`);
  if (!r.ok) throw new Error(`positions ${mode}: ${r.status}`);
  const buf = await r.arrayBuffer();
  const arr = new Float32Array(buf);
  if (arr.length !== n * 3) throw new Error(`positions length ${arr.length} != ${n * 3}`);
  return arr;
}

export interface NeuronArrays {
  pos: Float32Array; nt: Uint8Array; region: Uint16Array; bodyIds: BigInt64Array;
  inDeg: Int32Array; outDeg: Int32Array;
}
export async function fetchNeuronArrays(mode: SimMode, n: number): Promise<NeuronArrays> {
  const b = (f: string) => fetch(`${DATA_BASE}/data/${mode}/${f}`).then((r) => r.arrayBuffer());
  const [pos, nt, region, bodyId, deg] = await Promise.all([
    b("neurons.pos.f32.bin"), b("neurons.nt.u8.bin"), b("neurons.region.u16.bin"),
    b("neurons.bodyid.i64.bin"), b("neurons.deg.i32.bin"),
  ]);
  const p = new Float32Array(pos);
  if (p.length !== n * 3) throw new Error(`positions length ${p.length} != ${n * 3}`);
  const d = new Int32Array(deg);
  const inDeg = new Int32Array(n), outDeg = new Int32Array(n);
  for (let i = 0; i < n; i++) { inDeg[i] = d[2 * i]; outDeg[i] = d[2 * i + 1]; }
  return { pos: p, nt: new Uint8Array(nt), region: new Uint16Array(region),
    bodyIds: new BigInt64Array(bodyId), inDeg, outDeg };
}

export class SimClient {
  private worker: Worker;
  private cb: SimClientCallbacks;
  manifest: Manifest | null = null;
  ready = false;

  constructor(cb: SimClientCallbacks) {
    this.cb = cb;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.route(e.data);
    this.worker.onerror = (ev) => this.cb.onError?.(`worker error: ${ev.message}`);
  }

  private route(m: WorkerToMain) {
    switch (m.type) {
      case "ready": this.ready = true; this.manifest = m.manifest; this.cb.onReady?.(m.manifest, m.memoryBytes, m.loadSeconds); break;
      case "frame": this.cb.onFrame?.(m.spikes, m.stats, m.readout, m.regions); break;
      case "snapshot": this.cb.onSnapshot?.(m.snap); break;
      case "experiment": this.cb.onExperiment?.(m.result); break;
      case "neuron": this.cb.onNeuron?.(m.detail); break;
      case "connections": this.cb.onConnections?.(m.index, m.direction, m.partners); break;
      case "benchmark": this.cb.onBenchmark?.(m.result); break;
      case "log": this.cb.onLog?.(m.msg); break;
      case "error": this.ready = false; this.cb.onError?.(m.msg); break;
    }
  }

  async init(mode: SimMode, config: Partial<SimConfig> = {}) {
    this.ready = false;
    const manifest = await fetchManifest(mode);
    this.manifest = manifest;
    const cfg: SimConfig = { ...DEFAULT_CONFIG, ...config } as SimConfig;
    this.worker.postMessage({ type: "init", baseUrl: DATA_BASE, mode, config: cfg, manifest });
  }

  start() { this.worker.postMessage({ type: "start" }); }
  stop() { this.worker.postMessage({ type: "stop" }); }
  step(n = 1) { this.worker.postMessage({ type: "step", n }); }
  reset() { this.worker.postMessage({ type: "reset" }); }
  inject(digit: 6 | 7) { this.worker.postMessage({ type: "inject", digit }); }
  setConfig(config: Partial<SimConfig>) { this.worker.postMessage({ type: "setConfig", config }); }
  setSpeed(ticksPerFrame: number) { this.worker.postMessage({ type: "setSpeed", ticksPerFrame }); }
  selectNeuron(index: number) { this.worker.postMessage({ type: "selectNeuron", index }); }
  ablate(kind: "neuron" | "region", value: number) { this.worker.postMessage({ type: "ablate", kind, value }); }
  restore() { this.worker.postMessage({ type: "restore" }); }
  queryConnections(index: number, direction: "out" | "in", limit = 64) {
    this.worker.postMessage({ type: "queryConnections", index, direction, limit });
  }
  benchmark(ticks = 2000) { this.worker.postMessage({ type: "benchmark", ticks }); }
  resetWorld() { this.worker.postMessage({ type: "resetWorld" }); }
  forceEat(amount: number) { this.worker.postMessage({ type: "forceEat", amount }); }
  setPlasticity(on: boolean, mode: "stdp" | "three" = "three") { this.worker.postMessage({ type: "setPlasticity", on, mode }); }
  runExperiment(id: string, trials = 8) { this.worker.postMessage({ type: "runExperiment", id, trials }); }

  terminate() { this.worker.terminate(); }
}
