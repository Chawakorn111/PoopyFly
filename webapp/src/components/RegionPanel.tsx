import type { RegionStat } from "../sim/protocol";

export function RegionPanel({ regions }: { regions: RegionStat[] | null }) {
  if (!regions || regions.length === 0) return <div className="empty">No region activity yet — run the simulation.</div>;
  const max = Math.max(1, ...regions.map((r) => r.spikes));
  return (
    <div className="region">
      <h3>Neuropil activity <span className="muted">(actual simulated spikes, aggregated by anatomical region)</span></h3>
      <table>
        <thead><tr><th>region</th><th>neurons</th><th>active</th><th>spikes</th><th>rate Hz</th></tr></thead>
        <tbody>
          {regions.slice(0, 60).map((r) => (
            <tr key={r.code}>
              <td>{r.name}</td>
              <td>{r.neurons.toLocaleString()}</td>
              <td>{r.activeNeurons.toLocaleString()}</td>
              <td><div className="bar"><i style={{ width: `${(r.spikes / max) * 100}%` }} />{r.spikes.toLocaleString()}</div></td>
              <td>{r.rateHz.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
