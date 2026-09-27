# Biological interpretation & model assumptions

This project is a **computational whole-CNS spiking simulation driven by the
real MaleCNS v1.0 connectome**. It is *not* an exact molecular / biophysical
reconstruction of a living adult male *Drosophila* CNS. Below is a strict split
between what is real data and what is a modelling choice. Everything assumed is
configurable at runtime and defaults are documented.

## 1. REAL (taken from the provided MaleCNS files, never overwritten)

- **Neuron identities** — MaleCNS body IDs, mapped 1:1 to runtime indices and
  back (`indexToBodyId` = `neurons.bodyid.i64.bin`; the UI/debugger show both).
- **Connectivity** — directed neuron->neuron edges from `connectome-weights`
  (`body_pre -> body_post`).
- **Connection strength** — the MaleCNS `weight` (synapse count per pair) is kept
  immutable as `baseW`.
- **Neurotransmitter prediction** — per neuron, from `tbar-neurotransmitters`
  (`ACh/GABA/Glu/DA/5HT/OA/HA`, prob-averaged over each neuron's T-bars, argmax).
- **Anatomy / neuropil** — per-neuron region labels derived from `tbar` `primary`
  (80 regions, ~99% coverage), and per-synapse compartment/kind from `syn-points`.
- **Synaptic positions / partners / confidence** — from `syn-points` and
  `syn-partners` (loaded selectively, never in bulk to the browser).

### Data caveats (measured, reported in-app)
- The provided `connectome-weights` is **anomalous vs the published MaleCNS v1.0**:
  151.9M raw edges, 78.4% with `body_post` ids present in **no** other file. We
  keep only edges whose both endpoints are authoritative (T-bar) bodies.
- `body-annotations` and `body-neurotransmitters` are **missing**; neurotransmitters
  are derived from `tbar-neurotransmitters`, regions from `tbar` `primary`.
- The id space splits into a small-id neuron regime (244,657; `core` graph) and a
  large-id regime (1.59M bodies, likely fragments). `core` (241,304 neurons /
  26.3M edges) reproduces the published MaleCNS edge count and is the recommended
  whole-neuron-brain view; `full` (1.75M/32.75M) is the maximal validated graph.

## 2. ASSUMED / MODELLED (computational, configurable)

| Thing | Assumption | Where |
|---|---|---|
| Neuron model | Leaky Integrate-and-Fire point neuron. **Does not** reproduce real ion-channel/biophysical dynamics. | `kernel.ts`, `DEFAULT_CONFIG.lif` |
| LIF params | `vRest -60, vThresh -46, vReset -60, tauM 8 ms, tauSyn 8 ms, tRef 2.5 ms, dt 0.1 ms` mV — biologically motivated defaults for fly CNS LIF, fully editable. | config |
| Synapse->conductance | `effective = (baseW + delta) * weightScale * ntEffect[sourceNT]`. `weightScale` (default 0.05) turns a synapse count into mV of drive, and is calibrated per dataset so a neuron's total drive is comparable across graph subsets. | config |
| Synaptic kinetics | Synaptic current **leaks with `tauSyn`** rather than resetting each tick, so convergent input summated across the synaptic window brings a neuron to threshold. No AMPA/NMDA/GABA-A receptor kinetics. | kernel |
| Transmission delay | Single global configurable `delayMs` (default 1 ms), quantised to `dt`, via a ring buffer. **Not** per-synapse axonal conduction delays. | config / ring |
| NT -> effect map | `ACh +1, Glu +1` excitatory; `GABA -1, HA -1` inhibitory; `DA +0.3, 5HT +0.2, OA +0.2` modulatory-as-weak-bias; `UNKNOWN +0.5`. **This is a coarse mapping, NOT a receptor-level model.** | `DEFAULT_CONFIG.ntEffect` |
| Input encoding | 6 -> `INPUT_6`, 7 -> `INPUT_7` (real high-in-degree hub neurons, split deterministically) driven as a Poisson spike source (rate/duration/latency/jitter configurable). MaleCNS has no native "digit" neurons; population choice is a modelling choice. | `pipeline select_populations`, `kernel.inject` |
| Output readout | Decision = `argmax` of exponentially-weighted firing rates of `READOUT_6` vs `READOUT_7`, with a `NO_ACTION` rate threshold. Computed purely from network activity over a window — no input/output shortcut. | `kernel.getReadout` |
| Plasticity | Optional three-factor rule (eligibility × dopamine) on a per-edge learned `delta` (never written to `baseW`); an STDP mode is also available. OFF by default; deterministic mode forces it off. | `kernel.stepPlasticity` |
| Region aggregation | Neuropil = per-neuron region label; activity = real spikes / active-neurons / rate aggregated by that label. Mean-membrane-by-region is O(N) only on demand. | `kernel.computeRegions` |
| Coordinates | 3D positions = per-neuron centroid of its T-bar sites. Rendered for visualisation only. | pipeline / BrainView |

## 3. Determinism

Given the same processed graph, parameters, input and random seed, and with
plasticity off, the simulation is reproducible: all randomness uses a seeded
mulberry32 PRNG (noise + Poisson input). The test suite asserts identical spike
counts across two seeded runs.

## 4. What this does NOT claim


- It does not claim LIF reproduces real ion channels, compartmental dendrites,
  or molecular synapse physiology.
- It does not claim the model *recognises* digits 6/7 the way a fly does — the
  readout is a population-rate decision from the connectome's activity; whether
  it separates 6/7 usefully depends on parameters/learning and is reported
  honestly (including a 50/50 or NO_ACTION outcome).
- It does not replace MaleCNS with a generic ML model and does not randomly
  generate neurons or connections; every neuron/edge traces back to a MaleCNS
  body-id pair.
- It never overwrites the original `.feather` data.

## 5. PoopFly (physiology → behaviour → learning)

The connectome, neuron ids, weights and neurotransmitters are still **REAL**
(see §1). The following PoopFly-specific quantities are **model assumptions**,
all configurable (`SimConfig.physio / encode / action / music / dopamine /
plasticity`), and none are MaleCNS measurements:

| Thing | Assumption | Real / Assumed |
|---|---|---|
| Physiology | `gut_content/gut_pressure/comfort/energy/hydration`, appetite, digest, eat/defecate rates, world track/toilet/food | **assumed** (modelled internal state) |
| Interoceptive encoding | `rate = base + (max-base)·pressure^exp` drives the real **PRESSURE neuron pool** as Poisson spikes; no "POOP NOW" injection | assumed encoding, real neurons |
| I/O populations | MaleCNS has no native "defecate"/"song A" neurons; we deterministically designate high-out-degree neurons as **drive** pools and high-in-degree neurons as **motor** pools (ties by index, never random) | documented choice |
| Action selection | Winner-take-all over **motor-population firing rates** from the simulated network + exploration noise; **never** `if pressure>thr → action` | real neural output |
| Environment FSM | IDLE/EAT/SEARCH/AT_TOILET/DEFECATE/RELIEF labels the world and **only gates physical constraints** (e.g. cannot defecate off-toilet); it does not choose actions | environment |
| Homeostatic reward | `error = w_p·pressure + w_e·(1-energy)`; `improvement = Δ(-error)`; `dopamine = clip(gain·improvement)` generated by the **state transition**, not attached to a neuron | assumed, environmental |
| Dopamine pathway | positive/negative improvement → a single modulatory signal used as the 3rd factor; DA-predicted neurons are designated but we do **not** claim they are "poop reward neurons" | assumed mapping |
| Plasticity | **three-factor** rule: eligibility (co-active pre+post) × dopamine, additive on a per-edge `delta`; `base MaleCNS weight` immutable; default OFF, deterministic forces OFF; restricted to synapses actually carrying activity | assumed rule, real synapses |
| Music | songs A/B/C have **hidden** environmental valences (+/0/−); the fly discovers them via the dopamine each song's consequence adds to relief; preference = learned selection rate, **not** hardcoded | assumed |

## 6. Outputs (neither data nor assumption — measured from the simulation)

Spikes, membrane potentials, eligibility, weight deltas, motor readout rates,
chosen action, reward/dopamine, defecation events, song picks, time-to-defecate,
neuropil activity — all read out of the running model and shown in the UI /
`runExperiment()` results. Nothing here is presented as proof of how a real
*fly's* brain works.
