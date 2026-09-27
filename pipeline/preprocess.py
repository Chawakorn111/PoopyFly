"""MaleCNS v1.0 -> compact spiking-kernel runtime files.

Pipeline
--------
    raw .feather  ->  validate (authoritative body set)
                  ->  filter corrupt edges (report exactly what & why)
                  ->  build neuron index (body_id <-> runtime index)
                  ->  build sparse CSR/CSC graph (indptr / indices / weights)
                  ->  attach neurotransmitter, region, 3D position (from tbar)
                  ->  select I/O populations (documented model assumption)
                  ->  export little-endian binary + manifest + integrity report

The ORIGINAL feather files are only ever memory-mapped for reading; they are
never modified. All derived counts are MEASURED and written to the integrity
report - nothing is hard-coded to the theoretical 166,700 / 25,582,938.

Usage
-----
    python pipeline/preprocess.py --modes debug,core,full
    python pipeline/preprocess.py --modes partial --partial-neurons 50000
    python pipeline/preprocess.py --modes full --force      # recompute caches
"""
import argparse
import gc
import json
import os
import sys
import time

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from malecns_common import (  # noqa: E402
    NT_NAMES, NT_UNKNOWN, NT_PROB_COLS, REGION_UNKNOWN, RAW, FORMAT_VERSION,
    base_region, le, write_bin,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", "_cache")
SMALL_ID_BOUND = 1_000_000  # ids < 1e6 are the coherent neuron regime (see report)


def log(msg):
    print("[%6.1fs] %s" % (time.time() - log.t0, msg), flush=True)


log.t0 = time.time()


def raw_path(key):
    return os.path.join(ROOT, RAW[key])


def open_file_reader(path):
    src = pa.memory_map(path, "r")
    return pa.ipc.open_file(src)


def member_mask(values, sorted_ref):
    """Boolean mask: which `values` are present in `sorted_ref` (binary search)."""
    idx = np.searchsorted(sorted_ref, values)
    np.clip(idx, 0, sorted_ref.size - 1, out=idx)
    return sorted_ref[idx] == values


# ===========================================================================
# Stage A - authoritative body set (every presynaptic neuron has T-bars)
# ===========================================================================
def build_authoritative_bodies(force=False):
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, "tbar_bodies.npy")
    stats_out = os.path.join(CACHE, "tbar_bodies_stats.json")
    if os.path.exists(out) and not force:
        bodies = np.load(out)
        log("Stage A: cached authoritative bodies = %d" % bodies.size)
        return bodies, json.load(open(stats_out))

    log("Stage A: scanning tbar-neurotransmitters for the authoritative body set ...")
    r = open_file_reader(raw_path("tbar_nt"))
    bodies = set()
    n = 0
    for i in range(r.num_record_batches):
        b = r.get_batch(i)
        n += b.num_rows
        bodies.update(pc.unique(b.column("body")).to_pylist())
    arr = np.array(sorted(bodies), dtype=np.int64)
    np.save(out, arr)
    small = arr[arr < SMALL_ID_BOUND]
    large = arr[arr >= SMALL_ID_BOUND]
    stats = {
        "tbar_rows": int(n),
        "unique_bodies": int(arr.size),
        "unique_small_lt_1e6": int(small.size),
        "unique_large_ge_1e6": int(large.size),
        "small_min": int(small.min()) if small.size else None,
        "small_max": int(small.max()) if small.size else None,
        "large_min": int(large.min()) if large.size else None,
        "large_max": int(large.max()) if large.size else None,
        "all_ids_fit_int32": bool(arr.max() < 2**31),
    }
    json.dump(stats, open(stats_out, "w"), indent=2)
    log("Stage A: %d bodies (%d small, %d large); tbar rows=%d"
        % (arr.size, small.size, large.size, n))
    return arr, stats


# ===========================================================================
# Stage B - stream connectome, keep only edges whose BOTH endpoints are real
#           bodies. Incrementally append to disk (memory-light).
# ===========================================================================
def build_valid_edges(bodies, force=False):
    os.makedirs(CACHE, exist_ok=True)
    fpre = os.path.join(CACHE, "valid_pre.i32.bin")
    fpost = os.path.join(CACHE, "valid_post.i32.bin")
    fw = os.path.join(CACHE, "valid_w.f32.bin")
    meta = os.path.join(CACHE, "valid_edges_meta.json")
    if os.path.exists(meta) and not force:
        m = json.load(open(meta))
        log("Stage B: cached valid edges = %d" % m["valid_edges"])
        return m

    log("Stage B: streaming connectome-weights, validating both endpoints ...")
    r = open_file_reader(raw_path("connectome_weights"))
    bodies32 = bodies  # int64 sorted
    hpre = open(fpre, "wb"); hpost = open(fpost, "wb"); hw = open(fw, "wb")
    total = 0
    valid = 0
    pre_valid = 0
    post_valid = 0
    w_sum_all = 0
    w_sum_valid = 0
    w_min = None; w_max = 0
    self_loops = 0
    for i in range(r.num_record_batches):
        b = r.get_batch(i)
        pre = b.column("body_pre").to_numpy(zero_copy_only=False)
        post = b.column("body_post").to_numpy(zero_copy_only=False)
        w = b.column("weight").to_numpy(zero_copy_only=False)
        total += pre.size
        w_sum_all += int(w.sum(dtype=np.int64))
        w_min = int(w.min()) if w_min is None else min(w_min, int(w.min()))
        w_max = max(w_max, int(w.max()))
        mp = member_mask(pre, bodies32)
        mq = member_mask(post, bodies32)
        pre_valid += int(mp.sum()); post_valid += int(mq.sum())
        both = mp & mq
        if both.any():
            pb = pre[both]; qb = post[both]; wb = w[both]
            le(pb, "<i4").tofile(hpre)
            le(qb, "<i4").tofile(hpost)
            le(wb, "<f4").tofile(hw)
            valid += int(both.sum())
            w_sum_valid += int(wb.sum(dtype=np.int64))
            self_loops += int((pb == qb).sum())
        if i % 400 == 0:
            log("  batch %d/%d total=%d valid=%d" % (i, r.num_record_batches, total, valid))
    hpre.close(); hpost.close(); hw.close()
    m = {
        "total_edges_raw": int(total),
        "valid_edges": int(valid),
        "filtered_edges": int(total - valid),
        "edges_pre_valid": int(pre_valid),
        "edges_post_valid": int(post_valid),
        "frac_post_invalid": round(1.0 - post_valid / total, 6) if total else 0,
        "weight_sum_raw": int(w_sum_all),
        "weight_sum_valid": int(w_sum_valid),
        "weight_min": int(w_min) if w_min is not None else None,
        "weight_max": int(w_max),
        "self_loops_valid": int(self_loops),
    }
    json.dump(m, open(meta, "w"), indent=2)
    log("Stage B: kept %d / %d edges (filtered %d; %.1f%% of post ids invalid)"
        % (valid, total, total - valid, 100 * m["frac_post_invalid"]))
    return m


def load_valid_edges():
    m = json.load(open(os.path.join(CACHE, "valid_edges_meta.json")))
    n = m["valid_edges"]
    pre = np.memmap(os.path.join(CACHE, "valid_pre.i32.bin"), dtype="<i4", mode="r", shape=(n,))
    post = np.memmap(os.path.join(CACHE, "valid_post.i32.bin"), dtype="<i4", mode="r", shape=(n,))
    w = np.memmap(os.path.join(CACHE, "valid_w.f32.bin"), dtype="<f4", mode="r", shape=(n,))
    return pre, post, w, m


# ===========================================================================
# Stage C - per-body attributes from tbar: neurotransmitter, region, position
# ===========================================================================
def build_body_attrs(bodies, force=False):
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, "body_attrs.npz")
    vocab_out = os.path.join(CACHE, "region_vocab.json")
    B = bodies.size
    if os.path.exists(out) and not force:
        log("Stage C: cached body attributes")
        z = np.load(out)
        return z, json.load(open(vocab_out))

    r = open_file_reader(raw_path("tbar_nt"))
    # --- vocab pass: collect region names ---
    log("Stage C: collecting region vocabulary from tbar `primary` ...")
    names = set()
    for i in range(r.num_record_batches):
        b = r.get_batch(i)
        if "primary" in b.schema.names:
            for v in pc.unique(b.column("primary")).to_pylist():
                br = base_region(v)
                if br:
                    names.add(br)
    region_names = sorted(names)
    region_to_code = {nm: k + 1 for k, nm in enumerate(region_names)}  # 0 = UNKNOWN
    R = len(region_names) + 1
    json.dump({"regions": region_names, "code_of": region_to_code}, open(vocab_out, "w"), indent=2)
    log("Stage C: %d distinct regions" % len(region_names))

    # --- aggregation pass ---
    log("Stage C: aggregating NT / region / position per body ...")
    nt_sum = np.zeros((B, len(NT_PROB_COLS)), dtype=np.float64)
    cnt = np.zeros(B, dtype=np.float64)
    xyz = np.zeros((B, 3), dtype=np.float64)
    rvotes = np.zeros((B, R), dtype=np.int32)
    has_primary = None
    for i in range(r.num_record_batches):
        b = r.get_batch(i)
        body = b.column("body").to_numpy(zero_copy_only=False)
        pos = np.searchsorted(bodies, body)
        np.clip(pos, 0, B - 1, out=pos)
        ok = bodies[pos] == body
        if not ok.any():
            continue
        p = pos[ok]
        cnt += np.bincount(p, minlength=B)
        for k, col in enumerate(NT_PROB_COLS):
            if col in b.schema.names:
                v = b.column(col).to_numpy(zero_copy_only=False)[ok]
                nt_sum[:, k] += np.bincount(p, weights=v.astype(np.float64), minlength=B)
        for ax, col in enumerate(("x", "y", "z")):
            if col in b.schema.names:
                v = b.column(col).to_numpy(zero_copy_only=False)[ok].astype(np.float64)
                xyz[:, ax] += np.bincount(p, weights=v, minlength=B)
        if "primary" in b.schema.names:
            darr = b.column("primary")
            di = darr.dictionary.to_pylist()
            co = darr.indices.to_numpy(zero_copy_only=False)
            # map this batch's dictionary slots -> region codes (vectorised)
            lut = np.array([region_to_code.get(base_region(s), REGION_UNKNOWN)
                            for s in di], dtype=np.int32)
            codes = lut[co]
            cok = codes[ok]
            for c in np.unique(cok):
                if c == REGION_UNKNOWN:
                    continue
                sel = p[cok == c]
                rvotes[:, c] += np.bincount(sel, minlength=B).astype(np.int32)
        if i % 100 == 0:
            log("  tbar batch %d/%d" % (i, r.num_record_batches))

    safe = np.maximum(cnt, 1.0)
    nt_mean = nt_sum / safe[:, None]
    nt_code = np.argmax(nt_mean, axis=1).astype(np.uint8)
    nt_prob = nt_mean.max(axis=1).astype(np.float32)
    nt_code[cnt == 0] = NT_UNKNOWN
    nt_prob[cnt == 0] = 0.0
    region_code = np.argmax(rvotes, axis=1).astype(np.uint16)
    region_code[rvotes.sum(axis=1) == 0] = REGION_UNKNOWN
    posx = (xyz[:, 0] / safe).astype(np.float32)
    posy = (xyz[:, 1] / safe).astype(np.float32)
    posz = (xyz[:, 2] / safe).astype(np.float32)

    np.savez(out, nt_code=nt_code, nt_prob=nt_prob, region_code=region_code,
             x=posx, y=posy, z=posz, tbars=cnt.astype(np.int32))
    del nt_sum, rvotes, xyz, nt_mean
    gc.collect()
    log("Stage C: done. NT coverage=%.3f region coverage=%.3f"
        % (float((nt_code != NT_UNKNOWN).mean()), float((region_code != REGION_UNKNOWN).mean())))
    return np.load(out), json.load(open(vocab_out))


# ===========================================================================
# Graph assembly helpers
# ===========================================================================
def build_csr(pre_idx, post_idx, w, N):
    """Canonical CSR: edges sorted by (pre, post). Returns indptr/indices/weights/order.

    `order[c]` is the input-edge id placed at output slot c (used to derive the
    reverse->forward edge-index map needed for per-synapse STDP).
    """
    order = np.lexsort((post_idx, pre_idx))
    indices = np.ascontiguousarray(post_idx[order], dtype="<i4")
    weights = np.ascontiguousarray(w[order], dtype="<f4")
    deg = np.bincount(pre_idx, minlength=N)
    indptr = np.zeros(N + 1, dtype=np.uint64)
    np.cumsum(deg, out=indptr[1:])
    indptr = indptr.astype("<u4")
    return indptr, indices, weights, order


def merge_duplicates(pre_idx, post_idx, w, N):
    """Sum weights of duplicate (pre,post) pairs -> simple directed graph.

    Memory-lean: keeps weights as float32, frees the sort order immediately, and
    takes a no-copy fast path when there are no duplicates (the common case for
    MaleCNS, which is already aggregated per pair). Returns the true number of
    collapsed duplicate pairs.
    """
    if pre_idx.size == 0:
        return pre_idx, post_idx, np.asarray(w, dtype="<f4"), 0
    order = np.lexsort((post_idx, pre_idx))
    ps = pre_idx[order]
    qs = post_idx[order]
    ws = np.ascontiguousarray(w[order], dtype=np.float32)
    del order
    new = np.empty(ps.size, dtype=bool)
    new[0] = True
    changed = ps[1:] != ps[:-1]
    np.logical_or(changed, qs[1:] != qs[:-1], out=changed)
    new[1:] = changed
    n_groups = int(new.sum())
    true_dups = int(ps.size - n_groups)
    if true_dups:
        key = (np.cumsum(new) - 1).astype(np.int32)
        uw = np.bincount(key, weights=ws.astype(np.float64)).astype("<f4")
        upre = np.ascontiguousarray(ps[new], dtype="<i4")
        upost = np.ascontiguousarray(qs[new], dtype="<i4")
    else:
        upre = np.ascontiguousarray(ps, dtype="<i4")
        upost = np.ascontiguousarray(qs, dtype="<i4")
        uw = ws
    return upre, upost, uw, true_dups


def select_populations(in_deg, out_deg, n_in=128, n_out=128, n_no=128):
    """Deterministic I/O population selection (documented model assumption).

    MaleCNS has no native 'digit 6 / digit 7' neurons, so we designate real
    neurons as input/readout proxies: high in-degree hubs are stimulated
    (input), high out-degree hubs are read (output). Ties break by index, so
    the selection is fully reproducible and never random.
    """
    N = in_deg.size
    order_in = np.lexsort((np.arange(N), -in_deg))
    order_out = np.lexsort((np.arange(N), -out_deg))
    in_pool = order_in[: 2 * n_in]
    input_6 = sorted(in_pool[:n_in].tolist())
    input_7 = sorted(in_pool[n_in:2 * n_in].tolist())
    used = set(in_pool.tolist())
    out_pool = [int(x) for x in order_out if int(x) not in used][: 3 * n_out]
    readout_6 = sorted(out_pool[:n_out])
    readout_7 = sorted(out_pool[n_out:2 * n_out])
    no_action = sorted(out_pool[2 * n_out:3 * n_out])
    return {
        "INPUT_6": input_6, "INPUT_7": input_7,
        "READOUT_6": readout_6, "READOUT_7": readout_7,
        "NO_ACTION": no_action,
    }


# ===========================================================================
# Stage D - assemble + export one mode
# ===========================================================================
def export_mode(mode, neuron_bodies, pre_body, post_body, w, bodies, attrs,
                region_vocab, out_root, extra_integrity):
    t = time.time()
    Nn = neuron_bodies.size
    log("[%s] assembling graph: %d neurons" % (mode, Nn))
    # keep only edges whose BOTH endpoints are in this mode's neuron set, then map
    # body_id -> dense runtime index directly (searchsorted on the sorted subset).
    keep = member_mask(pre_body, neuron_bodies) & member_mask(post_body, neuron_bodies)
    pre_idx = np.searchsorted(neuron_bodies, pre_body[keep]).astype("<i4")
    post_idx = np.searchsorted(neuron_bodies, post_body[keep]).astype("<i4")
    wsel = np.ascontiguousarray(w[keep], dtype=np.float32)
    edges_before = int(pre_idx.size)

    pre_idx, post_idx, wsel, dups = merge_duplicates(pre_idx, post_idx, wsel, Nn)
    E = int(pre_idx.size)

    in_deg = np.bincount(post_idx, minlength=Nn).astype(np.int32)
    out_deg = np.bincount(pre_idx, minlength=Nn).astype(np.int32)
    csr_indptr, csr_indices, csr_w, csr_order = build_csr(pre_idx, post_idx, wsel, Nn)
    csc_indptr, csc_indices, csc_w, csc_order = build_csr(post_idx, pre_idx, wsel, Nn)
    # reverse(CSC) slot -> forward(CSR) slot map, needed for per-synapse STDP on
    # the post side. If CSR order is the identity (it is, since merge_duplicates
    # pre-sorts by (pre,post)) then rev2fwd == csc_order directly; otherwise
    # invert the CSR order. Verified, never assumed silently.
    if E == 0:
        rev2fwd = np.zeros(0, dtype="<i4")
    elif bool(csr_order[0] == 0) and bool(np.all(np.diff(csr_order) == 1)):
        rev2fwd = csc_order.astype("<i4")
    else:
        inv = np.empty(E, dtype=np.int64)
        inv[csr_order] = np.arange(E)
        rev2fwd = inv[csc_order].astype("<i4")
        del inv
    del csr_order, csc_order

    # per-neuron attributes (slice the per-body table)
    bpos = np.searchsorted(bodies, neuron_bodies)
    np.clip(bpos, 0, bodies.size - 1, out=bpos)
    nt_code = attrs["nt_code"][bpos]
    nt_prob = attrs["nt_prob"][bpos]
    region_code = attrs["region_code"][bpos]
    x = attrs["x"][bpos]; y = attrs["y"][bpos]; z = attrs["z"][bpos]

    pops = select_populations(in_deg, out_deg)

    # ---- write files ----
    d = os.path.join(out_root, mode)
    os.makedirs(d, exist_ok=True)

    def W(name, arr, dtype):
        n, isz = write_bin(os.path.join(d, name), arr, dtype)
        return n * isz

    sizes = {}
    sizes["graph.indptr.u32.bin"] = W("graph.indptr.u32.bin", csr_indptr, "<u4")
    sizes["graph.indices.i32.bin"] = W("graph.indices.i32.bin", csr_indices, "<i4")
    sizes["graph.weights.f32.bin"] = W("graph.weights.f32.bin", csr_w, "<f4")
    sizes["graph_r.indptr.u32.bin"] = W("graph_r.indptr.u32.bin", csc_indptr, "<u4")
    sizes["graph_r.indices.i32.bin"] = W("graph_r.indices.i32.bin", csc_indices, "<i4")
    sizes["graph_r.weights.f32.bin"] = W("graph_r.weights.f32.bin", csc_w, "<f4")
    sizes["graph_r.rev2fwd.i32.bin"] = W("graph_r.rev2fwd.i32.bin", rev2fwd, "<i4")
    sizes["neurons.bodyid.i64.bin"] = W("neurons.bodyid.i64.bin", neuron_bodies, "<i8")
    sizes["neurons.nt.u8.bin"] = W("neurons.nt.u8.bin", nt_code, "<u1")
    sizes["neurons.ntprob.f32.bin"] = W("neurons.ntprob.f32.bin", nt_prob, "<f4")
    sizes["neurons.region.u16.bin"] = W("neurons.region.u16.bin", region_code, "<u2")
    sizes["neurons.pos.f32.bin"] = W("neurons.pos.f32.bin",
                                     np.stack([x, y, z], axis=1).ravel(), "<f4")
    sizes["neurons.deg.i32.bin"] = W("neurons.deg.i32.bin",
                                     np.stack([in_deg, out_deg], axis=1).ravel(), "<i4")

    region_counts = np.bincount(region_code, minlength=len(region_vocab["regions"]) + 1)
    nt_counts = np.bincount(nt_code, minlength=NT_UNKNOWN + 1)
    integrity = {
        "mode": mode,
        "neurons": int(Nn),
        "edges": int(E),
        "edges_before_dedup": int(edges_before),
        "duplicate_pairs_summed": int(dups),
        "self_loops": int((pre_idx == post_idx).sum()),
        "weight_min": float(wsel.min()) if E else 0.0,
        "weight_max": float(wsel.max()) if E else 0.0,
        "weight_mean": float(wsel.mean()) if E else 0.0,
        "weight_sum": float(wsel.sum()) if E else 0.0,
        "mean_out_degree": float(out_deg.mean()) if Nn else 0.0,
        "mean_in_degree": float(in_deg.mean()) if Nn else 0.0,
        "isolated_neurons": int(((in_deg == 0) & (out_deg == 0)).sum()),
        "nt_coverage": float((nt_code != NT_UNKNOWN).mean()) if Nn else 0.0,
        "nt_counts": {NT_NAMES[i] if i < NT_UNKNOWN else "UNKNOWN": int(nt_counts[i])
                      for i in range(len(nt_counts))},
        "region_coverage": float((region_code != REGION_UNKNOWN).mean()) if Nn else 0.0,
        "region_counts": {("UNKNOWN" if k == 0 else region_vocab["regions"][k - 1]): int(v)
                          for k, v in enumerate(region_counts) if v},
        "position_coverage": float(((x != 0) | (y != 0) | (z != 0)).mean()) if Nn else 0.0,
        "bytes_total": int(sum(sizes.values())),
        "build_seconds": round(time.time() - t, 2),
    }
    integrity.update(extra_integrity)

    manifest = {
        "format_version": FORMAT_VERSION,
        "mode": mode,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "dataset": "MaleCNS v1.0 (provided .feather files)",
        "counts_are_measured": True,
        "neurons": int(Nn),
        "edges": int(E),
        "id_dtype": "int64",
        "all_body_ids_fit_int32": bool(neuron_bodies.max() < 2**31) if Nn else True,
        "endianness": "little",
        "files": sizes,
        "nt_codes": {**{n: i for i, n in enumerate(NT_NAMES)}, "UNKNOWN": NT_UNKNOWN},
        "nt_names": NT_NAMES + ["UNKNOWN"],
        "region_codes": {"UNKNOWN": 0, **region_vocab["code_of"]},
        "region_names": ["UNKNOWN"] + region_vocab["regions"],
        "populations": pops,
        "population_policy": (
            "input = high in-degree hubs split 6/7; readout = high out-degree hubs "
            "(disjoint from input) split READOUT_6/READOUT_7/NO_ACTION; ties by index; "
            "deterministic, NOT random. MaleCNS has no native digit neurons - this is a "
            "documented input-encoding / readout model assumption."),
        "integrity": integrity,
    }
    json.dump(manifest, open(os.path.join(d, "manifest.json"), "w"), indent=2)
    log("[%s] exported %d neurons / %d edges (%.1f MB) in %.1fs"
        % (mode, Nn, E, sum(sizes.values()) / 1e6, time.time() - t))
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modes", default="debug,core",
                    help="comma list: full,core,debug,partial")
    ap.add_argument("--debug-neurons", type=int, default=3000)
    ap.add_argument("--partial-neurons", type=int, default=50000)
    ap.add_argument("--partial-source", default="core", help="core|full")
    ap.add_argument("--out", default=os.path.join(ROOT, "webapp", "public", "data"))
    ap.add_argument("--force", action="store_true", help="recompute caches")
    args = ap.parse_args()
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]

    bodies, bstats = build_authoritative_bodies(args.force)
    emeta = build_valid_edges(bodies, args.force)
    attrs, rvocab = build_body_attrs(bodies, args.force)
    pre_body, post_body, w, _ = load_valid_edges()

    global_integrity = {
        "authoritative_bodies": bstats,
        "connectome_validation": emeta,
        "missing_source_files": [k for k in ("body_annotations", "body_nt")
                                 if not os.path.exists(raw_path(k))],
        "note": ("Provided connectome-weights is anomalous vs the published MaleCNS v1.0 "
                 "(~166,700 neurons / ~25.6M edges). Measured: 151.9M raw edges, 78.4% "
                 "with body_post ids absent from every other file. Edges are kept only "
                 "when BOTH endpoints are authoritative bodies. Counts here are measured, "
                 "never the theoretical values."),
    }

    # ---- CORE neuron set: small-id coherent regime ----
    core_mask_edge = (pre_body < SMALL_ID_BOUND) & (post_body < SMALL_ID_BOUND)
    core_bodies = np.union1d(np.unique(pre_body[core_mask_edge]),
                             np.unique(post_body[core_mask_edge]))
    core_bodies = core_bodies[member_mask(core_bodies, bodies)]
    # ---- FULL neuron set: every validated body that appears in a valid edge ----
    full_bodies = np.union1d(np.unique(pre_body), np.unique(post_body))
    full_bodies = full_bodies[member_mask(full_bodies, bodies)]

    sets = {"core": core_bodies, "full": full_bodies}
    log("Neuron sets: core=%d full=%d" % (core_bodies.size, full_bodies.size))

    plan = []  # list of (dirname, neuron_bodies, extra_integrity)

    def add_subset(dirname, source, n, label):
        src = sets[source]
        nn = min(n, src.size)
        nb = top_degree_subset(src, pre_body, post_body, bodies, nn)
        plan.append((dirname, nb, {"neuron_policy":
                     "%s: top-%d by total degree from %s (real MaleCNS topology, deterministic, not random)"
                     % (label, nn, source.upper())}))

    for mode in modes:
        if mode == "debug":
            add_subset("debug", "core", args.debug_neurons, "DEBUG")
        elif mode == "partial":
            add_subset("partial_%d" % args.partial_neurons, args.partial_source,
                       args.partial_neurons, "PARTIAL")
        elif mode == "bench":
            # spec benchmark ladder: 3k, 10k, 50k, 100k, FULL (+ CORE neuron graph)
            add_subset("debug", "core", 3000, "DEBUG")
            for n in (10000, 50000, 100000):
                add_subset("partial_%d" % n, "core", n, "PARTIAL")
            plan.append(("core", sets["core"], {"neuron_policy":
                         "CORE / FULL(neurons): all validated bodies in the small-id (<1e6) "
                         "coherent neuron regime - the genuine MaleCNS neuron connectome"}))
            plan.append(("full", sets["full"], {"neuron_policy":
                         "FULL(all bodies): every validated body appearing in a both-endpoints-valid "
                         "edge, including large-id fragment bodies"}))
        elif mode in ("core", "full"):
            plan.append((mode, sets[mode], {"neuron_policy": (
                "CORE / FULL(neurons): all validated bodies in the small-id (<1e6) coherent neuron regime"
                if mode == "core" else
                "FULL(all bodies): every validated body appearing in a both-endpoints-valid edge")}))
        else:
            log("unknown mode %s" % mode)

    built = {}
    summary_path = os.path.join(args.out, "build_summary.json")
    os.makedirs(args.out, exist_ok=True)
    for dirname, nb, extra in plan:
        if dirname in built:
            continue
        try:
            built[dirname] = export_mode(dirname, nb, pre_body, post_body, w, bodies,
                                         attrs, rvocab, args.out, {**global_integrity, **extra})
        except MemoryError as e:
            log("!! %s FAILED (MemoryError): %s" % (dirname, e))
            built[dirname] = {"integrity": {"mode": dirname, "error": "MemoryError: %s" % e}}
        json.dump({m: built[m]["integrity"] for m in built}, open(summary_path, "w"), indent=2)
        gc.collect()

    log("WROTE build_summary.json for modes: %s" % list(built))


def top_degree_subset(neuron_bodies, pre_body, post_body, bodies, n):
    """Pick the top-n neurons by total degree within the induced subgraph.

    Deterministic hub selection that preserves REAL MaleCNS topology (used for
    DEBUG/PARTIAL). Never random.
    """
    in_set = member_mask(pre_body, neuron_bodies) & member_mask(post_body, neuron_bodies)
    p = pre_body[in_set]; q = post_body[in_set]
    # local index within neuron_bodies
    pl = np.searchsorted(neuron_bodies, p); ql = np.searchsorted(neuron_bodies, q)
    N = neuron_bodies.size
    deg = np.bincount(pl, minlength=N) + np.bincount(ql, minlength=N)
    order = np.lexsort((np.arange(N), -deg))
    keep_local = np.sort(order[:n])
    return neuron_bodies[keep_local]


if __name__ == "__main__":
    main()
