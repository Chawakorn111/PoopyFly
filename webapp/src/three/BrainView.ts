// Three.js brain view.
//
// Two layers, both driven ONLY by real simulation spikes:
//   1. BASE cloud  : every neuron as a dim point, coloured by neurotransmitter
//                    (or region). Static; uploaded once; supports 1.7M+ points.
//   2. ACTIVE cloud: a pool of points for recently-spiking neurons, bright and
//                    additively blended, with a fixed per-frame upload cost that
//                    is independent of the network size.
// The renderer is a VIEW into the simulator; it never produces activity.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const NT_COLORS: Record<string, [number, number, number]> = {
  ACh: [1.0, 0.85, 0.3], Glu: [0.4, 1.0, 0.5], GABA: [0.4, 0.6, 1.0],
  HA: [1.0, 0.45, 0.75], DA: [0.7, 0.4, 1.0], "5HT": [1.0, 0.5, 0.35],
  OA: [0.3, 0.9, 0.85], UNKNOWN: [0.7, 0.7, 0.7],
};

export type ColorMode = "nt" | "region";

// how many animation frames a spike stays visible before it fades out
const AGE_FRAMES = 90;

interface ActivePool {
  pos: Float32Array; // capacity*3
  age: Float32Array; // capacity
  count: number;     // active count (compacted each frame)
}

export class BrainView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private base!: THREE.Points;
  private active!: THREE.Points;
  private norm!: Float32Array;
  private ntCodes!: Uint8Array;
  private regions!: Uint16Array;
  private ntNames: string[];
  private regionNames: string[];
  private n: number;
  private colorMode: ColorMode = "nt";
  private maxActive = 0;
  private pool!: ActivePool;
  private raf = 0;

  constructor(container: HTMLElement, n: number, ntNames: string[], regionNames: string[]) {
    this.ntNames = ntNames; this.regionNames = regionNames; this.n = n;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    this.camera.position.set(0, 40, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
  }

  private onResize!: () => void;

  private resize() {
    const el = this.renderer.domElement.parentElement;
    if (!el) return;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setData(positions: Float32Array, nt: Uint8Array, region: Uint16Array) {
    this.ntCodes = nt; this.regions = region;
    const n = this.n;
    // normalise to a ~[-100,100] box, flip Y for a natural viewing frame.
    const min = new Float32Array(3).fill(Infinity);
    const max = new Float32Array(3).fill(-Infinity);
    for (let i = 0; i < n * 3; i += 3) for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v;
    }
    const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const s = 180 / ext;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[3 * i] = (positions[3 * i] - (min[0] + max[0]) / 2) * s;
      arr[3 * i + 1] = -(positions[3 * i + 1] - (min[1] + max[1]) / 2) * s;
      arr[3 * i + 2] = (positions[3 * i + 2] - (min[2] + max[2]) / 2) * s;
    }
    const geo = new THREE.BufferGeometry();
    this.norm = arr;
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    const colAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute("color", colAttr);
    this.colorBase = colAttr;
    // FAINT skeleton: the connectome is barely visible so real spikes can shine.
    const mat = new THREE.PointsMaterial({ size: 0.7, vertexColors: true, transparent: true, opacity: 0.34, sizeAttenuation: true, depthWrite: false });
    this.base = new THREE.Points(geo, mat);
    this.scene.add(this.base);

    this.maxActive = Math.max(5000, Math.min(60_000, n));
    this.pool = { pos: new Float32Array(this.maxActive * 3), age: new Float32Array(this.maxActive), count: 0 };
    const ageAttr = new THREE.BufferAttribute(this.pool.age, 1);
    const ageGeo = new THREE.BufferGeometry();
    ageGeo.setAttribute("position", new THREE.BufferAttribute(this.pool.pos, 3));
    ageGeo.setAttribute("age", ageAttr);
    // Per-spike colour: the neuron's OWN palette colour, deepened when it fires,
    // so activity reads as "this region is lighting up" rather than white sparks.
    const actCol = new THREE.BufferAttribute(new Float32Array(this.maxActive * 3), 3);
    ageGeo.setAttribute("color", actCol);
    ageGeo.setDrawRange(0, 0);
    const ageMat = new THREE.PointsMaterial({ vertexColors: true, size: 2.4, transparent: true, opacity: 1, sizeAttenuation: true, depthWrite: false, depthTest: false });
    this.active = new THREE.Points(ageGeo, ageMat);
    this.ageAttr = ageAttr;
    this.ageGeo = ageGeo;
    this.activeCol = actCol;
    this.posAttr = ageGeo.getAttribute("position") as THREE.BufferAttribute;
    this.scene.add(this.active);
    this.applyColorMode(this.colorMode);
  }

  private colorBase!: THREE.BufferAttribute;
  private activeCol!: THREE.BufferAttribute;
  private activeColors = new Float32Array(0);   // neuron -> deepened colour
  private ageAttr!: THREE.BufferAttribute;
  private posAttr!: THREE.BufferAttribute;
  private ageGeo!: THREE.BufferGeometry;

  setColorMode(mode: ColorMode) {
    this.colorMode = mode;
    this.applyColorMode(mode);
  }

  private applyColorMode(mode: ColorMode) {
    if (!this.colorBase) return;
    const c = this.colorBase.array as Float32Array;
    const n = this.n;
    if (this.activeColors.length !== n * 3) this.activeColors = new Float32Array(n * 3);
    const a = this.activeColors;
    if (mode === "nt") {
      for (let i = 0; i < n; i++) {
        const col = NT_COLORS[this.ntNames[this.ntCodes[i]]] ?? NT_COLORS.UNKNOWN;
        c[3 * i] = col[0] * 0.55; c[3 * i + 1] = col[1] * 0.55; c[3 * i + 2] = col[2] * 0.55;
        const deep = deepen(col);
        a[3 * i] = deep[0]; a[3 * i + 1] = deep[1]; a[3 * i + 2] = deep[2];
      }
    } else {
      const R = Math.max(1, this.regionNames.length);
      for (let i = 0; i < n; i++) {
        const h = (this.regions[i] / R);
        const col = hslToRgb(h, 0.55, 0.42);          // dim base
        c[3 * i] = col[0]; c[3 * i + 1] = col[1]; c[3 * i + 2] = col[2];
        const deep = hslToRgb(h, 1.0, 0.56);          // firing: same hue, fully saturated
        a[3 * i] = deep[0]; a[3 * i + 1] = deep[1]; a[3 * i + 2] = deep[2];
      }
    }
    this.colorBase.needsUpdate = true;
  }

  // called on each worker 'frame' with the transferable spike index array
  onSpikes(spikes: Int32Array) {
    const pool = this.pool;
    const norm = this.norm;
    const actCol = this.activeCol.array as Float32Array;
    const table = this.activeColors;
    let count = pool.count;
    for (let k = 0; k < spikes.length; k++) {
      if (count >= this.maxActive) break;
      const i = spikes[k];
      if (i < 0 || i >= this.n) continue;
      const j = 3 * i;
      pool.pos[3 * count] = norm[j];
      pool.pos[3 * count + 1] = norm[j + 1];
      pool.pos[3 * count + 2] = norm[j + 2];
      pool.age[count] = 0;
      actCol[3 * count] = table[j];
      actCol[3 * count + 1] = table[j + 1];
      actCol[3 * count + 2] = table[j + 2];
      count++;
    }
    pool.count = count;
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const pool = this.pool;
      let count = pool.count;
      const age = pool.age, pos = pool.pos;
      const actCol = this.activeCol.array as Float32Array;
      let w = 0;
      for (let i = 0; i < count; i++) {
        age[i] += 1;
        if (age[i] < AGE_FRAMES) {
          pos[3 * w] = pos[3 * i]; pos[3 * w + 1] = pos[3 * i + 1]; pos[3 * w + 2] = pos[3 * i + 2];
          actCol[3 * w] = actCol[3 * i]; actCol[3 * w + 1] = actCol[3 * i + 1]; actCol[3 * w + 2] = actCol[3 * i + 2];
          age[w] = age[i];
          w++;
        }
      }
      pool.count = w;
      this.ageGeo.setDrawRange(0, w);
      this.ageAttr.needsUpdate = true;
      this.activeCol.needsUpdate = true;
      this.posAttr.needsUpdate = true;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  stop() { cancelAnimationFrame(this.raf); }
  dispose() {
    this.stop();
    window.removeEventListener("resize", this.onResize);
    const el = this.renderer.domElement;
    if (el && el.parentElement) el.parentElement.removeChild(el);
    this.renderer.dispose();
    this.scene.traverse((o) => { const p = o as any; if (p.geometry) p.geometry.dispose(); if (p.material) p.material.dispose(); });
  }
}

// Push a palette colour toward its fully saturated, deeper form so a firing
// neuron reads as a richer version of its own colour (never a white spark).
function deepen(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const mid = (r + g + b) / 3;
  if (mx - mn < 1e-4) {
    const v = Math.min(1, mid * 0.8 + 0.2);
    return [v, v, v];
  }
  let out = [r, g, b].map((c) => mid + (c - mid) * 1.85);
  const m = Math.max(out[0], out[1], out[2]);
  if (m > 0.9) out = out.map((c) => c * (0.9 / m));
  return out.map((c) => Math.min(1, Math.max(0, c))) as [number, number, number];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
