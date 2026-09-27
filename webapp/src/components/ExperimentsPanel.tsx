import type { SimState } from "../hooks/useSimulator";

const EXP: { id: string; title: string }[] = [
  { id: "A", title: "A · high pressure → observe behaviour" },
  { id: "B", title: "B · defecation → homeostatic improvement" },
  { id: "C", title: "C · no reward" },
  { id: "D", title: "D · reward enabled" },
  { id: "E", title: "E · plasticity OFF" },
  { id: "F", title: "F · plasticity ON (learning)" },
  { id: "G", title: "G · song preference learning" },
  { id: "H", title: "H · ablate reinforcement" },
  { id: "I", title: "I · ablate interoception" },
];

export function ExperimentsPanel({ state, api }: { state: SimState; api: any }) {
  return (
    <div className="exps">
      <p className="muted">Repeatable headless runs. Each reconfigures physiology/plasticity/reinforcement and reports measured outcomes. Plasticity-heavy experiments run in the worker and can take a moment.</p>
      <div className="expbtns">
        {EXP.map((e) => (
          <button key={e.id} onClick={() => api.runExperiment(e.id)}>{e.title}</button>
        ))}
      </div>
      <div className="expresults">
        {state.experiments.length === 0 && <div className="muted">run an experiment…</div>}
        {state.experiments.map((r, i) => (
          <div key={i} className="expres">
            <div className="eh"><b>{r.id}</b> {r.label} <span className="muted">— {r.note}</span></div>
            <div className="esum">{Object.entries(r.summary).map(([k, v]) => <span key={k} className="chip">{k}: {String(v)}</span>)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
