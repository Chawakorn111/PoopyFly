import type { Manifest } from "../sim/protocol";

export function IntegrityPanel({ manifest }: { manifest: Manifest | null }) {
  if (!manifest) return <div className="empty">Load a mode to see its integrity report.</div>;
  const i = manifest.integrity;
  const cv = i.connectome_validation ?? {};
  const ab = i.authoritative_bodies ?? {};
  const rows: [string, any][] = [
    ["mode", i.mode],
    ["neurons (measured)", i.neurons?.toLocaleString()],
    ["edges (measured)", i.edges?.toLocaleString()],
    ["mean out-degree", i.mean_out_degree?.toFixed(1)],
    ["isolated neurons", i.isolated_neurons],
    ["duplicate pairs summed", i.duplicate_pairs_summed],
    ["self-loops", i.self_loops],
    ["NT coverage", i.nt_coverage != null ? (i.nt_coverage * 100).toFixed(1) + "%" : "—"],
    ["region coverage", i.region_coverage != null ? (i.region_coverage * 100).toFixed(1) + "%" : "—"],
    ["position coverage", i.position_coverage != null ? (i.position_coverage * 100).toFixed(1) + "%" : "—"],
    ["raw connectome edges", cv.total_edges_raw?.toLocaleString()],
    ["valid edges kept", cv.valid_edges?.toLocaleString()],
    ["edges filtered out", cv.filtered_edges?.toLocaleString()],
    ["% post ids invalid", cv.frac_post_invalid != null ? (cv.frac_post_invalid * 100).toFixed(1) + "%" : "—"],
    ["authoritative bodies", ab.unique_bodies?.toLocaleString()],
    ["  small-id neurons", ab.unique_small_lt_1e6?.toLocaleString()],
    ["  large-id fragments", ab.unique_large_ge_1e6?.toLocaleString()],
    ["all body ids fit int32", String(ab.all_ids_fit_int32)],
    ["missing source files", (i.missing_source_files ?? []).join(", ") || "none"],
    ["neuron policy", i.neuron_policy],
  ];
  return (
    <div className="integrity">
      <h3>Data integrity report <span className="muted">(measured vs provided MaleCNS data — never theoretical)</span></h3>
      <div className="note">{i.note}</div>
      <table>
        <tbody>{rows.map(([k, v], i) => <tr key={i}><td>{k}</td><td>{String(v ?? "—")}</td></tr>)}</tbody>
      </table>
      <div className="ntcounts">
        <h4>Neurotransmitter populations</h4>
        <div>{Object.entries(i.nt_counts ?? {}).map(([k, n]: any) => <span key={k} className="chip">{k}: {Number(n).toLocaleString()}</span>)}</div>
        <h4>Regions present</h4>
        <div>{Object.entries(i.region_counts ?? {}).map(([k, n]: any) => <span key={k} className="chip">{k}: {Number(n).toLocaleString()}</span>)}</div>
      </div>
    </div>
  );
}
