# PoopFly

**A whole-MaleCNS spiking fly brain. It decides for itself when to poop.**

A housefly eats, builds up gut pressure, *feels* it through interoceptive neurons, and the
simulated brain decides to find the toilet and defecate. Relief lowers pressure, which produces a
homeostatic reward (dopamine-like) that drives **three-factor synaptic plasticity** — so over
trials the fly gets faster at pooping when full, and learns which background song it prefers.

There is no `if pressure > threshold: poop()`. The action is read out of **motor-population firing
rates** on the real connectome, in a Web Worker, in your browser.

<p>
  <img alt="Python" src="https://img.shields.io/badge/Python-3.11-3776AB?style=flat-square&logo=python&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node-20-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-149ECA?style=flat-square&logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Three.js" src="https://img.shields.io/badge/three.js-0.169-000000?style=flat-square&logo=three.js&logoColor=white">
  <img alt="tests" src="https://img.shields.io/badge/tests-26%20passing-6E9F18?style=flat-square&logo=vitest&logoColor=white">
</p>

![PoopFly running: the fly perched on the toilet in New York, the live motor-population readout, the music panel and the brain view](docs/media/poopfly.gif)

*The real UI at `partial_100000` — 100,000 neurons, 19,693,793 synapses. The fly picks `EAT` here from
its own motor readout while the brain view shows the spiking network behind it.*

---

## Quick start

Prereqs: **Python 3.11** and **Node 20**.

```bash
pip install -r pipeline/requirements.txt

# one-shot bootstrap: build the graphs if missing, validate, then start the app
.\run.ps1                # Windows
```

Or step by step:

```bash
python pipeline/preprocess.py --modes debug,core     # -> webapp/public/data/<mode>
python pipeline/validate_runtime.py --mode core      # prove the export is self-consistent

cd webapp
npm install
npm run dev                                          # http://localhost:5173
```

```bash
npm test          # 25 tests: LIF kernel, graph integrity, the closed behaviour loop
npm run build     # production bundle
```

`full` and the 100k/50k/10k subsets are built with the benchmark ladder:

```bash
python pipeline/preprocess.py --modes bench
```

---

## The question this answers

*Did the fly poop because the simulated nervous system produced the behaviour, or because the
programmer told it to?*

The code path and the test suite are built so the answer is the former. Interoceptive pressure
becomes a **real Poisson spike train** injected into real neurons; those spikes propagate through
**real measured synapses**; whichever motor population fires hardest *is* the action. Ablate a
region, cut dopamine, disable plasticity — behaviour changes because the **network** changed, not
because a branch in the code did.

The renderer is a **view**. It never produces activity.

---

## Important data-integrity finding (read first)

The `.feather` files **in this folder do not match the published MaleCNS v1.0 release**. This is
reported honestly, never hidden:

| | Published MaleCNS v1.0 | Measured in the provided files |
|---|---:|---:|
| connectome edges | ~25,582,938 | **151,856,684** raw |
| unique `body_pre` | ~166,700 | **1,834,661** (= T-bar bodies exactly) |
| unique `body_post` | ~166,700 | **87,576,984** |
| edges with a valid `body_post` | — | only **32,751,675** (21.6%) |

- `body-annotations` and `body-neurotransmitters` (referenced by the brief) are **not present** —
  only `connectome-weights`, `tbar-neurotransmitters`, `syn-partners`, `syn-points` exist here.
- Every `body_pre` is a real body, but **78.4% of edges point at `body_post` ids that exist in no
  other file** (spurious/corrupt targets). The id space splits into two regimes separated by a
  100× empty gap: small ids `10001–959576` (244,657 bodies — the coherent neurons) and large ids
  `~1e8–1.57e9` (1.59M bodies — almost certainly unmerged fragments). All ids fit in int32.

**How the pipeline handles it (no silent discarding):** edges are kept only when *both* endpoints
are authoritative bodies (the T-bar set). It exports real graphs and reports, per mode, the exact
measured counts and everything it filtered — see `webapp/public/data/build_summary.json` and the
**Integrity** tab in the app.

### Recovered graphs (measured, never theoretical)

| mode | neurons | connections | on disk |
|---|---:|---:|---:|
| `debug` | 3,000 | 341,602 | 7 MB |
| `partial_10000` | 10,000 | 1,734,277 | 34 MB |
| `partial_50000` | 50,000 | 11,092,947 | 214 MB |
| **`partial_100000`** ← recommended | **100,000** | **19,693,793** | **380 MB** |
| `core` — genuine neuron connectome | **241,304** | **26,309,803** | 512 MB |
| `full` — all validated bodies | **1,745,204** | **32,751,675** | 696 MB |

`core` (the small-id neuron regime) reproduces the published edge count (26.3M ≈ 25.6M) — it *is*
the MaleCNS neuron graph. The pipeline is fully data-driven: drop in a clean official
`connectome-weights` file, re-run, and it will emit the genuine 166,700-neuron graph automatically.
The app always shows **measured** counts.

**Which mode to use:** `partial_100000` is the default — real hub topology, runs at ~600 ticks/s,
and poops reliably. `full` carries the most neurons but is sparsely wired and sits near 0.03× real
time; it is a validation scale, not an interactive one.

---

## How the loop works

```
   PHYSIOLOGY                 ENCODING                CONNECTOME (Web Worker)
 ┌───────────────┐      ┌────────────────────┐      ┌──────────────────────────────┐
 │ gut content   │      │ PRESSURE           │      │  LIF spiking network         │
 │ gut pressure  │─────▶│ HUNGER             │─────▶│  on the real MaleCNS graph   │
 │ energy        │      │ MUSIC_A|B|C        │      │  typed-array kernel          │
 │ position      │      │  (Poisson drive)   │      │                              │
 └───────────────┘      └────────────────────┘      │  motor populations → rates   │
         ▲                                           └──────────────┬───────────────┘
         │                                                          │
         │                                            winner-take-all decode
         │                                                          ▼
         │        dopamine ◀── homeostatic improvement ◀── chosen action
         └──────────────────────────────────────────────────────────┘
```

1. **Drive** — gut pressure / hunger / context become Poisson spike rates onto dedicated real
   neuron pools.
2. **Propagate** — spikes cross the real connectome. Synaptic current is *leaky* (`tauSyn`), so
   convergent input summated across the synaptic window is what brings a neuron to threshold.
3. **Decide** — eleven motor populations (`MOVE_*`, `STOP`, `EAT`, `DEFECATE`, `PLAY_MUSIC`,
   `SONG_*`) are read out as firing rates. The strongest one above threshold wins.
4. **Consequence** — the environment applies the action physically, then reports homeostatic
   improvement → reward → dopamine.
5. **Learn** — three-factor plasticity (eligibility × dopamine) changes real synapse weights,
   which changes what the fly does next time.

Exploration is the one deliberately non-neural term: behavioural variability so the fly can
*discover* a rewarded action before reinforcement takes over.

---

## Layout

```
pipeline/                 Python 3.11 — raw feathers to runtime graphs
  inspect_data.py         schema / row inspection of the raw feathers
  preprocess.py           feather -> CSR/CSC runtime graphs + integrity report
  validate_runtime.py     proves exported graphs are self-consistent
  synapse_detail.py       on-demand per-neuron synapse JSON (streams 13 GB safely)
  malecns_common.py       shared constants / body-id handling
docs/
  ARCHITECTURE.md         data flow, sparse representation, the kernel, the loop
  ASSUMPTIONS.md          strict real-vs-modelled split, and what this does NOT claim
webapp/                   Vite + React + TypeScript + Three.js  (see webapp/README.md)
  src/sim/                protocol, LIF kernel, env (physiology), populations, agent, worker
  src/three/              BrainView (spike cloud), ToiletScene (3D stage)
  src/components/         vitals, behaviour, music, learning, experiments, debugger, benchmark
  public/data/<mode>/     generated runtime files (git-ignored)
  tests/                  vitest
run.ps1                   one-shot dev bootstrap
```

Runtime files per mode: `graph.{indptr,indices,weights}`, `graph_r.*` (reverse, for the debugger),
`neurons.{bodyid,nt,region,pos,deg}`, `manifest.json`.

---

## What is real vs. what is modelled

Full detail in **[docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md)**. In short:

**Real** — taken from the provided MaleCNS files, never overwritten:

- neuron identities (body IDs, mapped 1:1 to runtime indices)
- directed connectivity and the immutable `baseW` synapse counts
- neurotransmitter predictions (`tbar-neurotransmitters`)
- anatomy / neuropil labels (80 regions) and per-synapse compartments

**Modelled** — explicit, configurable, documented:

- the LIF point-neuron model and all its parameters (`DEFAULT_CONFIG.lif`)
- synaptic kinetics, transmission delay, and the NT → sign mapping
- input encoding, the choice of drive/motor populations, and output readout
- physiology, homeostatic reward, dopamine, music valence
- plasticity rule, and the per-dataset excitability calibration

Every parameter is live-editable in the app. Change the membrane time constant and the fly's
behaviour changes because the *simulation* changed.

The simulation is **deterministic** given the same graph, seed and parameters (plasticity off):
all randomness uses a seeded PRNG, and the test suite asserts identical spike counts across runs.

**What this does not claim:** it is not a molecular or biophysical reconstruction, the LIF neurons
do not reproduce real ion-channel dynamics, and nothing here is presented as proof of how a real
fly's brain works.

---

## Tests

```bash
cd webapp && npm test
```

```
✓ tests/kernel.test.ts     (7)   LIF dynamics, delays, plasticity, ablation, lazy reverse graph
✓ tests/graph.test.ts     (10)   CSR/CSC integrity, reversed-graph mapping
✓ tests/poopfly.test.ts    (9)   closed loop: neural decisions, reward, determinism
```

The behavioural tests assert the *causal chain*, not just outcomes — forcing a motor population is
what produces the action, and high gut pressure alone never hardcodes `DEFECATE`.

---

## Deployment

The app is 771 KB; the connectome is 1.8 GB. Deploying means deciding where that data lives.

- **Vercel + object storage** — app on Vercel, graphs on Cloudflare R2, pointed at with
  `VITE_DATA_BASE`. Full walkthrough in **[webapp/README.md](webapp/README.md#deployment-vercel)**.
- **GitHub-only** — `partial_100000` (380 MB, largest file 75 MB) fits GitHub's 100 MB per-file
  limit and Vercel's limits better than the other modes. `core` and `full` have 100–125 MB files
  and are **rejected** by GitHub.

The app probes which manifests actually exist at startup and only offers those modes, so hosting
any subset works without code changes.
