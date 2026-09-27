import type { SimState } from "../hooks/useSimulator";

export function MusicPanel({ state }: { state: SimState }) {
  const mus = state.snap?.music;
  if (!mus) return <div className="empty">loading music…</div>;
  const tot = Math.max(1, mus.prefs.reduce((a, p) => a + p.picks, 0));
  return (
    <div className="music">
      <div className="vh">
        now playing: <b>{mus.current ? `Song ${mus.current}` : "silence"}</b>
        <span className="muted"> · preference is learned, not hardcoded</span>
      </div>
      {mus.prefs.map((p) => (
        <div key={p.song} className="songrow">
          <span className="sname">Song {p.song}</span>
          <span className="ptrack"><i style={{ width: (p.picks / tot) * 100 + "%" }} /></span>
          <span className="sval">consequence {p.value >= 0 ? "+" : ""}{p.value.toFixed(1)}</span>
          <span className="spicks">{p.picks} picks · {p.defecations} w/ defecation</span>
        </div>
      ))}
      <div className="legend">
        The fly discovers Song A pleasant / C aversive by the dopamine its consequence adds to relief;
        over trials the pleasant song's selection pathway is reinforced.
      </div>
    </div>
  );
}