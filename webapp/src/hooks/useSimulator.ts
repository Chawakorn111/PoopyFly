import { useCallback, useEffect, useRef, useState } from "react";
import { SimClient, fetchNeuronArrays } from "../sim/client";
import {
  DEFAULT_CONFIG, MODE_LABELS, type Manifest, type SimConfig, type SimMode, type FrameStats,
  type ReadoutState, type RegionStat, type NeuronDetail, type BenchmarkResult, type Snapshot, type ExperimentResult,
} from "../sim/protocol";
import { BrainView } from "../three/BrainView";

export interface SimState {
  ready: boolean; loading: boolean; error: string | null;
  manifest: Manifest | null; memoryBytes: number; loadSeconds: number;
  running: boolean; mode: SimMode;
  stats: FrameStats | null; readout: ReadoutState | null; regions: RegionStat[] | null;
  snap: Snapshot | null; experiments: ExperimentResult[];
  selected: NeuronDetail | null; connections: { out: any[]; in: any[] };
  benchmark: BenchmarkResult | null; log: string[]; bodyMap: Map<string, number>;
}

export function useSimulator(mode: SimMode) {
  const clientRef = useRef<SimClient | null>(null);
  const viewRef = useRef<BrainView | null>(null);
  const genRef = useRef(0);
  const statsTimer = useRef<number | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const [state, setState] = useState<SimState>({
    ready: false, loading: false, error: null, manifest: null, memoryBytes: 0, loadSeconds: 0,
    running: false, mode, stats: null, readout: null, regions: null, snap: null, experiments: [],
    selected: null, connections: { out: [], in: [] }, benchmark: null, log: [], bodyMap: new Map(),
  });
  const [config, setConfigState] = useState<SimConfig>(structuredClone(DEFAULT_CONFIG));

  const boot = useCallback(async (m: SimMode) => {
    const gen = ++genRef.current;
    clientRef.current?.terminate();
    if (viewRef.current) { viewRef.current.dispose(); viewRef.current = null; }
    setState((s) => ({ ...s, mode: m, loading: true, ready: false, error: null, log: [] }));
    const cb = {
      onReady: (man: Manifest, mem: number, ls: number) => {
        if (gen !== genRef.current) return;
        setState((s) => ({ ...s, manifest: man, memoryBytes: mem, loadSeconds: ls }));
        const host = document.getElementById("brain-host");
        if (!host) { setState((s) => ({ ...s, loading: false, ready: true })); return; }
        const v = new BrainView(host, man.neurons, man.nt_names, man.region_names);
        fetchNeuronArrays(m, man.neurons, man.generated_at).then((a) => {
          if (gen !== genRef.current) { v.dispose(); return; }
          v.setData(a.pos, a.nt, a.region);
          if (viewRef.current) viewRef.current.dispose();
          viewRef.current = v; v.start();
          const bodyMap = new Map<string, number>();
          for (let i = 0; i < a.bodyIds.length; i++) bodyMap.set(String(a.bodyIds[i]), i);
          clientRef.current?.start();
          setState((s) => ({ ...s, loading: false, ready: true, running: true, bodyMap }));
        }).catch((e) => { v.dispose(); if (gen === genRef.current) setState((s) => ({ ...s, error: "positions: " + e, loading: false })); });
      },
      onFrame: (spikes: Int32Array, stats: FrameStats, readout: ReadoutState, regions: RegionStat[] | null) => {
        if (gen !== genRef.current) return;
        if (viewRef.current) viewRef.current.onSpikes(spikes);
        setState((s) => ({ ...s, stats, readout, regions: regions ?? s.regions }));
      },
      onSnapshot: (snap: Snapshot) => { if (gen === genRef.current) snapRef.current = snap; },
      onExperiment: (r: ExperimentResult) => { if (gen === genRef.current) setState((s) => ({ ...s, experiments: [r, ...s.experiments].slice(0, 20) })); },
      onNeuron: (d: NeuronDetail) => setState((s) => ({ ...s, selected: d })),
      onConnections: (_idx: number, dir: "out" | "in", partners: any[]) =>
        setState((s) => ({ ...s, connections: { ...s.connections, [dir]: partners } })),
      onBenchmark: (r: BenchmarkResult) => setState((s) => ({ ...s, benchmark: r })),
      onLog: (msg: string) => setState((s) => ({ ...s, log: [...s.log.slice(-120), msg] })),
      onError: (msg: string) => setState((s) => ({ ...s, error: msg, loading: false })),
    };
    const c = new SimClient(cb);
    clientRef.current = c;
    // init() fetches the manifest on the main thread; if that fails there is no
    // worker to report it, so surface it here instead of hanging on "loading".
    try {
      await c.init(m, config);
    } catch (e) {
      if (gen === genRef.current) {
        setState((s) => ({ ...s, error: `could not load ${m}: ${e instanceof Error ? e.message : String(e)}`, loading: false, ready: false }));
      }
      return;
    }
    if (statsTimer.current) clearInterval(statsTimer.current);
    // snapshot is pushed to React at ~10 Hz (spikes already go straight to the renderer)
    statsTimer.current = window.setInterval(() => {
      const snap = snapRef.current;
      if (snap && genRef.current === gen) setState((s) => (s.snap === snap ? s : { ...s, snap }));
    }, 100);
  }, [config]);

  useEffect(() => { boot(mode); return () => { genRef.current++; clientRef.current?.terminate(); if (viewRef.current) { viewRef.current.dispose(); viewRef.current = null; } if (statsTimer.current) clearInterval(statsTimer.current); }; }, [mode]); // eslint-disable-line

  const c = () => clientRef.current;
  const api = {
    start: () => { c()?.start(); setState((s) => ({ ...s, running: true })); },
    stop: () => { c()?.stop(); setState((s) => ({ ...s, running: false })); },
    step: (n = 10) => { c()?.step(n); setState((s) => ({ ...s, running: false })); },
    resetWorld: () => c()?.resetWorld(),
    forceEat: (amount: number) => c()?.forceEat(amount),
    select: (index: number) => c()?.selectNeuron(index),
    query: (index: number, dir: "out" | "in", limit = 64) => c()?.queryConnections(index, dir, limit),
    ablate: (kind: "neuron" | "region", value: number) => c()?.ablate(kind, value),
    restore: () => c()?.restore(),
    runExperiment: (id: string, trials?: number) => c()?.runExperiment(id, trials ?? 8),
    benchmark: (ticks = 2000) => c()?.benchmark(ticks),
    setPlasticity: (on: boolean) => c()?.setPlasticity(on, "three"),
    setConfig: (patch: Partial<SimConfig>) => { const merged = structuredClone(config); Object.assign(merged, patch); setConfigState(merged); c()?.setConfig(patch); },
    setLif: (patch: Partial<SimConfig["lif"]>) => { const merged = { ...config, lif: { ...config.lif, ...patch } }; setConfigState(merged); c()?.setConfig({ lif: merged.lif }); },
    setPhysio: (patch: Partial<SimConfig["physio"]>) => { const merged = { ...config, physio: { ...config.physio, ...patch } }; setConfigState(merged); c()?.setConfig({ physio: merged.physio }); },
    setDopamine: (patch: Partial<SimConfig["dopamine"]>) => { const merged = { ...config, dopamine: { ...config.dopamine, ...patch } }; setConfigState(merged); c()?.setConfig({ dopamine: merged.dopamine }); },
    setExplore: (v: number) => { const merged = { ...config, action: { ...config.action, explore: v } }; setConfigState(merged); c()?.setConfig({ action: merged.action }); },
    setSpeed: (t: number) => { const merged = { ...config, ticksPerFrame: t }; setConfigState(merged); c()?.setSpeed(t); },
    setDeterministic: (b: boolean) => { const merged = { ...config, deterministic: b }; setConfigState(merged); c()?.setConfig({ deterministic: b }); },
    setColorMode: (m: "nt" | "region") => viewRef.current?.setColorMode(m),
  };
  return { state, api, MODE_LABELS };
}
