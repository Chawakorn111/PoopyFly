// Test helpers: build tiny synthetic graphs and load real runtime binaries (node).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GraphData } from "../src/sim/kernel";
import type { SimConfig } from "../src/sim/protocol";
import { DEFAULT_CONFIG } from "../src/sim/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = join(HERE, "..", "public", "data");

export function makeGraph(pre: Int32Array, post: Int32Array, w: Float32Array, N: number, nt?: Uint8Array): GraphData {
  const indptr = new Uint32Array(N + 1);
  for (let k = 0; k < pre.length; k++) indptr[pre[k] + 1]++;
  for (let i = 0; i < N; i++) indptr[i + 1] += indptr[i];
  const indices = new Int32Array(pre.length);
  const baseW = new Float32Array(pre.length);
  const cursor = indptr.slice(0, N);
  // sort edges by pre for canonical CSR
  const order = Array.from(pre.keys()).sort((a, b) => pre[a] - pre[b]);
  let p = 0;
  for (const e of order) { indices[p] = post[e]; baseW[p] = w[e]; p++; }
  // reverse (CSC) + rev2fwd
  const indptrR = new Uint32Array(N + 1);
  for (let k = 0; k < post.length; k++) indptrR[post[k] + 1]++;
  for (let i = 0; i < N; i++) indptrR[i + 1] += indptrR[i];
  const indicesR = new Int32Array(post.length);
  const rev2fwd = new Int32Array(post.length);
  const rcur = new Int32Array(N);
  const fwdOf = new Int32Array(post.length);
  // forward CSR slot for edge e (in the original pre/post arrays) after sorting:
  // we need, for each reverse slot, the CSR slot of the same edge.
  const posInSorted = new Int32Array(pre.length);
  order.forEach((edgeId, sortedIdx) => { posInSorted[edgeId] = sortedIdx; });
  const rOrder = Array.from(post.keys()).sort((a, b) => post[a] - post[b]);
  rOrder.forEach((edgeId, c) => { indicesR[c] = pre[edgeId]; rev2fwd[c] = posInSorted[edgeId]; });
  void rcur; void cursor; void p;
  const region = new Uint16Array(N);
  const bodyIds = new BigInt64Array(N);
  for (let i = 0; i < N; i++) bodyIds[i] = BigInt(10001 + i);
  const inDeg = new Int32Array(N), outDeg = new Int32Array(N);
  for (let i = 0; i < pre.length; i++) { outDeg[pre[i]]++; inDeg[post[i]]++; }
  return {
    N, E: pre.length, indptr, indices, baseW, indptrR, indicesR, rev2fwd,
    ntCode: nt ?? new Uint8Array(N), region, bodyIds, inDeg, outDeg,
  };
}

export function testConfig(patch: Partial<SimConfig["lif"]> = {}): SimConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.lif, { dt: 0.1, vRest: 0, vThresh: 1, vReset: 0, tauM: 1, tRef: 0.1, delayMs: 0.1, weightScale: 1 }, patch);
  c.deterministic = true; c.noise.enabled = false; c.plasticity.enabled = false;
  return c;
}

export function loadGraph(mode: string): { g: GraphData; neurons: number; edges: number; nt: Uint8Array; region: Uint16Array; bodyIds: BigInt64Array } {
  const dir = join(DATA, mode);
  const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const N = man.neurons, E = man.edges;
  const f = (name: string) => readFileSync(join(dir, name));
  const buf = (name: string) => { const b = f(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const g: GraphData = {
    N, E,
    indptr: new Uint32Array(buf("graph.indptr.u32.bin")),
    indices: new Int32Array(buf("graph.indices.i32.bin")),
    baseW: new Float32Array(buf("graph.weights.f32.bin")),
    indptrR: new Uint32Array(buf("graph_r.indptr.u32.bin")),
    indicesR: new Int32Array(buf("graph_r.indices.i32.bin")),
    rev2fwd: new Int32Array(buf("graph_r.rev2fwd.i32.bin")),
    ntCode: new Uint8Array(buf("neurons.nt.u8.bin")),
    region: new Uint16Array(buf("neurons.region.u16.bin")),
    bodyIds: new BigInt64Array(buf("neurons.bodyid.i64.bin")),
    inDeg: new Int32Array(N), outDeg: new Int32Array(N),
  };
  const deg = new Int32Array(buf("neurons.deg.i32.bin"));
  for (let i = 0; i < N; i++) { g.inDeg[i] = deg[2 * i]; g.outDeg[i] = deg[2 * i + 1]; }
  return { g, neurons: N, edges: E, nt: g.ntCode, region: g.region, bodyIds: g.bodyIds };
}
