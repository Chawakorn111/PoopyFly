"""Validate exported runtime graphs (CSR/CSC + per-neuron arrays) for integrity.

Proves the binary files the browser loads are self-consistent and match the
manifest counts. Used by the test suite (section 27) and as a build gate.

    python pipeline/validate_runtime.py --mode core
    python pipeline/validate_runtime.py --mode full --quick
"""
import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rd(d, name, dtype, count):
    p = os.path.join(d, name)
    a = np.fromfile(p, dtype=dtype)
    assert a.size == count, "%s: expected %d got %d" % (name, count, a.size)
    return a


def validate(mode, out_root, quick=False):
    d = os.path.join(out_root, mode)
    man = json.load(open(os.path.join(d, "manifest.json")))
    N = man["neurons"]; E = man["edges"]
    errs = []

    def chk(cond, msg):
        if not cond:
            errs.append(msg)

    indptr = rd(d, "graph.indptr.u32.bin", "<u4", N + 1)
    indices = rd(d, "graph.indices.i32.bin", "<i4", E)
    weights = rd(d, "graph.weights.f32.bin", "<f4", E)
    indptr_r = rd(d, "graph_r.indptr.u32.bin", "<u4", N + 1)
    indices_r = rd(d, "graph_r.indices.i32.bin", "<i4", E)
    bodyid = rd(d, "neurons.bodyid.i64.bin", "<i8", N)
    nt = rd(d, "neurons.nt.u8.bin", "<u1", N)
    region = rd(d, "neurons.region.u16.bin", "<u2", N)
    pos = rd(d, "neurons.pos.f32.bin", "<f4", N * 3)
    deg = rd(d, "neurons.deg.i32.bin", "<i4", N * 2)

    chk(indptr[0] == 0, "indptr[0] != 0")
    chk(int(indptr[-1]) == E, "indptr[-1]=%d != E=%d" % (indptr[-1], E))
    chk(bool(np.all(np.diff(indptr.astype(np.int64)) >= 0)), "indptr not monotonic")
    chk(int(indptr_r[-1]) == E, "reverse indptr[-1] != E")
    chk(bool(indices.min() >= 0 and indices.max() < N), "indices out of range")
    chk(bool(indices_r.min() >= 0 and indices_r.max() < N), "reverse indices out of range")
    chk(bool(np.all(weights > 0)), "non-positive weight present")
    chk(len(np.unique(bodyid)) == N, "body ids not unique")
    chk(bool(np.all(bodyid > 0)), "non-positive body id")
    chk(bool(nt.max() <= man["nt_codes"]["UNKNOWN"]), "nt code out of range")
    chk(int(region.max()) < len(man["region_names"]), "region code out of range")

    in_deg = deg[0::2]; out_deg = deg[1::2]  # file layout: [in0,out0,in1,out1,...]
    chk(int(out_deg.sum()) == E, "sum(out_deg)=%d != E" % out_deg.sum())
    chk(int(in_deg.sum()) == E, "sum(in_deg)=%d != E" % in_deg.sum())
    csr_deg = np.diff(indptr.astype(np.int64))
    chk(bool(np.all(csr_deg == out_deg)), "CSR row lengths != out_deg")
    csc_deg = np.diff(indptr_r.astype(np.int64))
    chk(bool(np.all(csc_deg == in_deg)), "CSC row lengths != in_deg")

    # populations reference valid indices
    for pname, plist in man["populations"].items():
        chk(all(0 <= i < N for i in plist), "population %s has out-of-range index" % pname)
    inp = set(man["populations"]["INPUT_6"]) | set(man["populations"]["INPUT_7"])
    outp = (set(man["populations"]["READOUT_6"]) | set(man["populations"]["READOUT_7"])
            | set(man["populations"]["NO_ACTION"]))
    chk(len(inp & outp) == 0, "input and readout populations overlap")

    if not quick:
        # spot-check: pick a few neurons, verify CSR adjacency maps back to real edges
        rng = np.random.default_rng(0)
        for _ in range(200):
            i = int(rng.integers(0, N))
            lo, hi = int(indptr[i]), int(indptr[i + 1])
            tgts = indices[lo:hi]
            chk(bool(np.all((tgts >= 0) & (tgts < N))), "bad target for neuron %d" % i)
            # reverse graph must agree on in-degree of a target
            if tgts.size:
                j = int(tgts[0])
                rlo, rhi = int(indptr_r[j]), int(indptr_r[j + 1])
                chk(i in set(indices_r[rlo:rhi].tolist()),
                    "edge %d->%d not present in reverse graph" % (i, j))

    integ = man["integrity"]
    print("== %s ==" % mode)
    print("  neurons=%d edges=%d  (measured, from manifest)" % (N, E))
    print("  weight: min=%.0f max=%.0f mean=%.3f sum=%.0f" %
          (integ["weight_min"], integ["weight_max"], integ["weight_mean"], integ["weight_sum"]))
    print("  mean out-degree=%.1f  isolated=%d  self_loops=%d  dup_collapsed=%d" %
          (integ["mean_out_degree"], integ["isolated_neurons"], integ["self_loops"],
           integ["duplicate_pairs_summed"]))
    print("  NT coverage=%.3f  region coverage=%.3f  position coverage=%.3f" %
          (integ["nt_coverage"], integ["region_coverage"], integ["position_coverage"]))
    print("  body_id range: %d .. %d (fits int32: %s)" %
          (bodyid.min(), bodyid.max(), man["all_body_ids_fit_int32"]))
    if errs:
        print("  FAILED %d checks:" % len(errs))
        for e in errs[:40]:
            print("    -", e)
        return False
    print("  ALL CHECKS PASSED (%d edges, %d neurons)" % (E, N))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="core")
    ap.add_argument("--out", default=os.path.join(ROOT, "webapp", "public", "data"))
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    ok = validate(a.mode, a.out, a.quick)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
