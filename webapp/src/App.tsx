import { useState } from "react";
import { useSimulator } from "./hooks/useSimulator";
import { MODE_LABELS, type SimMode } from "./sim/protocol";
import { VitalsPanel } from "./components/VitalsPanel";
import { BehaviorPanel } from "./components/BehaviorPanel";
import { MusicPanel } from "./components/MusicPanel";
import { ControlPanel } from "./components/ControlPanel";
import { FlyToiletStage } from "./components/FlyToiletStage";
import type { SceneLocation } from "./three/ToiletScene";
import { LearningPanel } from "./components/LearningPanel";
import { ExperimentsPanel } from "./components/ExperimentsPanel";
import { Debugger } from "./components/Debugger";
import { RegionPanel } from "./components/RegionPanel";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { IntegrityPanel } from "./components/IntegrityPanel";

const MODES: SimMode[] = ["full", "core", "partial_100000", "partial_50000", "partial_10000", "debug"];
type Tab = "learning" | "experiments" | "debugger" | "neuropil" | "benchmark" | "integrity";

export default function App() {
  const [mode, setMode] = useState<SimMode>("full");
  const { state, api } = useSimulator(mode);
  const [tab, setTab] = useState<Tab>("learning");
  const [location, setLocation] = useState<SceneLocation>("nyc");
  const m = state.manifest;
  const snap = state.snap;

  return (
    <div className="app meme">
      <header className="memehead">
        <div className="titlebar">
          <div className="title">PoopFly</div>
          <div className={`livepill ${state.running ? "on" : ""}`}>
            <i />{state.running ? "LIVE" : state.loading ? "LOADING" : "PAUSED"}
          </div>
        </div>
        <div className="tag">
          a computational fly nervous system on the real MaleCNS connectome ·{" "}
          <b>{m ? m.neurons.toLocaleString() : "?"}</b> neurons · <b>{m ? m.edges.toLocaleString() : "?"}</b> synapses
          {snap && <> · it decides to <b className="actbadge">{snap.currentAction ?? "…"}</b></>}
        </div>
      </header>

      <main className="main">
        {/* CENTER: the big fly on the toilet */}
        <div className="centercol">
          <FlyToiletStage snap={snap} location={location} onLocation={setLocation} />
          <div className="subgrid">
            <div className="cell"><VitalsPanel state={state} /></div>
            <div className="cell"><MusicPanel state={state} /></div>
          </div>
          <ControlPanel state={state} api={api} />
        </div>

        {/* RIGHT: the small live brain (real spikes) */}
        <aside className="brainaside">
          <div className="minihead">
            <label className="modelabel">dataset</label>
            <select className="modeselect" value={mode} onChange={(e) => setMode(e.target.value as SimMode)} title={MODE_LABELS[mode]}>
              {MODES.map((x) => <option key={x} value={x}>{MODE_LABELS[x]}</option>)}
            </select>
            <div className="hudstat"><b>{state.running ? "LIVE" : "PAUSED"}</b><span>sim</span></div>
            <div className="hudstat"><b>{state.stats ? Math.round(state.stats.spikesPerSec).toLocaleString() : "0"}</b><span>spikes/s</span></div>
            <div className="hudstat"><b>{state.stats ? state.stats.realTimeFactor.toFixed(2) + "×" : "—"}</b><span>rt</span></div>
          </div>
          <div className="brainsmall" id="brain-host">
            {!state.ready && !state.error && (
              <div className="loading">
                <div className="spinner" />
                <div className="ltitle">loading <b>{MODE_LABELS[mode]}</b></div>
                <div className="lsub">{m ? m.neurons.toLocaleString() : ""} neurons · {m ? m.edges.toLocaleString() : ""} synapses</div>
              </div>
            )}
            {state.error && <div className="loading err">{state.error}</div>}
          </div>
          <div className="minibehav"><BehaviorPanel state={state} /></div>
        </aside>
      </main>

      <nav className="tabs">
        {(["learning", "experiments", "debugger", "neuropil", "benchmark", "integrity"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
        <span className="tabspace" />
        <span className="foot-note">brain in a Web Worker · renderer is a view · behaviour read from neural motor populations</span>
      </nav>

      <section className="panel">
        {tab === "learning" && <LearningPanel state={state} />}
        {tab === "experiments" && <ExperimentsPanel state={state} api={api} />}
        {tab === "debugger" && <Debugger state={state} api={api} />}
        {tab === "neuropil" && <RegionPanel regions={state.regions} />}
        {tab === "benchmark" && <BenchmarkPanel benchmark={state.benchmark} onRun={api.benchmark} manifest={m} />}
        {tab === "integrity" && <IntegrityPanel manifest={m} />}
      </section>

      <footer className="foot">
        <span>neurons: <b>{m?.neurons.toLocaleString() ?? "—"}</b></span>
        <span>connections: <b>{m?.edges.toLocaleString() ?? "—"}</b></span>
        <span>counts measured · no hardcoded poop decision · assumptions in docs/ASSUMPTIONS.md</span>
      </footer>
    </div>
  );
}
