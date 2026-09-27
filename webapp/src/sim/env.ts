// Physiology + world + homeostasis for PoopFly.
//
// This is the ENVIRONMENT. It NEVER decides behaviour: it receives an action
// chosen by the neural readout, applies its physical consequences, tracks the
// internal state, and computes the homeostatic outcome -> reward/dopamine.
// Every parameter is a documented model assumption.

import type { PhysioConfig, MusicConfig, DopamineConfig } from "./protocol";

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

// The arena is a 1-D loop of length `bounds`: a fly that keeps walking in one
// direction always comes back around, so it can never be trapped against a wall
// and the toilet is reachable whatever direction its connectome prefers.
const wrap = (x: number, bounds: number) => { const m = x % bounds; return m < 0 ? m + bounds : m; };
const circDist = (a: number, b: number, bounds: number) => { const d = Math.abs(a - b) % bounds; return Math.min(d, bounds - d); };

export interface TickEvents {
  defecated: boolean;      // a defecation episode completed this tick
  ate: boolean;
  startedDefecation: boolean;
  reward: number;          // signed homeostatic improvement (raw)
  dopamine: number;        // clipped modulatory signal from improvement (+ music)
  trialEnded: boolean;     // fullness reached baseline after emptying -> count a trial
}

export class World {
  cfg: PhysioConfig;
  music: MusicConfig;
  dopa: DopamineConfig;
  requiresToilet: boolean;

  position = 0;
  content = 0;         // gut fullness 0..1
  pressure = 0;        // interoceptive fullness/distension 0..1
  comfort = 1;         // 0..1
  energy = 1;          // 0..1
  hydration = 1;       // 0..1

  eating = false;
  defecating = false;
  defecationMs = 0;
  private defecationStartContent = 0;   // gut content when the episode began
  currentSong: string | null = null;
  private lastError = 0;

  constructor(cfg: PhysioConfig, music: MusicConfig, dopa: DopamineConfig, requiresToilet = true) {
    this.cfg = cfg; this.music = music; this.dopa = dopa; this.requiresToilet = requiresToilet;
    this.reset();
  }

  reset(content = this.cfg.contentStart) {
    this.position = this.cfg.foodPos;
    this.content = clamp(content, 0, 1);
    this.pressure = clamp(this.content * this.cfg.pressureGain, 0, 1);
    this.comfort = 1 - this.pressure;
    this.energy = 1; this.hydration = 1;
    this.eating = false; this.defecating = false; this.defecationMs = 0;
    this.currentSong = null;
    this.lastError = 0.8 * this.pressure + 0.2 * (1 - this.energy);
  }

  atToilet() { return circDist(this.position, this.cfg.toiletPos, this.cfg.bounds) < 0.12; }
  nearFood() { return circDist(this.position, this.cfg.foodPos, this.cfg.bounds) < 0.12; }
  setSong(name: string | null) { this.currentSong = name; }

  /** Descriptive state label (physical context only — not a decision). */
  state(): string {
    if (this.defecating) return "DEFECATING";
    if (this.eating) return "EATING";
    if (this.atToilet() && this.pressure > 0.5) return "AT_TOILET";
    if (this.pressure > 0.5) return "SEARCH_TOILET";
    if (this.nearFood() && this.energy < 0.6) return "EATING";
    return "IDLE";
  }

  // apply the neural action + advance physiology by dt seconds.
  step(dt: number, action: string | null): TickEvents {
    const ev: TickEvents = {
      defecated: false, ate: false, startedDefecation: false, reward: 0, dopamine: 0, trialEnded: false,
    };
    const c = this.cfg;

    // ---- action effects (gated by physical constraints, never chosen here) ----
    this.eating = false;
    if (action) {
      switch (action) {
        case "EAT":
          if (this.nearFood()) {
            this.eating = true;
            const before = this.content;
            this.content = clamp(this.content + c.eatRate * dt, 0, 1);
            this.energy = clamp(this.energy + 0.3 * dt, 0, 1);
            if (this.content > before) ev.ate = true;
          }
          break;
        case "MOVE_LEFT": this.position = wrap(this.position - c.movementSpeed * dt, c.bounds); break;
        case "MOVE_RIGHT": this.position = wrap(this.position + c.movementSpeed * dt, c.bounds); break;
        case "MOVE_FORWARD": {
          // move toward whichever goal is relevant (toilet if full, food if not),
          // taking the shortest way around the loop
          const goal = this.pressure > 0.5 ? c.toiletPos : c.foodPos;
          let d = goal - this.position;
          if (d > c.bounds / 2) d -= c.bounds; else if (d < -c.bounds / 2) d += c.bounds;
          this.position = wrap(this.position + Math.sign(d) * c.movementSpeed * dt, c.bounds);
          break;
        }
        case "STOP": break;
        case "DEFECATE":
          if (!this.requiresToilet || this.atToilet()) {
            if (!this.defecating) { ev.startedDefecation = true; this.defecationStartContent = this.content; }
            this.defecating = true;
          }
          break;
        case "PLAY_MUSIC": if (this.currentSong === null) this.currentSong = this.music.songs[0]; break;
        case "STOP_MUSIC": this.currentSong = null; break;
        case "SONG_A": this.currentSong = "A"; break;
        case "SONG_B": this.currentSong = "B"; break;
        case "SONG_C": this.currentSong = "C"; break;
      }
    }

    // ---- defecation progress ----
    if (this.defecating) {
      this.defecationMs += dt * 1000;
      this.content = clamp(this.content - c.defecateRate * dt, 0, 1);
      if (this.content <= 0.02 && this.defecationMs >= c.defecateMinMs) {
        this.defecating = false; this.defecationMs = 0;
        ev.defecated = true;
        // A "trial" is an episode that actually emptied a meaningful load; the
        // relevant measure is the content at the START of the episode (the
        // content on the final tick is by definition ~0).
        if (this.defecationStartContent > 0.05) ev.trialEnded = true;
      }
    }

    // ---- background physiology: passive gut fill (appetite) minus slow digestion ----
    if (!this.eating && !this.defecating) this.content = clamp(this.content + (c.appetite - c.digestRate) * dt, 0, 1);
    const pBefore = this.pressure;
    this.pressure = clamp(this.content * c.pressureGain, 0, 1);
    // comfort relaxes toward (1 - pressure) and is boosted by a pleasant song
    let target = 1 - this.pressure;
    if (this.currentSong !== null) target = clamp(target + (this.music.valence[this.currentSong] ?? 0) * 0.5, 0, 1);
    this.comfort += (target - this.comfort) * Math.min(1, dt * 3);
    this.energy = clamp(this.energy - (this.pressure > 0.6 ? 0.01 : 0.004) * dt, 0, 1);

    // ---- homeostatic error + improvement -> reward/dopamine ----
    const error = 0.8 * this.pressure + 0.2 * (1 - this.energy);
    let improvement = this.lastError - error;
    this.lastError = error;
    // a pleasant song during defecation adds a hedonic bonus (learnable consequence)
    if (this.defecating && this.currentSong !== null) improvement += 0.5 * (this.music.valence[this.currentSong] ?? 0) * dt;
    ev.reward = improvement;
    ev.dopamine = clamp(this.dopa.gain * improvement, -this.dopa.clip, this.dopa.clip);
    void pBefore;
    return ev;
  }
}
