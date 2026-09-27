// Whole-MaleCNS spiking neural kernel.
//
// Real MaleCNS graph (CSR) -> sparse representation -> LIF spiking dynamics ->
// event-driven propagation with synaptic delays -> neurotransmitter effect ->
// optional STDP -> population readout. Runs entirely inside a Web Worker.
//
// Design notes
// ------------
// * Connectivity is the immutable MaleCNS synapse-count weight (`baseW`). The
//   effective synaptic drive of an edge is (baseW + delta) * weightScale * ntEffect,
//   where `delta` is the learned plasticity term (never written back to baseW).
// * Propagation is EVENT-DRIVEN: only neurons that spiked `delay` ticks ago are
//   expanded along their outgoing CSR adjacency. Idle neurons are not touched.
// * Membrane integration uses an ACTIVE SET: only neurons that are depolarised,
//   refractory, or received input this tick are integrated. Cost scales with
//   activity, not with the 1.7M-neuron array length.
// * Synaptic transmission is delayed through a ring buffer of length delay+1.
// * All randomness uses a seeded PRNG -> deterministic given (data, params, seed).

import type { SimConfig, ReadoutState, RegionStat, NeuronDetail, Populations } from "./protocol";
import { NT_NAMES } from "./protocol";

export interface GraphData {
  N: number;
  E: number;
  indptr: Uint32Array;
  indices: Int32Array;
  baseW: Float32Array;     // immutable MaleCNS weight
  indptrR: Uint32Array;
  indicesR: Int32Array;
  rev2fwd: Int32Array;     // CSC slot -> CSR slot (for post-side STDP)
  ntCode: Uint8Array;
  region: Uint16Array;
  bodyIds: BigInt64Array;
  inDeg: Int32Array;
  outDeg: Int32Array;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function growI32(arr: Int32Array, minCap: number): Int32Array {
  if (arr.length >= minCap) return arr;
  let cap = arr.length || 1024;
  while (cap < minCap) cap <<= 1;
  const n = new Int32Array(cap);
  n.set(arr);
  return n;
}

const POP_R6 = 1, POP_R7 = 2, POP_NO = 3;
const EPS = 1e-4;

export class Kernel {
  readonly g: GraphData;
  readonly N: number;
  readonly E: number;
  cfg: SimConfig;

  // per-neuron state
  private V: Float32Array;
  private Isyn: Float32Array;
  private refracUntil: Int32Array;
  private lastSpike: Int32Array;
  private spikeCount: Int32Array;
  private disabled: Uint8Array;
  private inActive: Uint8Array;
  private popId: Int8Array;
  private inputId: Int8Array;

  // active set
  private activeBuf: Int32Array;
  private activeCount = 0;

  // spikes produced this tick
  spikeBuf: Int32Array;
  spikeN = 0;

  // delay ring
  private D = 2;
  private ringBuf: Int32Array[] = [];
  private ringCount: Int32Array = new Int32Array(0);
  private delayTicks = 10;

  // derived constants
  private dtOverTau: number;
  private synDecay: number;          // per-tick leak of the synaptic current
  // Dataset calibration: the loaded graphs are different subsets of the same
  // connectome and differ hugely in synapses-per-neuron (mean in-degree x mean
  // weight). This factor is set once at load so a neuron's TOTAL synaptic drive
  // is comparable across datasets, instead of the sparsest graphs going silent.
  private gainScale = 1;
  private refTicks: number;
  private ntEffect: Float32Array = new Float32Array(NT_NAMES.length);

  // plasticity (lazy)
  private delta: Float32Array | null = null;

  // clock
  tick = 0;

  // rng
  private rand: () => number;
  private gaussSpare: number | null = null;

  // readout (EMA firing rates, Hz)
  private rate6 = 0; private rate7 = 0; private rateNo = 0;
  private readAccum6 = 0; private readAccum7 = 0; private readAccumNo = 0;
  private popCount6 = 0; private popCount7 = 0; private popCountNo = 0;

  // region activity
  private regionSpikes: Int32Array;
  private regionNeuronCount: Int32Array;
  readonly regionNames: string[];
  private regionActive: Int32Array;

  // input encoder state
  private inputActive = false;
  private inputPop: Int32Array = new Int32Array(0);
  private inputPopN = 0;
  private inputStart = 0;
  private inputEnd = 0;
  private driveBuf: Int32Array = new Int32Array(0);

  // stats
  peakActive = 0;

  // ---- PoopFly: drive channels, motor readout, three-factor plasticity ----
  private channels = new Map<string, { pop: Int32Array; rateHz: number }>();
  private driveSpikes = 0;
  private driveRateEma = 0;
  private actId!: Int16Array;            // neuron -> action index (1..A), 0 = none
  private actionNames: string[] = [];
  private actionAccum!: Int32Array;
  private actionRates!: Float32Array;
  private elig: Float32Array | null = null;      // eligibility per synapse (lazy)
  private touched: Uint8Array | null = null;     // is synapse in activeEdges
  private activeEdges: Int32Array = new Int32Array(0);
  private activeEdgeN = 0;
  private dopa = 0;                              // current modulatory signal
  potentiated = 0; depressed = 0; changedCount = 0;
  private deltaAbsSum = 0; private deltaAbsMax = 0; private nonzeroEdges = 0;

  constructor(g: GraphData, cfg: SimConfig, pops: Populations, regionNames: string[]) {
    this.g = g; this.N = g.N; this.E = g.E; this.cfg = cfg;
    this.regionNames = regionNames;
    const N = g.N;
    this.V = new Float32Array(N);
    this.Isyn = new Float32Array(N);
    this.refracUntil = new Int32Array(N);
    this.lastSpike = new Int32Array(N);
    this.spikeCount = new Int32Array(N);
    this.disabled = new Uint8Array(N);
    this.inActive = new Uint8Array(N);
    this.popId = new Int8Array(N);
    this.inputId = new Int8Array(N);
    this.actId = new Int16Array(N);
    this.actionAccum = new Int32Array(1);
    this.actionRates = new Float32Array(1);
    this.activeEdges = new Int32Array(4096);
    this.activeBuf = new Int32Array(Math.min(N, 4096));
    this.spikeBuf = new Int32Array(Math.min(N, 4096));
    this.rand = mulberry32(cfg.noise.seed);

    const R = regionNames.length;
    this.regionSpikes = new Int32Array(R);
    this.regionActive = new Int32Array(R);
    this.regionNeuronCount = new Int32Array(R);
    for (let i = 0; i < N; i++) this.regionNeuronCount[g.region[i]]++;

    for (const id of pops.READOUT_6) if (id >= 0 && id < N) this.popId[id] = POP_R6;
    for (const id of pops.READOUT_7) if (id >= 0 && id < N) this.popId[id] = POP_R7;
    for (const id of pops.NO_ACTION) if (id >= 0 && id < N) this.popId[id] = POP_NO;
    for (const id of pops.INPUT_6) if (id >= 0 && id < N) this.inputId[id] = 1;
    for (const id of pops.INPUT_7) if (id >= 0 && id < N) this.inputId[id] = 2;

    this.dtOverTau = cfg.lif.dt / cfg.lif.tauM;
    this.synDecay = Math.exp(-cfg.lif.dt / Math.max(cfg.lif.dt, cfg.lif.tauSyn));
    this.refTicks = Math.max(1, Math.round(cfg.lif.tRef / cfg.lif.dt));
    this.applyNtEffect();
    this.reset();
  }

  private applyNtEffect() {
    for (let i = 0; i < NT_NAMES.length; i++) {
      const name = NT_NAMES[i];
      const v = this.cfg.ntEffect[name];
      this.ntEffect[i] = v === undefined ? 0.5 : v;
    }
  }

  /** Dataset calibration factor applied to every synapse (see gainScale). */
  setGainScale(g: number) { this.gainScale = g > 0 && Number.isFinite(g) ? g : 1; }
  getGainScale() { return this.gainScale; }

  setConfig(cfg: SimConfig) {
    const delayChanged = cfg.lif.delayMs !== this.cfg.lif.delayMs || cfg.lif.dt !== this.cfg.lif.dt;
    const popChanged = cfg.input.populationSize !== this.cfg.input.populationSize;
    this.cfg = cfg;
    this.dtOverTau = cfg.lif.dt / cfg.lif.tauM;
    this.synDecay = Math.exp(-cfg.lif.dt / Math.max(cfg.lif.dt, cfg.lif.tauSyn));
    this.refTicks = Math.max(1, Math.round(cfg.lif.tRef / cfg.lif.dt));
    this.applyNtEffect();
    if (delayChanged) this.buildRing();
    if (popChanged) { this.inputCache6 = null; this.inputCache7 = null; }
  }

  private plasticityOn(): boolean {
    return this.cfg.plasticity.enabled && !this.cfg.deterministic;
  }
  private stdpOn(): boolean { return this.plasticityOn() && this.cfg.plasticity.mode === "stdp"; }
  private threeOn(): boolean { return this.plasticityOn() && this.cfg.plasticity.mode === "three"; }
  private noiseOn(): boolean {
    return this.cfg.noise.enabled && !this.cfg.deterministic;
  }

  private ensureDelta() {
    if (!this.delta) this.delta = new Float32Array(this.E);
    return this.delta;
  }

  resetPlasticity() {
    if (this.delta) this.delta.fill(0);
    this.deltaAbsSum = 0; this.deltaAbsMax = 0; this.nonzeroEdges = 0;
    this.potentiated = 0; this.depressed = 0; this.changedCount = 0;
  }

  reset() {
    const vr = this.cfg.lif.vRest;
    this.V.fill(vr);
    this.Isyn.fill(0);
    this.refracUntil.fill(0);
    this.lastSpike.fill(-1_000_000_000);
    this.spikeCount.fill(0);
    this.inActive.fill(0);
    this.activeCount = 0;
    this.spikeN = 0;
    this.tick = 0;
    this.rate6 = this.rate7 = this.rateNo = 0;
    this.readAccum6 = this.readAccum7 = this.readAccumNo = 0;
    this.popCount6 = this.popCount7 = this.popCountNo = 0;
    this.regionSpikes.fill(0);
    this.regionActive.fill(0);
    this.peakActive = 0;
    this.inputActive = false;
    this.rand = mulberry32(this.cfg.noise.seed);
    this.gaussSpare = null;
    this.resetPlasticity();
    // clear PoopFly readout + eligibility (only touch the active subset, O(touched))
    if (this.elig) { for (let a = 0; a < this.activeEdgeN; a++) { const e = this.activeEdges[a]; this.elig[e] = 0; this.touched![e] = 0; } }
    this.activeEdgeN = 0; this.actionAccum.fill(0); this.actionRates.fill(0);
    this.pendingSpikes.length = 0;
    this.dopa = 0; this.driveSpikes = 0; this.driveRateEma = 0; this.potentiated = 0; this.depressed = 0; this.changedCount = 0;
    this.buildRing();
  }

  private buildRing() {
    this.delayTicks = Math.max(1, Math.round(this.cfg.lif.delayMs / this.cfg.lif.dt));
    this.D = this.delayTicks + 1;
    const cap = Math.min(Math.max(1024, this.N >> 4), 1 << 20);
    this.ringBuf = [];
    for (let i = 0; i < this.D; i++) this.ringBuf.push(new Int32Array(cap));
    this.ringCount = new Int32Array(this.D);
  }

  // ---- active set ----
  private markActive(j: number) {
    if (this.inActive[j]) return;
    this.inActive[j] = 1;
    if (this.activeCount === this.activeBuf.length) this.activeBuf = growI32(this.activeBuf, this.activeCount + 1);
    this.activeBuf[this.activeCount++] = j;
  }

  // ---- input encoding: drive a population as a Poisson spike source ----
  inject(digit: 6 | 7) {
    const ids = digit === 6 ? this.popInput(1) : this.popInput(2);
    this.inputPop = ids; this.inputPopN = ids.length;
    const dt = this.cfg.lif.dt;
    const lat = Math.round(this.cfg.input.latencyMs / dt);
    const dur = Math.round(this.cfg.input.durationMs / dt);
    this.inputStart = this.tick + lat;
    this.inputEnd = this.inputStart + dur;
    this.inputActive = true;
  }

  private inputCache6: Int32Array | null = null;
  private inputCache7: Int32Array | null = null;
  private popInput(which: 1 | 2): Int32Array {
    const cached = which === 1 ? this.inputCache6 : this.inputCache7;
    if (cached) return cached;
    const lim = Math.min(this.cfg.input.populationSize, this.N);
    const out: number[] = [];
    for (let i = 0; i < this.N && out.length < lim; i++) if (this.inputId[i] === which) out.push(i);
    const arr = Int32Array.from(out);
    if (which === 1) this.inputCache6 = arr; else this.inputCache7 = arr;
    return arr;
  }

  private gauss(): number {
    if (this.gaussSpare !== null) { const s = this.gaussSpare; this.gaussSpare = null; return s; }
    let u = 0, v = 0, s = 0;
    do { u = this.rand() * 2 - 1; v = this.rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this.gaussSpare = v * m;
    return u * m;
  }

  // Generate forced input spikes for tick t into driveBuf; returns count.
  private encodeInput(t: number): number {
    if (!this.inputActive) return 0;
    if (t < this.inputStart) return 0;
    if (t >= this.inputEnd) { this.inputActive = false; return 0; }
    const dt = this.cfg.lif.dt;
    const p = this.cfg.input.rateHz * dt / 1000; // per-tick spike probability
    let n = 0;
    this.driveBuf = growI32(this.driveBuf, this.inputPopN);
    for (let k = 0; k < this.inputPopN; k++) {
      const i = this.inputPop[k];
      if (this.disabled[i]) continue;
      // Poisson drive + optional temporal jitter/noise
      let fire = this.rand() < p;
      if (this.cfg.input.noise > 0 && !fire) fire = this.rand() < p * this.cfg.input.noise;
      if (fire) this.driveBuf[n++] = i;
    }
    return n;
  }

  // ---- one simulation tick ----
  private pendingSpikes: number[] = [];
  queueSpike(i: number) { if (i >= 0 && i < this.N && this.pendingSpikes.length < 2_000_000) this.pendingSpikes.push(i); }

  step(): number {
    const t = this.tick;
    this.spikeN = 0;
    // externally queued spikes (input encoder override / tests / UI) become real
    // network spikes on this tick and propagate through the connectome.
    if (this.pendingSpikes.length) {
      for (let k = 0; k < this.pendingSpikes.length; k++) this.forceSpike(this.pendingSpikes[k], t);
      this.pendingSpikes.length = 0;
    }
    // 0) external input drive (real spikes entering the network)
    const nd = this.encodeInput(t);
    for (let k = 0; k < nd; k++) this.forceSpike(this.driveBuf[k], t);
    // 0b) interoceptive / contextual drive channels (PRESSURE, HUNGER, MUSIC_*)
    this.driveSpikes = 0;
    this.encodeChannels();
    { const dtSec = this.cfg.lif.dt / 1000; const alpha = 1 - Math.exp(-this.cfg.lif.dt / Math.max(1, this.cfg.readout.windowMs)); this.driveRateEma += (this.driveSpikes / dtSec - this.driveRateEma) * alpha; }

    // 1) deliver delayed synaptic events scheduled for this tick
    this.deliverSlot(t % this.D);

    // 2) integrate the active set + threshold
    this.integrate(t);
    this.updateActionRates();
    this.stepPlasticity(this.dopa);

    // 3) store this tick's spikes for delivery at t + delay
    const storeSlot = (t + this.delayTicks) % this.D;
    for (let k = 0; k < this.spikeN; k++) this.pushRing(storeSlot, this.spikeBuf[k]);

    // 4) readout EMA update
    this.updateReadout();

    this.tick = t + 1;
    if (this.activeCount > this.peakActive) this.peakActive = this.activeCount;
    return this.spikeN;
  }

  private pushRing(slot: number, i: number) {
    let buf = this.ringBuf[slot];
    const c = this.ringCount[slot];
    if (c === buf.length) { buf = growI32(buf, c + 1); this.ringBuf[slot] = buf; }
    buf[c] = i;
    this.ringCount[slot] = c + 1;
  }

  private deliverSlot(slot: number) {
    const buf = this.ringBuf[slot];
    const cnt = this.ringCount[slot];
    if (cnt === 0) return;
    const { indptr, indices, baseW } = this.g;
    const Isyn = this.Isyn, disabled = this.disabled, ntCode = this.g.ntCode;
    const ntEff = this.ntEffect, ws = this.cfg.lif.weightScale;
    const plast = this.plasticityOn();
    const delta = plast ? this.ensureDelta() : null;
    for (let s = 0; s < cnt; s++) {
      const i = buf[s];
      if (disabled[i]) continue;
      const eff = ntEff[ntCode[i]];
        if (eff === 0) continue;
        const start = indptr[i], end = indptr[i + 1];
        const wsc = ws * eff * this.gainScale;
      if (delta) {
        for (let k = start; k < end; k++) {
          const j = indices[k];
          if (disabled[j]) continue;
          Isyn[j] += (baseW[k] + delta[k]) * wsc;
          this.markActive(j);
        }
      } else {
        for (let k = start; k < end; k++) {
          const j = indices[k];
          if (disabled[j]) continue;
          Isyn[j] += baseW[k] * wsc;
          this.markActive(j);
        }
      }
    }
    this.ringCount[slot] = 0;
  }

  private integrate(t: number) {
    const a = this.activeBuf;
    const n = this.activeCount;
    const { vRest, vThresh, vReset } = this.cfg.lif;
    const dtOverTau = this.dtOverTau;
    const synDecay = this.synDecay;
    const noiseOn = this.noiseOn();
    const noiseAmp = this.cfg.noise.amplitude;
    const refracUntil = this.refracUntil, V = this.V, Isyn = this.Isyn, disabled = this.disabled;
    let write = 0;
    for (let idx = 0; idx < n; idx++) {
      const i = a[idx];
      if (disabled[i]) { this.inActive[i] = 0; Isyn[i] = 0; continue; }
      // Synaptic current LEAKS with tauSyn rather than vanishing: EPSPs can
      // summate across the synaptic window, which is what lets convergent
      // connectome input bring a real neuron to threshold.
      const syn = Isyn[i];
      if (t < refracUntil[i]) {
        V[i] = vReset;
        Isyn[i] = syn * synDecay;
        a[write++] = i;
        continue;
      }
      let v = V[i] + dtOverTau * (-(V[i] - vRest) + syn);
      const leakSyn = syn * synDecay;
      Isyn[i] = leakSyn;
      if (noiseOn) v += this.gauss() * noiseAmp;
      if (v >= vThresh) {
        this.fire(i, t);
        a[write++] = i; // stays active (refractory)
      } else {
        V[i] = v;
        if (v - vRest > EPS || vRest - v > EPS || leakSyn > EPS || -leakSyn > EPS) {
          a[write++] = i;
        } else {
          V[i] = vRest; Isyn[i] = 0; this.inActive[i] = 0;
        }
      }
    }
    this.activeCount = write;
  }

  private forceSpike(i: number, t: number) {
    // input neurons are clamped to emit spikes (sensory encoding); they still
    // propagate through the real connectome like any other spike.
    if (this.disabled[i]) return;
    if (t < this.refracUntil[i]) return;
    this.V[i] = this.cfg.lif.vReset;
    this.fire(i, t);
    this.markActive(i);
  }

  private fire(i: number, t: number) {
    const { vReset } = this.cfg.lif;
    this.V[i] = vReset;
    this.refracUntil[i] = t + this.refTicks;
    this.spikeCount[i]++;
    if (this.stdpOn()) this.stdp(i, t);
    this.lastSpike[i] = t;
    if (this.actId[i] > 0) this.actionAccum[this.actId[i]]++;
    if (this.threeOn()) this.raiseElig(i);
    if (this.spikeN === this.spikeBuf.length) this.spikeBuf = growI32(this.spikeBuf, this.spikeN + 1);
    this.spikeBuf[this.spikeN++] = i;
    this.regionSpikes[this.g.region[i]]++;
    const p = this.popId[i];
    if (p === POP_R6) { this.readAccum6++; this.popCount6++; }
    else if (p === POP_R7) { this.readAccum7++; this.popCount7++; }
    else if (p === POP_NO) { this.readAccumNo++; this.popCountNo++; }
  }

  // Symmetric nearest-spike STDP. delta is the learned term; baseW is immutable.
  private stdp(i: number, t: number) {
    const delta = this.ensureDelta();
    const { aPlus, aMinus, tauPlus, tauMinus, maxDelta } = this.cfg.plasticity;
    const dt = this.cfg.lif.dt;
    const lastSpike = this.lastSpike, baseW = this.g.baseW;
    // PRE side: i fired; look at outgoing edges, depress if post fired just before.
    const { indptr, indices } = this.g;
    const s0 = indptr[i], s1 = indptr[i + 1];
    for (let k = s0; k < s1; k++) {
      const j = indices[k];
      const ls = lastSpike[j];
      if (ls <= -1_000_000) continue;
      const gap = (t - ls) * dt;
      if (gap >= 0 && gap <= tauMinus) {
        let d = delta[k] - aMinus * Math.exp(-gap / tauMinus);
        const lo = Math.max(-maxDelta, -baseW[k]);
        delta[k] = d < lo ? lo : (d > maxDelta ? maxDelta : d);
      }
    }
    // POST side: i fired; look at incoming edges, potentiate if pre fired just before.
    const { indptrR, indicesR, rev2fwd } = this.g;
    const r0 = indptrR[i], r1 = indptrR[i + 1];
    for (let c = r0; c < r1; c++) {
      const srcI = indicesR[c];
      const ls = lastSpike[srcI];
      if (ls <= -1_000_000) continue;
      const gap = (t - ls) * dt;
      if (gap >= 0 && gap <= tauPlus) {
        const k = rev2fwd[c];
        let d = delta[k] + aPlus * Math.exp(-gap / tauPlus);
        const lo = Math.max(-maxDelta, -baseW[k]);
        delta[k] = d < lo ? lo : (d > maxDelta ? maxDelta : d);
      }
    }
  }

  private updateReadout() {
    const dt = this.cfg.lif.dt;
    const tau = Math.max(1e-3, this.cfg.readout.windowMs);
    const alpha = 1 - Math.exp(-dt / tau);
    const dtSec = dt / 1000;
    const i6 = this.readAccum6 / dtSec, i7 = this.readAccum7 / dtSec, iNo = this.readAccumNo / dtSec;
    this.rate6 += (i6 - this.rate6) * alpha;
    this.rate7 += (i7 - this.rate7) * alpha;
    this.rateNo += (iNo - this.rateNo) * alpha;
    this.readAccum6 = this.readAccum7 = this.readAccumNo = 0;
  }

  getReadout(): ReadoutState {
    const r6 = this.rate6, r7 = this.rate7, rNo = this.rateNo;
    const thr = this.cfg.readout.noActionThresholdHz;
    let decision: 0 | 6 | 7 = 0;
    if (Math.max(r6, r7) >= thr) decision = r6 >= r7 ? 6 : 7;
    const denom = r6 + r7 + 1e-9;
    return {
      count6: this.popCount6, count7: this.popCount7, countNo: this.popCountNo,
      rate6Hz: r6, rate7Hz: r7, rateNoHz: rNo,
      decision, confidence: Math.abs(r6 - r7) / denom,
      windowMs: this.cfg.readout.windowMs,
    };
  }

  // Region activity for the reporting window (called once per frame).
  computeRegions(frameTicks: number): RegionStat[] {
    const dtSec = (frameTicks * this.cfg.lif.dt) / 1000;
    this.regionActive.fill(0);
    for (let k = 0; k < this.activeCount; k++) this.regionActive[this.g.region[this.activeBuf[k]]]++;
    const out: RegionStat[] = [];
    for (let r = 0; r < this.regionNames.length; r++) {
      const neurons = this.regionNeuronCount[r];
      if (neurons === 0 && this.regionSpikes[r] === 0) continue;
      out.push({
        code: r, name: this.regionNames[r], neurons,
        spikes: this.regionSpikes[r], activeNeurons: this.regionActive[r],
        rateHz: dtSec > 0 ? this.regionSpikes[r] / dtSec : 0,
      });
    }
    this.regionSpikes.fill(0);
    out.sort((a, b) => b.spikes - a.spikes);
    return out;
  }

  // ---- ablation ----
  ablateNeuron(i: number) { if (i >= 0 && i < this.N) { this.disabled[i] = 1; this.inActive[i] = 0; this.Isyn[i] = 0; } }
  ablateRegion(code: number) { for (let i = 0; i < this.N; i++) if (this.g.region[i] === code) this.disabled[i] = 1; }
  restore() { this.disabled.fill(0); }
  isDisabled(i: number) { return this.disabled[i] === 1; }
  disabledCount(): number { let c = 0; for (let i = 0; i < this.N; i++) c += this.disabled[i]; return c; }

  // ---- inspection ----
  getV(i: number) { return this.V[i]; }
  neuronDetail(i: number): NeuronDetail {
    if (i < 0 || i >= this.N) throw new Error(`neuron index ${i} out of range 0..${this.N - 1}`);
    const dtSec = this.cfg.lif.dt / 1000;
    const simSec = Math.max(1e-9, this.tick * dtSec);
    return {
      index: i,
      bodyId: String(this.g.bodyIds[i]),
      nt: NT_NAMES[this.g.ntCode[i]] ?? "UNKNOWN",
      region: this.regionNames[this.g.region[i]] ?? "UNKNOWN",
      inDegree: this.g.inDeg[i], outDegree: this.g.outDeg[i],
      v: this.V[i], spikeCount: this.spikeCount[i],
      rateHz: this.spikeCount[i] / simSec,
      lastSpikeTick: this.lastSpike[i],
      disabled: this.disabled[i] === 1,
      refractory: this.tick < this.refracUntil[i],
    };
  }

  connections(i: number, direction: "out" | "in", limit: number) {
    const out: { index: number; bodyId: string; weight: number; nt: string; region: string }[] = [];
    if (direction === "out") {
      const s0 = this.g.indptr[i], s1 = this.g.indptr[i + 1];
      for (let k = s0; k < s1 && out.length < limit; k++) {
        const j = this.g.indices[k];
        out.push({ index: j, bodyId: String(this.g.bodyIds[j]), weight: this.g.baseW[k],
          nt: NT_NAMES[this.g.ntCode[i]] ?? "?", region: this.regionNames[this.g.region[j]] ?? "?" });
      }
    } else {
      const s0 = this.g.indptrR[i], s1 = this.g.indptrR[i + 1];
      for (let c = s0; c < s1 && out.length < limit; c++) {
        const j = this.g.indicesR[c];
        const k = this.g.rev2fwd[c];
        out.push({ index: j, bodyId: String(this.g.bodyIds[j]), weight: this.g.baseW[k],
          nt: NT_NAMES[this.g.ntCode[j]] ?? "?", region: this.regionNames[this.g.region[j]] ?? "?" });
      }
    }
    return out;
  }

  // ---- PoopFly drive channels + motor readout + three-factor plasticity ----
  setChannels(names: string[]) {
    this.channels.clear();
    for (const n of names) this.channels.set(n, { pop: new Int32Array(0), rateHz: 0 });
  }
  setChannelPop(name: string, pop: Int32Array) {
    const c = this.channels.get(name) ?? { pop: new Int32Array(0), rateHz: 0 };
    c.pop = pop; this.channels.set(name, c);
  }
  setChannelDrive(name: string, rateHz: number) { const c = this.channels.get(name); if (c) c.rateHz = rateHz; }
  setDopamine(d: number) { this.dopa = d; }
  driveFiringHz(): number { return this.driveRateEma; }

  private encodeChannels() {
    const dt = this.cfg.lif.dt;
    for (const ch of this.channels.values()) {
      if (ch.rateHz <= 0 || ch.pop.length === 0) continue;
      const p = ch.rateHz * dt / 1000;
      for (let k = 0; k < ch.pop.length; k++) {
        const i = ch.pop[k];
        if (this.disabled[i]) continue;
        if (this.rand() < p) { this.forceSpike(i, this.tick); this.driveSpikes++; }
      }
    }
  }

  setActionPopulations(names: string[], actions: Record<string, Int32Array>) {
    this.actionNames = names.slice();
    this.actId.fill(0);
    const A = names.length + 1;
    this.actionAccum = new Int32Array(A);
    this.actionRates = new Float32Array(A);
    names.forEach((n, idx) => {
      const aid = idx + 1;
      const pop = actions[n]; if (!pop) return;
      for (const i of pop) if (i >= 0 && i < this.N) this.actId[i] = aid;
    });
  }
  updateActionRates() {
    const dtSec = this.cfg.lif.dt / 1000;
    const alpha = 1 - Math.exp(-this.cfg.lif.dt / Math.max(1, this.cfg.readout.windowMs));
    for (let a = 1; a < this.actionAccum.length; a++) {
      const inst = this.actionAccum[a] / dtSec;
      this.actionRates[a] += (inst - this.actionRates[a]) * alpha;
      this.actionAccum[a] = 0;
    }
  }
  getActionRates(): { name: string; rate: number }[] {
    const out: { name: string; rate: number }[] = [];
    for (let i = 0; i < this.actionNames.length; i++) out.push({ name: this.actionNames[i], rate: this.actionRates[i + 1] });
    return out;
  }
  motorDriveHz(): number { let m = 0; for (let a = 1; a < this.actionRates.length; a++) if (this.actionRates[a] > m) m = this.actionRates[a]; return m; }

  private ensureElig() {
    if (!this.elig) { this.elig = new Float32Array(this.E); this.touched = new Uint8Array(this.E); }
    return this.elig;
  }
  // raise eligibility for synapses on both sides of a spiking neuron (co-activity trace)
  private raiseElig(i: number) {
    const elig = this.ensureElig(); const touched = this.touched!;
    const { indptr, indptrR, rev2fwd } = this.g;
    const { preAmp, postAmp, eligCap } = this.cfg.plasticity;
    const s0 = indptr[i], s1 = indptr[i + 1];
    for (let k = s0; k < s1; k++) this.markElig(k, preAmp, elig, touched, eligCap);
    const r0 = indptrR[i], r1 = indptrR[i + 1];
    for (let c = r0; c < r1; c++) this.markElig(rev2fwd[c], postAmp, elig, touched, eligCap);
  }
  private markElig(e: number, amp: number, elig: Float32Array, touched: Uint8Array, cap: number) {
    if (!touched[e]) {
      touched[e] = 1;
      if (this.activeEdgeN === this.activeEdges.length) this.activeEdges = growI32(this.activeEdges, this.activeEdgeN + 1);
      this.activeEdges[this.activeEdgeN++] = e;
    }
    const v = elig[e] + amp; elig[e] = v > cap ? cap : v;
  }
  // three-factor: dDelta = dopamine * eligibility (decayed); restricted to touched synapses
  private stepPlasticity(dop: number) {
    if (!this.threeOn() || this.activeEdgeN === 0) { if (!this.threeOn()) { this.pruneEligAlways(); } return; }
    const elig = this.elig!; const touched = this.touched!; const delta = this.ensureDelta();
    const { baseW } = this.g;
    const decay = Math.exp(-this.cfg.lif.dt / this.cfg.plasticity.eligDecayMs);
    const gain = dop >= 0 ? this.cfg.plasticity.rewardGain : this.cfg.plasticity.punishGain;
    const wMin = this.cfg.plasticity.weightMin, wMax = this.cfg.plasticity.weightMax;
    let w = 0;
    const keep = this.activeEdges; const active = keep.slice(0, this.activeEdgeN); // iterate snapshot
    for (let a = 0; a < active.length; a++) {
      const e = active[a];
      const el = elig[e];
      const inc = dop * el * gain * (this.cfg.lif.dt);
      if (inc !== 0) {
        const lo = Math.max(wMin - baseW[e], -baseW[e]);
        const hi = wMax - baseW[e];
        const old = delta[e];
        let nv = old + inc; nv = nv < lo ? lo : nv > hi ? hi : nv;
        this.deltaAbsSum += Math.abs(nv) - Math.abs(old);
        if (old === 0 && nv !== 0) this.nonzeroEdges++; else if (old !== 0 && nv === 0) this.nonzeroEdges--;
        if (Math.abs(nv) > this.deltaAbsMax) this.deltaAbsMax = Math.abs(nv);
        this.changedCount++;
        if (inc > 0) this.potentiated++; else this.depressed++;
        delta[e] = nv;
      }
      const nel = el * decay;
      if (nel < 1e-3 || !this.threeOn()) { touched[e] = 0; elig[e] = 0; }
      else { elig[e] = nel; keep[w++] = e; }
    }
    this.activeEdgeN = w;
    void touched;
  }
  private pruneEligAlways() {
    if (!this.elig || this.activeEdgeN === 0) return;
    for (let a = 0; a < this.activeEdgeN; a++) { const e = this.activeEdges[a]; this.elig[e] = 0; this.touched![e] = 0; }
    this.activeEdgeN = 0;
  }
  plasticityStats() {
    return {
      changedEdges: this.nonzeroEdges,
      meanAbsDelta: this.nonzeroEdges ? this.deltaAbsSum / this.nonzeroEdges : 0,
      maxAbsDelta: this.deltaAbsMax, activeEligible: this.activeEdgeN,
      potentiated: this.potentiated, depressed: this.depressed,
    };
  }
  deltaOf(e: number): number { return this.delta ? this.delta[e] : 0; }
  eligibilityOf(e: number): number { return this.elig ? this.elig[e] : 0; }
  baseWOf(e: number): number { return this.g.baseW[e]; }

  activeNeurons(): number { return this.activeCount; }
  pendingEvents(): number { let s = 0; for (let i = 0; i < this.D; i++) s += this.ringCount[i]; return s; }
  totalSpikes(): number { let s = 0; for (let i = 0; i < this.N; i++) s += this.spikeCount[i]; return s; }
  approxMemoryBytes(): number {
    let b = this.g.indptr.byteLength + this.g.indices.byteLength + this.g.baseW.byteLength
      + this.g.indptrR.byteLength + this.g.indicesR.byteLength + this.g.rev2fwd.byteLength
      + this.g.ntCode.byteLength + this.g.region.byteLength + this.g.bodyIds.byteLength
      + this.g.inDeg.byteLength + this.g.outDeg.byteLength;
    b += this.V.byteLength + this.Isyn.byteLength + this.refracUntil.byteLength
      + this.lastSpike.byteLength + this.spikeCount.byteLength + this.disabled.byteLength
      + this.inActive.byteLength + this.popId.byteLength + this.inputId.byteLength;
    if (this.delta) b += this.delta.byteLength;
    for (const r of this.ringBuf) b += r.byteLength;
    b += this.activeBuf.byteLength + this.spikeBuf.byteLength;
    return b;
  }
}
