"""Memory-safe inspection of raw MaleCNS v1.0 feather datasets.

Reads schema + row counts cheaply (memory-mapped Arrow IPC), streams record
batches one at a time, and never materialises the multi-GB synapse tables.
"""
import json
import os
import sys

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FILES = {
    "connectome_weights": "connectome-weights-male-cns-v1.0-minconf-0.5.feather",
    "tbar_nt": "tbar-neurotransmitters-male-cns-v1.0.feather",
    "syn_partners": "syn-partners-male-cns-v1.0-minconf-0.5.feather",
    "syn_points": "syn-points-male-cns-v1.0-minconf-0.5.feather",
}


def open_reader(path):
    """Open an Arrow IPC file (feather v2); fall back to stream format."""
    try:
        src = pa.memory_map(path, "r")
        return pa.ipc.open_file(src), "file"
    except Exception:
        src = pa.memory_map(path, "r")
        return pa.ipc.open_stream(src), "stream"


def schema_report(path, sample_batches=1):
    reader, kind = open_reader(path)
    schema = reader.schema
    info = {
        "format": kind,
        "fields": [(f.name, str(f.type)) for f in schema],
    }
    if kind == "file":
        info["num_record_batches"] = reader.num_record_batches
    return reader, kind, info


def count_rows(reader, kind):
    n = 0
    if kind == "file":
        for i in range(reader.num_record_batches):
            n += reader.get_batch(i).num_rows
    else:
        for b in reader:
            n += b.num_rows
    return n


def inspect_connectome(path):
    reader, kind, info = schema_report(path)
    print("connectome-weights schema:", info["fields"], "batches:", info.get("num_record_batches"))
    cols = [f.name for f in reader.schema]
    pre_col = next((c for c in cols if "pre" in c.lower()), None)
    post_col = next((c for c in cols if "post" in c.lower()), None)
    w_col = next((c for c in cols if "weight" in c.lower() or c.lower() in ("w", "val")), None)
    print("  pre=%s post=%s weight=%s" % (pre_col, post_col, w_col))

    pre_set = set()
    post_set = set()
    n = 0
    w_sum = 0
    w_min = None
    w_max = None
    nb = reader.num_record_batches if kind == "file" else None
    batches = range(nb) if kind == "file" else reader
    for i in batches:
        b = reader.get_batch(i) if kind == "file" else i
        n += b.num_rows
        if pre_col:
            pre_set.update(pc.unique(b.column(pre_col)).to_pylist())
        if post_col:
            post_set.update(pc.unique(b.column(post_col)).to_pylist())
        if w_col:
            arr = b.column(w_col).to_numpy(zero_copy_only=False)
            if arr.size:
                w_sum += int(arr.sum(dtype=np.int64))
                bmin = int(arr.min()); bmax = int(arr.max())
                w_min = bmin if w_min is None else min(w_min, bmin)
                w_max = bmax if w_max is None else max(w_max, bmax)
        if (i if isinstance(i, int) else n) % 50 == 0:
            print("   ...rows=%d uniqpre=%d uniqpost=%d" % (n, len(pre_set), len(post_set)), flush=True)

    all_ids = pre_set | post_set
    result = {
        "edges": n,
        "unique_pre": len(pre_set),
        "unique_post": len(post_set),
        "unique_neurons_union": len(all_ids),
        "weight_sum": w_sum,
        "weight_min": w_min,
        "weight_max": w_max,
        "weight_mean": (w_sum / n) if n else None,
    }
    print("CONNECTOME RESULT:", json.dumps(result, indent=2))
    return result, all_ids


def inspect_generic(path, name, sample_rows=5):
    reader, kind, info = schema_report(path)
    print("%s schema:" % name, info["fields"])
    b0 = reader.get_batch(0) if kind == "file" else next(iter(reader))
    tbl = pa.Table.from_batches([b0.slice(0, sample_rows)])
    print("  sample:")
    print(tbl.to_pandas().to_string())
    return info


def main():
    out = {}
    for key, fn in FILES.items():
        p = os.path.join(ROOT, fn)
        if not os.path.exists(p):
            print("MISSING FILE:", fn)
            continue
        sz = os.path.getsize(p) / 1e9
        print("\n=== %s (%.2f GB) ===" % (fn, sz))
        if key == "connectome_weights":
            res, _ = inspect_connectome(p)
            out[key] = res
        else:
            out[key] = inspect_generic(p, key)

    with open(os.path.join(HERE, "_inspect_result.json"), "w") as f:
        json.dump(out, f, indent=2, default=str)
    print("\nWROTE _inspect_result.json")


if __name__ == "__main__":
    main()
