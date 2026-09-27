import type { SimState } from "../hooks/useSimulator";

export function ControlPanel({ state, api }: { state: SimState; api: any }) {
  return (
    <div className="ctrl">
      {state.running
        ? <button onClick={api.stop}>pause</button>
        : <button onClick={api.start}>run</button>}
      <button onClick={() => api.step(50)} disabled={state.running}>step 5ms</button>
      <button onClick={api.resetWorld}>reset world</button>
      <button onClick={() => api.forceEat(0.6)}>force-eat</button>

      <label className="tog"><input type="checkbox" checked={!!state.snap?.plasticity.enabled} onChange={(e) => api.setPlasticity(e.target.checked)} /> plasticity (3-factor)</label>
      <label>explore <input type="range" min={0} max={0.8} step={0.05} defaultValue={0.3} onChange={(e) => api.setExplore(+e.target.value)} /></label>
      <label>w-scale <input type="number" step={0.01} defaultValue={0.05} onChange={(e) => api.setLif({ weightScale: +e.target.value })} /></label>
      <label>dop gain <input type="number" step={0.5} defaultValue={6} onChange={(e) => api.setDopamine({ gain: +e.target.value })} /></label>
      <label>colour{" "}
        <select onChange={(e) => api.setColorMode(e.target.value)}>
          <option value="nt">neurotransmitter</option><option value="region">neuropil</option>
        </select>
      </label>
      <span className="hint">the {state.snap ? state.snap.vitals.state : "IDLE"} fly decides actions from motor-population firing rates; force-eat only perturbs the gut (env), it never forces a decision.</span>
    </div>
  );
}
