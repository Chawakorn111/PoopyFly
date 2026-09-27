import { useEffect, useRef, useState } from "react";
import type { SimState } from "../hooks/useSimulator";
import { DATA_BASE } from "../sim/client";

interface Synapse { body_id: string; synapse_point_count?: number; kind_counts?: Record<string, number>; compartment_counts?: Record<string, number>; neurotransmitter?: { prediction: string; confidence: number; tbar_count: number }; out_partner_count?: number; in_partner_count?: number; top_out_partners?: any[]; top_in_partners?: any[]; }

export function Debugger({ state, api }: { state: SimState; api: any }) {
  const [q, setQ] = useState("0");
  const [watching, setWatching] = useState(false);
  const [regionCode, setRegionCode] = useState(0);
  const [syn, setSyn] = useState<Synapse | null>(null);
  const d = state.selected;

  const resolve = (s: string): number => {
    const t = s.trim();
    if (/^\d+$/.test(t)) {
      if (state.bodyMap.has(t)) return state.bodyMap.get(t)!;   // treat as body id
      return +t;                                                 // treat as runtime index
    }
    return 0;
  };

  const qRef = useRef(q);
  const resolveRef = useRef(resolve);
  qRef.current = q;
  resolveRef.current = resolve;

  useEffect(() => {
    setSyn(null);
    if (!d) return;
    let alive = true;
    fetch(`${DATA_BASE}/data/synapse/${d.bodyId}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setSyn(j); })
      .catch(() => {});
    return () => { alive = false; };
  }, [d?.bodyId]); // eslint-disable-line

  const inspect = () => { const i = resolve(q); api.select(i); api.query(i, "out"); api.query(i, "in"); };

  useEffect(() => {
    if (!watching) return;
    const id = setInterval(() => api.select(resolveRef.current(qRef.current)), 500);
    return () => clearInterval(id);
  }, [watching]); // eslint-disable-line

  return (
    <div className="dbg">
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="neuron index or MaleCNS body id" />
        <button onClick={inspect}>inspect</button>
        <label className="chk"><input type="checkbox" checked={watching} onChange={(e) => setWatching(e.target.checked)} /> watch</label>
        <button onClick={() => { const i = resolve(q); api.ablate("neuron", i); api.select(i); }}>disable neuron</button>
        <button onClick={() => api.restore()}>restore all</button>
      </div>
      <div className="row">
        <label>ablate region{" "}
          <select value={regionCode} onChange={(e) => setRegionCode(+e.target.value)}>
            {(state.regions ?? []).map((r) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
          </select>
        </label>
        <button onClick={() => api.ablate("region", regionCode)}>disable region</button>
      </div>
      {d && (
        <div className="detail">
          <div className="grid">
            <div><b>{d.index}</b><span>runtime idx</span></div>
            <div><b>{d.bodyId}</b><span>MaleCNS body</span></div>
            <div><b>{d.nt}</b><span>NT</span></div>
            <div><b>{d.region}</b><span>neuropil</span></div>
            <div><b>{typeof d.v === "number" ? d.v.toFixed(2) : "—"}</b><span>V (mV)</span></div>
            <div><b>{d.spikeCount ?? 0}</b><span>spikes</span></div>
            <div><b>{typeof d.rateHz === "number" ? d.rateHz.toFixed(1) : "—"}</b><span>rate Hz</span></div>
            <div><b>{d.inDegree ?? 0}/{d.outDegree ?? 0}</b><span>in/out deg</span></div>
            <div><b>{d.disabled ? "yes" : "no"}</b><span>disabled</span></div>
            <div><b>{d.refractory ? "yes" : "no"}</b><span>refractory</span></div>
          </div>
          <div className="conn">
            <div>
              <h4>Outgoing ({d.outDegree})</h4>
              <ul>{state.connections.out.slice(0, 12).map((p: any, i: number) => <li key={i}>→ #{p.index} body {p.bodyId} · w {p.weight} · {p.nt} · {p.region}</li>)}</ul>
            </div>
            <div>
              <h4>Incoming ({d.inDegree})</h4>
              <ul>{state.connections.in.slice(0, 12).map((p: any, i: number) => <li key={i}>← #{p.index} body {p.bodyId} · w {p.weight} · {p.nt} · {p.region}</li>)}</ul>
            </div>
          </div>
          <div className="syn">
            <h4>Detailed synapses</h4>
            {syn ? (
              <div>
                <div className="muted">from syn-points / syn-partners / tbar (streamed offline via pipeline/synapse_detail.py)</div>
                <div className="synrow">
                  <span>synaptic sites: <b>{syn.synapse_point_count?.toLocaleString()}</b></span>
                  {syn.neurotransmitter && <span>NT: <b>{syn.neurotransmitter.prediction}</b> ({(syn.neurotransmitter.confidence * 100).toFixed(0)}%, {syn.neurotransmitter.tbar_count} t-bars)</span>}
                  <span>partners out/in: <b>{syn.out_partner_count}</b>/<b>{syn.in_partner_count}</b></span>
                </div>
                <div className="synrow">{Object.entries(syn.kind_counts ?? {}).map(([k, v]) => <span key={k} className="chip">{k}: {(v as number).toLocaleString()}</span>)}{Object.entries(syn.compartment_counts ?? {}).map(([k, v]) => <span key={k} className="chip">{k}: {(v as number).toLocaleString()}</span>)}</div>
                <div className="synrow muted">top partners: {(syn.top_out_partners ?? []).slice(0, 6).map((p: any) => `${p.body}(${p.synapses})`).join(", ")}</div>
              </div>
            ) : <div className="muted">No extracted synapse file for body {d.bodyId}. Run: python pipeline/synapse_detail.py --body-id {d.bodyId}</div>}
          </div>
        </div>
      )}
      <div className="hint">Membrane potential, spike count and firing rate are read live from the simulator. Disabling a neuron/region blocks it from integrating and propagating — compare the readout / neuropil panels before vs after.</div>
    </div>
  );
}
