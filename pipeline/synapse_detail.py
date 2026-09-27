"""On-demand, memory-safe synapse-detail extraction for a single MaleCNS neuron.

The full `syn-points` (13 GB) and `syn-partners` (6.8 GB) tables are NEVER loaded
into the browser. Instead, for a chosen body id we stream the relevant feather
files batch-by-batch and keep only that neuron's rows, writing a compact JSON to
data/synapse/<body_id>.json that the webapp can lazily fetch.

    python pipeline/synapse_detail.py --mode core --index 1234
    python pipeline/synapse_detail.py --body-id 10003
    python pipeline/synapse_detail.py --body-id 10003 --max-points 5000

All raw files are read-only (memory-mapped). Original MaleCNS IDs are preserved.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from malecns_common import RAW, NT_PROB_COLS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "webapp", "public", "data")
OUT = os.path.join(DATA, "synapse")


def raw(key):
    return os.path.join(ROOT, RAW[key])


def resolve_body_id(args):
    if args.body_id is not None:
        return int(args.body_id), None
    man = json.load(open(os.path.join(DATA, args.mode, "manifest.json")))
    n = man["neurons"]
    b = np.fromfile(os.path.join(DATA, args.mode, "neurons.bodyid.i64.bin"), dtype="<i8", count=n)
    return int(b[args.index]), args.index


def openr(path):
    src = pa.memory_map(path, "r")
    return pa.ipc.open_file(src)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="core")
    ap.add_argument("--index", type=int)
    ap.add_argument("--body-id", type=int)
    ap.add_argument("--max-points", type=int, default=20000, help="cap stored synapse points")
    ap.add_argument("--top-partners", type=int, default=40)
    ap.add_argument("--max-batches", type=int, default=0, help="cap feather batches scanned (0 = all); for quick previews/testing")
    args = ap.parse_args()
    if args.body_id is None and args.index is None:
        ap.error("give --body-id or (--mode --index)")
    capb = lambda reader: (reader.num_record_batches if args.max_batches == 0
                           else min(args.max_batches, reader.num_record_batches))

    body_id, index = resolve_body_id(args)
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    result = {"body_id": str(body_id), "runtime_index": index, "mode": args.mode}

    # --- syn-points: this neuron's own synaptic sites (pre/post), NT, region ---
    r = openr(raw("syn_points"))
    pts = []
    kind_counts = {}
    n_syn = 0
    comp_counts = {}
    for i in range(capb(r)):
        b = r.get_batch(i)
        body = b.column("body").to_numpy(zero_copy_only=False)
        sel = np.where(body == body_id)[0]
        if sel.size == 0:
            continue
        n_syn += int(sel.size)
        kind = b.column("kind").to_pylist()
        comp = b.column("compartment").to_pylist()
        x = b.column("x").to_numpy(zero_copy_only=False)
        y = b.column("y").to_numpy(zero_copy_only=False)
        z = b.column("z").to_numpy(zero_copy_only=False)
        for s in sel[:max(0, args.max_points - len(pts))]:
            pts.append({"x": int(x[s]), "y": int(y[s]), "z": int(z[s]), "kind": str(kind[s])})
            k = str(kind[s]); kind_counts[k] = kind_counts.get(k, 0) + 1
            cc = str(comp[s]); comp_counts[cc] = comp_counts.get(cc, 0) + 1
    result["synapse_point_count"] = n_syn
    result["stored_points"] = len(pts)
    result["kind_counts"] = kind_counts
    result["compartment_counts"] = comp_counts
    if n_syn:
        result["nt_points"] = sorted(pts, key=lambda p: (p["x"], p["y"], p["z"]))[:200]

    # authoritative per-body neurotransmitter (aggregated over ALL 45.6M t-bars in
    # Stage C of the pipeline) rather than a partial syn-points scan.
    cache = os.path.join(ROOT, "data", "_cache")
    try:
        bodies = np.load(os.path.join(cache, "tbar_bodies.npy"))
        attrs = np.load(os.path.join(cache, "body_attrs.npz"))
        pos = int(np.searchsorted(bodies, body_id))
        if pos < bodies.size and bodies[pos] == body_id:
            from malecns_common import NT_NAMES
            code = int(attrs["nt_code"][pos])
            result["neurotransmitter"] = {
                "prediction": NT_NAMES[code] if code < len(NT_NAMES) else "UNKNOWN",
                "confidence": round(float(attrs["nt_prob"][pos]), 4),
                "tbar_count": int(attrs["tbars"][pos]),
            }
    except Exception as e:  # cache optional
        result["neurotransmitter_error"] = str(e)

    # --- syn-partners: actual partner neurons + contact counts + confidence ---
    r = openr(raw("syn_partners"))
    out_partners: dict[int, dict] = {}
    in_partners: dict[int, dict] = {}
    for i in range(capb(r)):
        b = r.get_batch(i)
        bp = b.column("body_pre").to_numpy(zero_copy_only=False)
        bq = b.column("body_post").to_numpy(zero_copy_only=False)
        cp = b.column("conf_pre").to_numpy(zero_copy_only=False)
        cq = b.column("conf_post").to_numpy(zero_copy_only=False)
        op = np.where(bp == body_id)[0]
        if op.size:
            for s in op:
                k = int(bq[s]); d = out_partners.setdefault(k, {"count": 0, "conf": 0.0})
                d["count"] += 1; d["conf"] += float(cq[s])
        ip = np.where(bq == body_id)[0]
        if ip.size:
            for s in ip:
                k = int(bp[s]); d = in_partners.setdefault(k, {"count": 0, "conf": 0.0})
                d["count"] += 1; d["conf"] += float(cp[s])
    result["out_partner_count"] = len(out_partners)
    result["in_partner_count"] = len(in_partners)
    result["top_out_partners"] = sorted(
        ({"body": str(k), "synapses": v["count"], "mean_conf": round(v["conf"] / v["count"], 3)}
         for k, v in out_partners.items()), key=lambda d: -d["synapses"])[: args.top_partners]
    result["top_in_partners"] = sorted(
        ({"body": str(k), "synapses": v["count"], "mean_conf": round(v["conf"] / v["count"], 3)}
         for k, v in in_partners.items()), key=lambda d: -d["synapses"])[: args.top_partners]

    result["extract_seconds"] = round(time.time() - t0, 1)
    path = os.path.join(OUT, f"{body_id}.json")
    json.dump(result, open(path, "w"), indent=2)
    print("WROTE", path)
    print(json.dumps({k: v for k, v in result.items() if k not in ("nt_points",)}, indent=2)[:2000])


if __name__ == "__main__":
    main()
