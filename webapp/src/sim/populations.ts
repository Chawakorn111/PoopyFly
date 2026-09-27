// Deterministic selection of PoopFly I/O populations from REAL MaleCNS neurons.
//
// This is a MODEL ASSUMPTION (documented): MaleCNS has no native "defecate" or
// "song A" neurons, so we designate real neurons as interoceptive drive pools
// and motor readout pools. The choice is fully deterministic (sorted by real
// graph properties, ties broken by index) and NEVER random, and the original
// body ids remain the ground truth the debugger can trace back to.
//
//   drive pools  (sensory/intero input)  -> neurons with high OUT-degree
//   motor pools  (behavioural readout)   -> neurons with high IN-degree
//   dopamine pool                        -> neurons predicted DA
//
// Drive and motor pools are kept disjoint where the graph is large enough.

export interface PopGraph {
  N: number;
  outDeg: Int32Array;
  inDeg: Int32Array;
  ntCode: Uint8Array;
}

export interface SelectedPops {
  drives: Record<string, Int32Array>;
  actions: Record<string, Int32Array>;
  da: Int32Array;
}

function sortedBy(arr: Int32Array, desc: boolean): Int32Array {
  const idx = Int32Array.from({ length: arr.length }, (_, i) => i);
  const cmp = desc ? (a: number, b: number) => arr[b] - arr[a] || a - b
                   : (a: number, b: number) => arr[a] - arr[b] || a - b;
  return idx.sort(cmp);
}

/** nt code for dopamine, if the caller passes NT_DA index; default code 3 (DA). */
export function selectPopulations(g: PopGraph, actionNames: string[], driveNames: string[],
  actionPopSize: number, drivePopSize: number, daCode = 3): SelectedPops {
  const used = new Set<number>();
  // dopamine = neurons predicted to be DA (real neurotransmitter data)
  const daArr: number[] = [];
  for (let i = 0; i < g.N; i++) if (g.ntCode[i] === daCode) daArr.push(i);
  const da = Int32Array.from(daArr);

  const driveOrder = sortedBy(g.outDeg, true);
  const actionOrder = sortedBy(g.inDeg, true);

  function take(order: Int32Array, size: number): Int32Array {
    const out: number[] = [];
    for (let k = 0; k < order.length && out.length < size; k++) {
      const i = order[k];
      if (used.has(i)) continue;
      out.push(i);
    }
    if (out.length < size) { // tiny graph: allow reuse rather than fail (documented)
      for (let k = 0; k < order.length && out.length < size; k++) out.push(order[k]);
    }
    for (const i of out) used.add(i);
    return Int32Array.from(out.length ? out : [0]);
  }

  const drives: Record<string, Int32Array> = {};
  for (const d of driveNames) drives[d] = take(driveOrder, Math.max(1, Math.min(drivePopSize, g.N)));
  const actions: Record<string, Int32Array> = {};
  for (const a of actionNames) actions[a] = take(actionOrder, Math.max(1, Math.min(actionPopSize, g.N)));

  return { drives, actions, da };
}
