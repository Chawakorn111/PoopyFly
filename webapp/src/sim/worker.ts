// Simulation Web Worker — PoopFly closed loop.
//
// Owns the whole-brain kernel + the environment/agent loop. The main thread only
// ever receives compact messages: spike indices (for the renderer), and
// throttled Snapshots (physiology, motor readout, behaviour, reward/dopamine,
// music preference, plasticity stats, metrics). The full neural state never
// crosses to React.

import { Kernel, type GraphData } from "./kernel";
import { Agent } from "./agent";
import type {
  MainToWorker, WorkerToMain, Manifest, SimConfig, FrameStats, BenchmarkResult, Snapshot,
} from "./protocol";
import { DEFAULT_CONFIG } from "./protocol";

const ctx = self as unknown as {
  postMessage(msg: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MainToWorker>) => void) | null;
};

const SPIKE_TRANSFER_CAP = 250_000;
const SNAP_EVERY_FRAMES = 5;

let kernel: Kernel | null = null;
let agent: Agent | null = null;
let manifest: Manifest | null = null;
// a single mutable config object shared by kernel + world so UI edits apply live
const config: SimConfig = structuredClone(DEFAULT_CONFIG);
let running = false;
let frameTimer: ReturnType<typeof setTimeout> | null = null;
let loadSeconds = 0;
let frameIdx = 0;
let ticksSinceRegion = 0;
let frameBuf = new Int32Array(1024);

function post(msg: WorkerToMain, transfer?: Transferable[]) {
  if (transfer) ctx.postMessage(msg, transfer); else ctx.postMessage(msg);
}

async function fetchBuf(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status} ${r.statusText}`);
  return await r.arrayBuffer();
}

function mergeConfig(patch: Partial<SimConfig>) {
  if (patch.lif) Object.assign(config.lif, patch.lif);
  if (patch.ntEffect) Object.assign(config.ntEffect, patch.ntEffect);
  if (patch.plasticity) Object.assign(config.plasticity, patch.plasticity);
  if (patch.noise) Object.assign(config.noise, patch.noise);
  if (patch.input) Object.assign(config.input, patch.input);
  if (patch.readout) Object.assign(config.readout, patch.readout);
  if (patch.physio) Object.assign(config.physio, patch.physio);
  if (patch.encode) Object.assign(config.encode, patch.encode);
  if (patch.action) Object.assign(config.action, patch.action);
  if (patch.music) Object.assign(config.music, patch.music);
  if (patch.dopamine) Object.assign(config.dopamine, patch.dopamine);
  if (patch.ticksPerFrame !== undefined) config.ticksPerFrame = patch.ticksPerFrame;
  if (patch.deterministic !== undefined) config.deterministic = patch.deterministic;
}

async function loadGraph(base: string, mode: string, man: Manifest): Promise<GraphData> {
  const u = (n: string) => `${base}/data/${mode}/${n}`;
  const N = man.neurons, E = man.edges;
  const [indptr, indices, weights, indptrR, indicesR, rev2fwd, bodyid, nt, region, deg] =
    await Promise.all([
      fetchBuf(u("graph.indptr.u32.bin")), fetchBuf(u("graph.indices.i32.bin")), fetchBuf(u("graph.weights.f32.bin")),
      fetchBuf(u("graph_r.indptr.u32.bin")), fetchBuf(u("graph_r.indices.i32.bin")), fetchBuf(u("graph_r.rev2fwd.i32.bin")),
      fetchBuf(u("neurons.bodyid.i64.bin")), fetchBuf(u("neurons.nt.u8.bin")), fetchBuf(u("neurons.region.u16.bin")),
      fetchBuf(u("neurons.deg.i32.bin")),
    ]);
  const degArr = new Int32Array(deg);
  const inDeg = new Int32Array(N), outDeg = new Int32Array(N);
  for (let i = 0; i < N; i++) { inDeg[i] = degArr[2 * i]; outDeg[i] = degArr[2 * i + 1]; }
  const g: GraphData = {
    N, E,
    indptr: new Uint32Array(indptr), indices: new Int32Array(indices), baseW: new Float32Array(weights),
    indptrR: new Uint32Array(indptrR), indicesR: new Int32Array(indicesR), rev2fwd: new Int32Array(rev2fwd),
    ntCode: new Uint8Array(nt), region: new Uint16Array(region), bodyIds: new BigInt64Array(bodyid), inDeg, outDeg,
  };
  if (g.indptr[N] !== E) throw new Error(`indptr[N]=${g.indptr[N]} != E=${E}`);
  return g;
}

// Mean synapses-per-neuron (mean in-degree x mean edge weight) measures how much
// total synaptic drive a typical neuron can receive. The dataset subsets differ
// by ~20x on this number, so we calibrate the per-synapse gain to a reference
// operating point; without it the sparse graphs (FULL+) never reach threshold.
// Only ever boosts (never weakens) a dataset that is already excitable.
const REF_MEAN_IN_WEIGHT = 520;   // where the tuned DEFAULT_CONFIG weightScale runs healthy
function calibrationGain(g: GraphData): number {
  if (g.N === 0 || g.E === 0) return 1;
  let sum = 0;
  for (let k = 0; k < g.E; k++) sum += g.baseW[k];
  const meanInWeight = (g.E / g.N) * (sum / g.E);
  if (!(meanInWeight > 0)) return 1;
  return Math.max(1, REF_MEAN_IN_WEIGHT / meanInWeight);
}

function buildStats(wallMs: number, ticks: number, spikes: number): FrameStats {
  const k = kernel!;
  const dt = config.lif.dt;
  const simMs = ticks * dt, simSec = simMs / 1000;
  return {
    tick: k.tick, simTimeMs: k.tick * dt, spikesThisFrame: spikes,
    spikesPerSec: simSec > 0 ? spikes / simSec : 0,
    activeNeurons: k.activeNeurons(),
    meanRateHz: simSec > 0 ? spikes / simSec / Math.max(1, k.N) : 0,
    realTimeFactor: wallMs > 0 ? simMs / wallMs : 0,
    msPerTick: ticks > 0 ? wallMs / ticks : 0, pendingEvents: k.pendingEvents(),
  };
}

function runTicks(ticks: number): { spikes: number; wall: number; buf: Int32Array; count: number } {
  const k = kernel!; const a = agent!;
  const dt = config.lif.dt / 1000;
  const t0 = performance.now();
  let total = 0, count = 0;
  for (let s = 0; s < ticks; s++) {
    a.step(dt);
    const n = k.spikeN;
    total += n;
    const room = SPIKE_TRANSFER_CAP - count;
    const take = n < room ? n : room;
    if (count + take > frameBuf.length) { const nb = new Int32Array(Math.max(count + take, frameBuf.length * 2)); nb.set(frameBuf.subarray(0, count)); frameBuf = nb; }
    for (let i = 0; i < take; i++) frameBuf[count++] = k.spikeBuf[i];
  }
  return { spikes: total, wall: performance.now() - t0, buf: frameBuf, count };
}

function emitFrame(ticks: number, spikes: number, wall: number, buf: Int32Array, count: number) {
  const k = kernel!; const a = agent!;
  const out = new Int32Array(count); out.set(buf.subarray(0, count));
  const stats = buildStats(wall, ticks, spikes);
  ticksSinceRegion += ticks;
  let regions = null;
  if (frameIdx % SNAP_EVERY_FRAMES === 0) { regions = k.computeRegions(ticksSinceRegion); ticksSinceRegion = 0; }
  frameIdx++;
  post({ type: "frame", spikes: out, stats, readout: k.getReadout(), regions }, [out.buffer]);
  if (frameIdx % SNAP_EVERY_FRAMES === 0) { const snap: Snapshot = a.snapshot(stats); post({ type: "snapshot", snap }); }
}

function scheduleFrame() { if (running) frameTimer = setTimeout(runFrame, 0); }
function runFrame() {
  if (!running || !kernel || !agent) return;
  const r = runTicks(config.ticksPerFrame);
  emitFrame(config.ticksPerFrame, r.spikes, r.wall, r.buf, r.count);
  scheduleFrame();
}

async function handleInit(msg: Extract<MainToWorker, { type: "init" }>) {
  const t0 = performance.now();
  manifest = msg.manifest;
  mergeConfig(msg.config);
  post({ type: "log", msg: `loading ${msg.mode}: ${manifest.neurons} neurons, ${manifest.edges} edges ...` });
  const g = await loadGraph(msg.baseUrl, msg.mode, manifest);
  kernel = new Kernel(g, config, manifest.populations, manifest.region_names);
  const gain = calibrationGain(g);
  kernel.setGainScale(gain);
  if (gain !== 1) post({ type: "log", msg: `dataset calibration: per-synapse gain x${gain.toFixed(2)} (sparse connectome subset)` });
  agent = new Agent(kernel, config, { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode });
  loadSeconds = (performance.now() - t0) / 1000;
  post({ type: "log", msg: `populations wired: ${Object.keys(agent.pop.actions).length} motor pools, ${Object.keys(agent.pop.drives).length} drive channels, ${agent.pop.da.length} DA-modulated neurons` });
  post({ type: "ready", manifest, memoryBytes: kernel.approxMemoryBytes(), loadSeconds });
}

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init": await handleInit(msg); break;
      case "start": if (agent) { running = true; scheduleFrame(); } break;
      case "stop": running = false; if (frameTimer) clearTimeout(frameTimer); break;
      case "step": if (agent) { running = false; if (frameTimer) clearTimeout(frameTimer); const r = runTicks(msg.n); emitFrame(msg.n, r.spikes, r.wall, r.buf, r.count); } break;
      case "setConfig": if (kernel) { mergeConfig(msg.config); kernel.setConfig(config); } break;
      case "setSpeed": config.ticksPerFrame = msg.ticksPerFrame; break;
      case "inject": if (kernel) kernel.inject(msg.digit); break;
      case "reset": if (agent) { agent.k.reset(); agent.resetWorld(0); post({ type: "log", msg: "simulation + world reset" }); } break;
      case "resetWorld": if (agent) { agent.resetWorld(config.physio.contentStart); agent.resetMetrics(); post({ type: "log", msg: "world reset" }); } break;
      case "forceEat": if (agent) { agent.w.content = Math.min(1, agent.w.content + msg.amount); post({ type: "log", msg: `force-fed gut_content +${msg.amount}` }); } break;
      case "setPlasticity": if (agent) { mergeConfig({ plasticity: { ...config.plasticity, enabled: msg.on, mode: msg.mode ?? "three" } }); if (msg.on) mergeConfig({ deterministic: false }); kernel!.setConfig(config); post({ type: "log", msg: `plasticity ${msg.on ? "ON" : "OFF"} (${config.plasticity.mode})` }); } break;
      case "runExperiment": if (agent) {
        running = false; if (frameTimer) clearTimeout(frameTimer);
        const result = agent.runExperiment(msg.id, msg.trials);
        post({ type: "experiment", result });
        post({ type: "log", msg: `experiment ${msg.id} done` });
      } break;
      case "selectNeuron": if (kernel) post({ type: "neuron", detail: kernel.neuronDetail(msg.index) }); break;
      case "ablate": if (kernel) {
        if (msg.kind === "neuron") kernel.ablateNeuron(msg.value); else kernel.ablateRegion(msg.value);
        post({ type: "log", msg: `ablated ${msg.kind} ${msg.value}; disabled=${kernel.disabledCount()}` });
      } break;
      case "restore": if (kernel) { kernel.restore(); post({ type: "log", msg: "ablation cleared" }); } break;
      case "queryConnections": if (kernel) post({ type: "connections", index: msg.index, direction: msg.direction, partners: kernel.connections(msg.index, msg.direction, msg.limit) }); break;
      case "benchmark": if (agent) {
        running = false; if (frameTimer) clearTimeout(frameTimer);
        agent.k.reset(); agent.resetWorld(0.85);
        const dt = config.lif.dt / 1000; const t0 = performance.now();
        for (let s = 0; s < msg.ticks; s++) agent.step(dt);
        const wall = (performance.now() - t0) / 1000; const simMs = msg.ticks * config.lif.dt;
        const res: BenchmarkResult = { mode: manifest!.mode as any, neurons: agent.k.N, edges: agent.k.E, initSeconds: loadSeconds, ticks: msg.ticks, wallSeconds: wall, msPerTick: (wall * 1000) / msg.ticks, spikesPerTick: agent.k.totalSpikes() / msg.ticks, realTimeFactor: simMs / (wall * 1000), approxMemoryBytes: agent.k.approxMemoryBytes(), peakActiveNeurons: agent.k.peakActive };
        post({ type: "benchmark", result: res });
      } break;
    }
  } catch (err) {
    post({ type: "error", msg: String(err && (err as Error).stack || err) });
  }
};
