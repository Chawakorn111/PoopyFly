# Architecture

## Data flow

```
raw MaleCNS .feather (read-only, never modified)
        |
        v   pipeline/preprocess.py  (NumPy/pandas/PyArrow, memory-mapped)
 Stage A  authoritative body set  -> data/_cache/tbar_bodies.npy
 Stage B  connectome validated (both endpoints real) -> data/_cache/valid_{pre,post,w}
 Stage C  per-body NT / region / 3D position (from tbar) -> data/_cache/body_attrs.npz
 Stage D  per-mode CSR + CSC (+ rev2fwd) + per-neuron arrays + manifest + integrity
        |
        v   webapp/public/data/<mode>/
   graph.indptr.u32.bin  graph.indices.i32.bin  graph.weights.f32.bin
   graph_r.indptr/indices/rev2fwd
   neurons.bodyid.i64.bin  neurons.nt.u8.bin  neurons.region.u16.bin
   neurons.pos.f32.bin     neurons.deg.i32.bin
   manifest.json           integrity (embedded)
        |
        v   browser
 main thread (React + Three.js)          web worker (src/sim/worker.ts)
   fetch manifest + positions    init -->   fetch CSR/CSC/nt/region/bodyid/deg
   render base point cloud                 Kernel (src/sim/kernel.ts)
   receive compact 'frame' <----------------  event-driven LIF + delays + NT + STDP
   (transferable spike Int32Array)           readout, region aggregation, ablation
   receive 'neuron'/'connections' <---------  inspection on demand
```

The worker owns **all** neuron state and the graph. It never sends the
1.7M-neuron state to React; each frame it transfers one `Int32Array` of spiking
neuron indices (capped for bandwidth; true counts always reported) plus small
stats / readout / region objects. React state is updated at ~10 Hz, never per
frame. The renderer is a passive view — the simulation keeps running if the 3D
view is removed.

## Sparse representation (dense matrix forbidden)

Connectivity is CSR: `indptr[N+1]`, `indices[E]`, `baseW[E]` (little-endian typed
arrays, contiguous). A CSC (`graph_r.*`) plus `rev2fwd` (reverse-slot ->
forward-slot) is exported so the debugger can trace incoming edges and per-synapse
STDP can update the correct forward weight. No `N x N` array is ever allocated;
no JS object per neuron/edge.

## The spiking kernel (src/sim/kernel.ts)

Per-neuron contiguous state arrays: `V`, `Isyn`, `refracUntil`, `lastSpike`,
`spikeCount`, `disabled`, `inActive`, `popId`, `inputId`.

Each `step()` (one `dt`-tick):
1. **Input drive** — queued/Poisson input spikes (`forceSpike`) enter the network
   as real spikes.
2. **Delay delivery** — read the ring slot for spikes emitted `delayTicks` ago;
   for each spiking source, walk its CSR out-adjacency and add
   `(baseW+delta) * weightScale * ntEffect[sourceNT]` to each target's `Isyn`,
   marking targets active.
3. **Integration** — only the **active set** (depolarised / refractory / received
   input) is leaky-integrated (`v += dt/tau * (-(v-vRest) + Isyn)`), optional
   seeded noise, thresholded; crossing -> `fire()` (reset, refractory, spike
   record, region + readout accounting, STDP). Neurons that decay back to rest
   leave the active set, so cost scales with activity, not with N.
4. **Store** this tick's spikes into the delay ring for future delivery.
5. **Readout EMA** update.

Delay ring length = `delayTicks + 1`; delivery slot `t % D`, store slot
`(t+delay) % D`. `delay` is configurable (quantised to `dt`).

**Event-driven** means only neurons that spiked expand their outgoing edges, and
only active neurons are integrated — idle parts of the 1.7M array are untouched.
The benchmark tab measures whether this actually pays off and reports the real
time factor; it is never faked.

**Neurotransmitter model**: each neuron carries a predicted NT (`ACh/GABA/Glu/
DA/5HT/OA/HA/UNKNOWN`); the per-transmitter signed effect is a configurable
`ntEffect` table applied at delivery. Positive=excitatory, negative=inhibitory,
small=modulatory.

**Plasticity (optional STDP)**: nearest-neighbour symmetric window rule updating a
per-edge `delta` (allocated lazily). `effective = (baseW + delta) * scale * nt`;
`baseW` is immutable and never written back. Deterministic mode disables
plasticity + noise.

**Ablation**: `disabled[i]` blocks integration, propagation and drive — per neuron
or per neuropil region; the readout / neuropil panels compare baseline vs ablated.

**I/O populations**: `INPUT_6/7`, `READOUT_6/7`, `NO_ACTION` are real neurons chosen
deterministically by degree (documented model assumption — MaleCNS has no native
digit neurons). The decision is `argmax` of exponentially-weighted readout
population firing rates, i.e. produced by network activity, not by a shortcut.

## Modes

`debug` (3k), `partial_*` (10k/50k/100k), `core` (genuine neuron graph),
`full` (all validated bodies). All are the same real connectome at different
neuron-count subsets selected by real degree/hub rules — never random, never
silently pruned; the active mode and measured counts are always displayed.

## PoopFly layer (physiology → behaviour → learning)

The neural core is unchanged and remains the only thing that chooses behaviour.
On top of it, inside the same worker:

```
World (env.ts)          physiology + 1D world; passive gut fill; defecation
   |  gut_pressure, energy, comfort ...
Agent (agent.ts)        closed loop, every tick:
   1. encode()          interoceptive + music channels -> real spike drive
                        (rate = base + (max-base)*pressure^exp)  [encode.ts rules]
   2. kernel.step()     LIF propagates through the SAME MaleCNS CSR graph;
                        3-factor eligibility accumulates on active synapses
   3. decode()          WTA over motor-population firing rates (+explore) -> action
   4. World.step()      applies action; relief lowers pressure -> homeostatic error
   5. reward/dopamine   improvement = prev_error - error -> dopamine (clipped)
   6. kernel.setDopamine() + stepPlasticity() -> delta on eligible synapses
   -> next tick's decisions reflect the learned weights
populations.ts          deterministic I/O pools (out-degree=drive, in-degree=motor)
```

- Interoception is a **spike train into real neurons**, not a "POOP" flag.
- The action is the **argmax of motor-population rates** read from the sim; the
  environment FSM only *gates* physically-impossible actions (e.g. defecating
  away from the toilet), it never *picks* them.
- Plasticity is **three-factor** (presynaptic + postsynaptic eligibility ×
  dopaminergic signal), additive on a learned `delta` per edge; the original
  MaleCNS weight is immutable. Default OFF; `deterministic` forces OFF.
- Music preference emerges from the dopamine each song's hidden environmental
  valence contributes to relief — never hardcoded.
- The agent emits a `Snapshot` (vitals, motor rates, chosen action, reward,
  dopamine, song picks, plasticity stats, metrics) at ~10 Hz and `runExperiment()`
  runs headless trials for the A–I experiments.

