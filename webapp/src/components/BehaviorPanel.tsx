import type { SimState } from "../hooks/useSimulator";

const PRIMARY = ["MOVE_LEFT", "MOVE_RIGHT", "MOVE_FORWARD", "STOP", "EAT", "DEFECATE"];
const MUSIC = ["PLAY_MUSIC", "STOP_MUSIC", "SONG_A", "SONG_B", "SONG_C"];

function Bars({ names, rates, selected, color }: { names: string[]; rates: Map<string, number>; selected: string | null; color: string }) {
  const max = Math.max(1e-6, ...names.map((n) => rates.get(n) ?? 0));
  return (
    <div className="bars">
      {names.map((n) => (
        <div key={n} className={`barrow ${n === selected ? "sel" : ""}`}>
          <span className="bl">{n.replace("_", " ").toLowerCase()}</span>
          <span className="btrack"><i style={{ width: ((rates.get(n) ?? 0) / max) * 100 + "%", background: color }} /></span>
          <span className="bv">{(rates.get(n) ?? 0).toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

export function BehaviorPanel({ state }: { state: SimState }) {
  const s = state.snap;
  if (!s) return <div className="empty">loading behaviour…</div>;
  const rates = new Map(s.actionRates.map((a) => [a.name, a.rate] as const));
  const m = s.metrics;
  const chain = ["gut pressure", `${s.vitals.gutPressure.toFixed(2)}`, "→ intero firing", `${m.interoFiringHz.toFixed(0)} Hz`, "→ motor readout", "→ action", s.currentAction ?? "—"];
  return (
    <div className="behav">
      <div className="chain">{chain.map((x, i) => <span key={i} className={i === chain.length - 1 ? "act" : (i % 2 === 0 ? "lbl" : "val")}>{x}</span>)}</div>
      <div className="cols">
        <div>
          <h4>Motor readout (neural)</h4>
          <Bars names={PRIMARY} rates={rates} selected={s.currentAction} color="#4d9fff" />
        </div>
        <div>
          <h4>Music decision (neural)</h4>
          <Bars names={MUSIC} rates={rates} selected={s.currentAction} color="#c084fc" />
        </div>
      </div>
      <div className="mini">motor drive {m.motorDriveHz.toFixed(1)}Hz · reward {s.reward.toFixed(3)} · dopamine {s.dopamine.toFixed(2)} · pulses {m.dopaminePulses} · changes {m.weightChangeEvents}</div>
    </div>
  );
}
