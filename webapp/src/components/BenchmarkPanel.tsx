import { useEffect, useState } from "react";
import { DATA_BASE } from "../sim/client";
import type { BenchmarkResult, Manifest } from "../sim/protocol";

interface Summary { [mode: string]: { neurons: number; edges: number; bytes_total: number; build_seconds: number } }

export function BenchmarkPanel({ benchmark, onRun, manifest }: { benchmark: BenchmarkResult | null; onRun: () => void; manifest: Manifest | null }) {
  const [sum, setSum] = useState<Summary | null>(null);
  useEffect(() => { fetch(`${DATA_BASE}/data/build_summary.json`).then((r) => r.json()).then(setSum).catch(() => {}); }, []);

  return (
    <div className="bench">
      <h3>Benchmark <button onClick={onRun} disabled={!manifest}>run benchmark on current mode</button></h3>
      {benchmark ? (
        <div className="grid">
          <div><b>{benchmark.mode}</b><span>mode</span></div>
          <div><b>{benchmark.neurons.toLocaleString()}</b><span>neurons</span></div>
          <div><b>{benchmark.edges.toLocaleString()}</b><span>connections</span></div>
          <div><b>{(benchmark.approxMemoryBytes / 1e6).toFixed(0)} MB</b><span>kernel RAM</span></div>
          <div><b>{benchmark.initSeconds.toFixed(1)} s</b><span>init/load</span></div>
          <div><b>{benchmark.ticks}</b><span>ticks</span></div>
          <div><b>{benchmark.msPerTick.toFixed(4)}</b><span>ms/tick</span></div>
          <div><b>{benchmark.spikesPerTick.toFixed(0)}</b><span>spikes/tick</span></div>
          <div><b>{benchmark.realTimeFactor.toFixed(2)}×</b><span>real-time factor</span></div>
          <div><b>{benchmark.peakActiveNeurons.toLocaleString()}</b><span>peak active</span></div>
        </div>
      ) : <div className="muted">Press benchmark to time the kernel on the loaded graph.</div>}

      <h4>Dataset graph sizes (measured by the pipeline)</h4>
      <table>
        <thead><tr><th>mode</th><th>neurons</th><th>connections</th><th>runtime MB</th></tr></thead>
        <tbody>
          {sum && Object.entries(sum).map(([m, v]) => (
            <tr key={m}><td>{m}</td><td>{v.neurons.toLocaleString()}</td><td>{v.edges.toLocaleString()}</td><td>{(v.bytes_total / 1e6).toFixed(0)}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="hint">If the browser cannot run FULL in real time, that is reported here — the graph is never silently reduced. Modes are the same real MaleCNS graph, only different neuron-count subsets (all real hubs / real bodies).</div>
    </div>
  );
}
