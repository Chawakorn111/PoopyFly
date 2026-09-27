import type { SimState } from "../hooks/useSimulator";

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="muted">run more trials…</div>;
  const max = Math.max(...data), min = Math.min(...data, 0);
  const w = 260, h = 60;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * h}`).join(" ");
  const improving = data[data.length - 1] < data[0];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={pts} fill="none" stroke={improving ? "#6bd08f" : "#ff6b6b"} strokeWidth={2} />
    </svg>
  );
}

export function LearningPanel({ state }: { state: SimState }) {
  const s = state.snap;
  if (!s) return <div className="empty">loading…</div>;
  const m = s.metrics, p = s.plasticity;
  return (
    <div className="learning">
      <div className="grid">
        <div><b>{m.trials}</b><span>trials</span></div>
        <div><b>{m.successPoops}</b><span>successful poops</span></div>
        <div><b>{m.avgTimeToDefecateMs.toFixed(0)}</b><span>avg time→defecate ms</span></div>
        <div><b>{p.changedEdges.toLocaleString()}</b><span>synapses changed</span></div>
        <div><b>{m.rewardEvents}</b><span>reward events</span></div>
        <div><b>{m.punishmentEvents}</b><span>punishment</span></div>
        <div><b>{m.dopaminePulses}</b><span>dopamine pulses</span></div>
        <div><b>{p.potentiated}/{p.depressed}</b><span>potent/depress</span></div>
      </div>
      <h4>time-to-defecate across trials (downward = behavioural adaptation)</h4>
      <Spark data={m.timeToDefecateSeries} />
      <div className="muted">Learning is only claimed if behaviour adapts, not merely because weights changed. Run the Experiments tab for OFF-vs-ON comparisons.</div>
    </div>
  );
}
