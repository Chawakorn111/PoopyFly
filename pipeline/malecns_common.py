"""Shared constants and helpers for the MaleCNS preprocessing pipeline.

Biological interpretation
-------------------------
This pipeline turns the raw MaleCNS v1.0 `.feather` releases into compact,
kernel-ready runtime files. The dataset values (neuron identities, connections,
weights, neurotransmitter predictions, anatomy) are REAL and immutable. Anything
derived (neuron-index assignment, population selection for I/O, region voting)
is a documented computational choice, recorded in the integrity report.

All multi-byte binary output is little-endian so it maps 1:1 onto JS TypedArrays
(Int32Array / Uint32Array / Float32Array / BigInt64Array) in the browser worker.
"""
import os

# ---------------------------------------------------------------------------
# Neurotransmitter model. Codes are stored per neuron (the PRESYNAPTIC neuron's
# transmitter). The excitatory/inhibitory/modulatory EFFECT of each code is a
# configurable model assumption that lives in the webapp config, NOT in the data.
# ---------------------------------------------------------------------------
NT_NAMES = ["ACh", "GABA", "Glu", "DA", "5HT", "OA", "HA"]
NT_UNKNOWN = len(NT_NAMES)  # 7
# tbar-neurotransmitters probability columns, in NT_NAMES order:
NT_PROB_COLS = [
    "nt_acetylcholine_prob",
    "nt_gaba_prob",
    "nt_glutamate_prob",
    "nt_dopamine_prob",
    "nt_serotonin_prob",
    "nt_octopamine_prob",
    "nt_histamine_prob",
]
NT_CODES = {name: i for i, name in enumerate(NT_NAMES)}

REGION_UNKNOWN = 0  # reserved code 0 == unspecified / no annotation


def base_region(primary_value):
    """Normalise a syn-points/tbar `primary` label to a base neuropil name.

    'AL(L)' -> 'AL', 'CRE(R)' -> 'CRE', 'CentralBrain-unspecified' -> kept,
    '<unspecified>' / None -> '' (unknown).
    """
    if primary_value is None:
        return ""
    s = str(primary_value)
    if s in ("<unspecified>", "", "nan", "None"):
        return ""
    if s.endswith("(L)") or s.endswith("(R)"):
        s = s[:-3]
    return s


# ---------------------------------------------------------------------------
# Raw dataset filenames (the ORIGINAL files are never modified).
# ---------------------------------------------------------------------------
RAW = {
    "connectome_weights": "connectome-weights-male-cns-v1.0-minconf-0.5.feather",
    "tbar_nt": "tbar-neurotransmitters-male-cns-v1.0.feather",
    "syn_partners": "syn-partners-male-cns-v1.0-minconf-0.5.feather",
    "syn_points": "syn-points-male-cns-v1.0-minconf-0.5.feather",
    # Referenced by the spec but NOT present in this dataset:
    "body_annotations": "body-annotations-male-cns-v1.0-minconf-0.5.feather",
    "body_nt": "body-neurotransmitters-male-cns-v1.0.feather",
}

FORMAT_VERSION = 1


def le(arr, dtype):
    """Return a contiguous little-endian copy of `arr` cast to `dtype`."""
    import numpy as np
    a = np.ascontiguousarray(arr, dtype=dtype)
    return a.astype(a.dtype.newbyteorder("<"), copy=False)


def write_bin(path, arr, dtype):
    """Write a little-endian raw binary blob (no header) for direct TypedArray use."""
    a = le(arr, dtype)
    a.tofile(path)
    return a.size, a.dtype.itemsize
