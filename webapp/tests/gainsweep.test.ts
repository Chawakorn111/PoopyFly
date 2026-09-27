// @vitest-environment node
import { describe, it } from "vitest";
import { loadGraph } from "./helpers";
import { Kernel } from "../src/sim/kernel";
import { Agent } from "../src/sim/agent";
import { DEFAULT_CONFIG } from "../src/sim/protocol";

const mode = process.env.DIAG_MODE ?? "full";
const TICKS = Number(process.env.DIAG_TICKS ?? 8000);

describe(`gain sweep ${mode}`, () => {
  it("finds a working per-synapse gain", () => {
    const { g } = loadGraph(mode);
    const log = (s: string) => console.log(`[${mode}] ${s}`);
    // graph statistics that matter for excitability
    let sumIn = 0, zero = 0, maxIn = 0;
    for (let i = 0; i < g.N; i++) { sumIn += g.inDeg[i]; if (g.inDeg[i] === 0) zero++; if (g.inDeg[i] > maxIn) maxIn = g.inDeg[i]; }
    log(`N=${g.N} E=${g.E} meanInDeg=${(sumIn / g.N).toFixed(2)} maxInDeg=${maxIn} zeroInDeg=${(100 * zero / g.N).toFixed(1)}%`);

    for (const ws of (process.env.DIAG_WSS ?? "0.05,0.3,1.0").split(",").map(Number)) {
      const c = structuredClone(DEFAULT_CONFIG);
      c.deterministic = true; c.noise.enabled = false; c.plasticity.enabled = false;
      c.lif.weightScale = ws;
      const k = new Kernel(g, c, { INPUT_6: [], INPUT_7: [], READOUT_6: [], READOUT_7: [], NO_ACTION: [] }, ["UNKNOWN"]);
      const a = new Agent(k, c, { N: g.N, outDeg: g.outDeg, inDeg: g.inDeg, ntCode: g.ntCode });
      const dt = DEFAULT_CONFIG.lif.dt / 1000;
      a.resetWorld(0.85);
      const t0 = Date.now();
      for (let t = 0; t < TICKS; t++) a.step(dt);
      const wall = Date.now() - t0;
      const simSec = TICKS * DEFAULT_CONFIG.lif.dt / 1000;
      const m = a.metrics();
      const rates = k.getActionRates().map((r) => r.rate).sort((x, y) => y - x);
      log(`ws=${ws}  ${(TICKS / (wall / 1000) | 0)}tick/s  netSpikes/s=${(k.totalSpikes() / simSec | 0)}  meanHz=${(k.totalSpikes() / simSec / g.N).toFixed(4)}  motorHz=${k.motorDriveHz().toFixed(1)}  spread=${(rates[0] / Math.max(1e-6, rates[rates.length - 1])).toFixed(1)}`);
      log(`   counts=${JSON.stringify(m.actionCounts)} trials=${m.trials} poops=${m.successPoops} pos=${a.w.position.toFixed(3)} p=${a.w.pressure.toFixed(3)}`);
    }
  }, 3600000);
});