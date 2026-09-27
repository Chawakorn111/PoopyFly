import type { SimState } from "../hooks/useSimulator";

function Bar({ label, v, color }: { label: string; v: number; color: string }) {
  const pct = Math.max(0, Math.min(1, v)) * 100;
  return (
    <div className="gauge">
      <div className="glabel"><span>{label}</span><b>{v.toFixed(2)}</b></div>
      <div className="gtrack"><i style={{ width: pct + "%", background: color }} /></div>
    </div>
  );
}

export function VitalsPanel({ state }: { state: SimState }) {
  const v = state.snap?.vitals;
  if (!v) return <div className="empty">loading physiology…</div>;
  const c = state.manifest ? null : null; void c;
  return (
    <div className="vitals">
      <div className="vh"><span className={`fsm ${v.defecating ? "poop" : v.state === "SEARCH_TOILET" ? "search" : ""}`}>{v.state}</span>{v.defecating && <span className="emoji">defecating</span>}</div>
      <Bar label="gut content" v={v.gutContent} color="#e0a15e" />
      <Bar label="gut pressure" v={v.gutPressure} color="#ff6b6b" />
      <Bar label="urge" v={v.urge} color="#ff9f4d" />
      <Bar label="comfort" v={v.comfort} color="#6bd08f" />
      <Bar label="energy" v={v.energy} color="#4d9fff" />
      <div className="track1d">
        <span className="food">food</span>
        <span className="fly" style={{ left: `${v.position * 100}%` }}>fly</span>
        <span className="toilet">toilet</span>
      </div>
    </div>
  );
}
