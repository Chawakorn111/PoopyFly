// Full 3D PoopFly stage: a procedural porcelain toilet + a realistic housefly
// perched on the seat + 3D poop that drops into the bowl and piles up.
//
// Everything is Three.js primitives / lathe geometry + procedurally generated
// textures (no external assets). The scene is a pure VIEW: pose / poop count are
// driven by real simulation state.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export type SceneLocation = "fuji" | "nyc" | "bangkok";

export interface StagePose {
  defecating: boolean;
  desperate: boolean;
  relieved: boolean;
  pressure: number;
  music: string | null;
  poopCount: number;
}

const SEAT_Y = 1.30;

function makeOmmatidiaTexture(): THREE.CanvasTexture {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000"; g.fillRect(0, 0, s, s); g.fillStyle = "#fff";
  const r = 5, step = 11;
  for (let y = 0; y < s + step; y += step) {
    const off = ((y / step) % 2) * (step / 2);
    for (let x = -step; x < s + step; x += step) { g.beginPath(); g.arc(x + off, y, r, 0, Math.PI * 2); g.fill(); }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 2); return t;
}
function makeWingTexture(): THREE.CanvasTexture {
  const w = 256, h = 128, c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!; g.clearRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "rgba(210,225,255,0.30)"); grad.addColorStop(0.5, "rgba(230,240,255,0.18)"); grad.addColorStop(1, "rgba(200,215,255,0.34)");
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(40,55,70,0.85)"; g.lineWidth = 2.4;
  const tips: [number, number][] = [[w, 20], [w, 55], [w, 95], [w, 118], [w * 0.8, h - 4], [w * 0.4, h - 2]];
  for (const [tx, ty] of tips) { g.beginPath(); g.moveTo(10, h / 2); g.quadraticCurveTo(w * 0.45, ty * 0.7 + h * 0.1, tx, ty); g.stroke(); }
  g.lineWidth = 3.5; g.beginPath(); g.moveTo(10, h / 2); g.quadraticCurveTo(w * 0.5, 6, w, 18); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function makeSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 64; c.height = 256;
  const x = c.getContext("2d")!; const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#081326"); g.addColorStop(0.42, "#1c355c"); g.addColorStop(0.6, "#556184");
  g.addColorStop(0.72, "#d98a5a"); g.addColorStop(0.8, "#7d5642"); g.addColorStop(1, "#1d2129");
  x.fillStyle = g; x.fillRect(0, 0, 64, 256);
  // soft dusky clouds
  for (let i = 0; i < 12; i++) {
    const cy = 60 + Math.random() * 120, cw = 18 + Math.random() * 40, cx = Math.random() * 64;
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, cw);
    rg.addColorStop(0, "rgba(255,214,180,0.16)"); rg.addColorStop(1, "rgba(255,214,180,0)");
    x.fillStyle = rg; x.fillRect(0, cy - 30, 64, 60);
  }
  // moon glow
  const mg = x.createRadialGradient(46, 58, 0, 46, 58, 18);
  mg.addColorStop(0, "rgba(255,250,235,0.55)"); mg.addColorStop(0.22, "rgba(255,246,224,0.28)"); mg.addColorStop(1, "rgba(255,246,224,0)");
  x.fillStyle = mg; x.fillRect(16, 28, 60, 60);
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeFujiSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 64; c.height = 256;
  const x = c.getContext("2d")!; const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#0f2350"); g.addColorStop(0.36, "#4a6aa8"); g.addColorStop(0.58, "#f0a878");
  g.addColorStop(0.7, "#ffd9a6"); g.addColorStop(0.82, "#c98f6e"); g.addColorStop(1, "#5a4a42");
  x.fillStyle = g; x.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 14; i++) { const cy = 70 + Math.random() * 90, cw = 16 + Math.random() * 34, cx = Math.random() * 64; const rg = x.createRadialGradient(cx, cy, 0, cx, cy, cw); rg.addColorStop(0, "rgba(255,225,205,0.22)"); rg.addColorStop(1, "rgba(255,225,205,0)"); x.fillStyle = rg; x.fillRect(0, cy - 24, 64, 48); }
  const sun = x.createRadialGradient(22, 150, 0, 22, 150, 30); sun.addColorStop(0, "rgba(255,245,225,0.55)"); sun.addColorStop(0.3, "rgba(255,210,170,0.32)"); sun.addColorStop(1, "rgba(255,210,170,0)"); x.fillStyle = sun; x.fillRect(-8, 120, 64, 64);
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeBangkokSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 64; c.height = 256;
  const x = c.getContext("2d")!; const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#1a1436"); g.addColorStop(0.4, "#5a2f63"); g.addColorStop(0.6, "#c65a6b");
  g.addColorStop(0.72, "#ffb066"); g.addColorStop(0.84, "#7a4a52"); g.addColorStop(1, "#241a2a");
  x.fillStyle = g; x.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 16; i++) { const cy = 60 + Math.random() * 100, cw = 16 + Math.random() * 40, cx = Math.random() * 64; const rg = x.createRadialGradient(cx, cy, 0, cx, cy, cw); rg.addColorStop(0, "rgba(255,150,190,0.18)"); rg.addColorStop(1, "rgba(255,150,190,0)"); x.fillStyle = rg; x.fillRect(0, cy - 24, 64, 48); }
  const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

function makeAsphaltTexture(): THREE.CanvasTexture {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s; const g = c.getContext("2d")!;
  g.fillStyle = "#3a3f45"; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 7000; i++) { const v = 28 + ((Math.random() * 60) | 0); g.fillStyle = `rgba(${v},${v},${v + 4},0.5)`; g.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeWindowsTexture(): THREE.CanvasTexture {
  const w = 128, h = 256, c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!;
  g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
  const cols = 8, rows = 20, cw = w / cols, ch = h / rows, r = rng(7);
  for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) {
    if (r() < 0.58) {
      const lit = r() < 0.7;
      g.fillStyle = lit ? `rgba(${(225 + r() * 30) | 0},${(185 + r() * 45) | 0},${(115 + r() * 70) | 0},1)` : "rgba(95,115,145,0.5)";
      g.fillRect(xx * cw + cw * 0.18, yy * ch + ch * 0.2, cw * 0.64, ch * 0.48);
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeSidewalkTexture(): THREE.CanvasTexture {
  const s = 256, c = document.createElement("canvas"); c.width = c.height = s; const g = c.getContext("2d")!;
  g.fillStyle = "#9a9ea3"; g.fillRect(0, 0, s, s); g.strokeStyle = "#7f8388"; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 64); g.lineTo(s, i * 64); g.stroke(); g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, s); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class ToiletScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private raf = 0;
  private pose: StagePose = { defecating: false, desperate: false, relieved: false, pressure: 0, music: null, poopCount: 0 };
  private onResize: () => void; private ro: ResizeObserver | null = null;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private hemi!: THREE.HemisphereLight;
  private env: THREE.Group | null = null;
  private location: SceneLocation = "nyc";

  private fly = new THREE.Group();
  private head!: THREE.Group;
  private phone!: THREE.Group;
  private phoneCanvas!: HTMLCanvasElement;
  private phoneTex!: THREE.CanvasTexture;
  private phoneLight!: THREE.PointLight;
  private holdT = 0;   // smoothed 0..1 "is holding the phone" (no snapping)
  private wings: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private abdomen!: THREE.Group;
  private poopPile = new THREE.Group();
  private fallingPoop: THREE.Group | null = null;
  private dropPhase = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Soft, filmic grade: ACES rolls highlights off so the porcelain / windows
    // never clip to raw white. Exposure is deliberately well below 1.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.52;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 2.25, 5.6); this.camera.lookAt(0, 1.12, 0);

    // drag to rotate / wheel to zoom the whole 3D scene (fly + toilet)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.12, 0.15);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.0; this.controls.maxDistance = 9.5;
    this.controls.minPolarAngle = 0.25; this.controls.maxPolarAngle = 1.55;
    this.controls.update();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    // RoomEnvironment at low intensity = soft neutral reflections without glare.
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    pmrem.dispose();
    // --- lighting rig: warm key + cool fill + gentle rim, all kept modest ---
    this.hemi = new THREE.HemisphereLight(0xbcd2f0, 0x141b24, 0.22); this.scene.add(this.hemi);
    const key = new THREE.DirectionalLight(0xffe9cf, 0.62); key.position.set(3, 5.5, 4); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.near = 1; key.shadow.camera.far = 20;
    key.shadow.camera.left = -4; key.shadow.camera.right = 4; key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
    key.shadow.bias = -0.0012; key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9dc0ff, 0.22); fill.position.set(-3.2, 2.2, 3.2); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.3); rim.position.set(-3.5, 2, -3); this.scene.add(rim);
    const bounce = new THREE.DirectionalLight(0xffd6a8, 0.12); bounce.position.set(0, -2, 1.5); this.scene.add(bounce);

    // location (sky + fog + ground/scenery); switchable at runtime
    this.setLocation("nyc");

    this.scene.add(this.buildToilet());
    this.scene.add(this.buildFly());
    this.scene.add(this.poopPile);

    // Subtle bloom: threshold sits just under the emissive lamp/neon values so
    // only those halo softly. Porcelain, skin and sky stay crisp and un-hazed.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.13, 0.45, 0.42));
    this.composer.addPass(new OutputPass());

    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    if (typeof ResizeObserver !== "undefined") { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container); }
    this.resize();
  }

  private resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }

  // ---------- porcelain toilet ----------
  private buildToilet(): THREE.Group {
    const g = new THREE.Group();
    // Warm, slightly blue-grey porcelain: reads as ceramic, not glowing white.
    const porcelain = new THREE.MeshPhysicalMaterial({
      color: 0xdfe4e8, roughness: 0.22, metalness: 0.0,
      clearcoat: 0.75, clearcoatRoughness: 0.18, envMapIntensity: 0.75,
      sheen: 0.25, sheenColor: new THREE.Color(0xbcd0e6),
    });
    const porcelainDark = new THREE.MeshPhysicalMaterial({
      color: 0xb6bec6, roughness: 0.34, metalness: 0.05,
      clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.6,
    });
    const profile: [number, number][] = [
      [0.0, 0.0], [0.55, 0.0], [0.60, 0.06], [0.44, 0.10], [0.32, 0.34], [0.35, 0.62],
      [0.55, 0.82], [0.72, 0.98], [0.86, 1.12], [0.93, 1.22], [0.86, 1.29], [0.62, 1.27],
      [0.55, 1.14], [0.40, 1.00], [0.30, 0.94], [0.0, 0.94],
    ];
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 64), porcelain);
    bowl.castShadow = true; bowl.receiveShadow = true; g.add(bowl);

    // soft contact shadow so the toilet sits on the ground instead of floating
    const shadowTex = (() => {
      const s = 128, c = document.createElement("canvas"); c.width = c.height = s;
      const x2 = c.getContext("2d")!;
      const rg = x2.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      rg.addColorStop(0, "rgba(0,0,0,0.55)"); rg.addColorStop(0.55, "rgba(0,0,0,0.22)"); rg.addColorStop(1, "rgba(0,0,0,0)");
      x2.fillStyle = rg; x2.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(c);
    })();
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.0),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 }),
    );
    contact.rotation.x = -Math.PI / 2; contact.position.y = 0.012; g.add(contact);

    // seat ring
    const seat = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.10, 20, 64), porcelain);
    seat.rotation.x = Math.PI / 2; seat.position.y = SEAT_Y; seat.castShadow = true; seat.receiveShadow = true; g.add(seat);

    // open lid standing up behind
    const lid = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.10, 48), porcelain);
    disc.rotation.x = Math.PI / 2; lid.add(disc);
    const rimLid = new THREE.Mesh(new THREE.TorusGeometry(0.80, 0.05, 12, 48), porcelain);
    lid.add(rimLid);
    lid.position.set(0, 2.02, -0.72); lid.rotation.x = 0.22; lid.castShadow = true;
    g.add(lid);

    // tank
    const tank = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.95, 0.5), porcelain);
    tank.position.set(0, 1.72, -1.02); tank.castShadow = true; tank.receiveShadow = true; g.add(tank);
    const tankTop = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.09, 0.56), porcelainDark);
    tankTop.position.set(0, 2.22, -1.02); g.add(tankTop);
    const flush = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 20), new THREE.MeshPhysicalMaterial({ color: 0x8e9aa6, roughness: 0.42, metalness: 0.35, envMapIntensity: 0.6 }));
    flush.position.set(0.3, 2.28, -1.02); g.add(flush);

    // water in the bowl — dark and reflective rather than bright
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.6, 40), new THREE.MeshPhysicalMaterial({
      color: 0x2c4258, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.9,
      clearcoat: 1, envMapIntensity: 0.85,
    }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.97; g.add(water);
    return g;
  }

  // ---------- New York street background ----------
  private buildCity(): THREE.Group {
    const g = new THREE.Group();
    const asphalt = makeAsphaltTexture(); asphalt.repeat.set(60, 60);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.96 }));
    road.rotation.x = -Math.PI / 2; road.receiveShadow = true; g.add(road);

    // lane dashes + crosswalk
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xe9dfa8, roughness: 0.7, emissive: 0x2a2410, emissiveIntensity: 0.22 });
    for (let i = -8; i <= 8; i++) { const d = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.02, 0.16), dashMat); d.position.set(i * 2.6, 0.011, 3.4); g.add(d); }
    const cwMat = new THREE.MeshStandardMaterial({ color: 0xdfe2e6, roughness: 0.85 });
    for (let i = -5; i <= 5; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.02, 2.2), cwMat); s.position.set(i * 1.3, 0.012, 1.1); g.add(s); }

    // sidewalk + curb along the far side (buildings behind)
    const swTex = makeSidewalkTexture(); swTex.repeat.set(20, 2);
    const swMat = new THREE.MeshStandardMaterial({ map: swTex, roughness: 0.92, color: 0xc7cace });
    const walk = new THREE.Mesh(new THREE.BoxGeometry(70, 0.24, 3.4), swMat); walk.position.set(0, 0.12, -6.6); walk.receiveShadow = true; g.add(walk);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(70, 0.3, 0.2), new THREE.MeshStandardMaterial({ color: 0x8d9196, roughness: 0.9 })); curb.position.set(0, 0.15, -4.85); g.add(curb);

    // buildings
    const winTex = makeWindowsTexture();
    const tints = [0x2b303a, 0x343139, 0x26313b, 0x3a352f, 0x2e2a33];
    const r = rng(20240611);
    const addBuilding = (x: number, z: number, w: number, d: number, h: number) => {
      const wt = winTex.clone(); wt.needsUpdate = true; wt.repeat.set(Math.max(3, Math.round(w / 1.6)), Math.max(4, Math.round(h / 2.2)));
      const mat = new THREE.MeshStandardMaterial({ color: tints[(r() * tints.length) | 0], roughness: 0.82, emissive: 0xffffff, emissiveMap: wt, emissiveIntensity: 0.22 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, h / 2, z); b.castShadow = true; b.receiveShadow = true; g.add(b);
      // lit ground-floor storefront
      const store = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 2.0, d * 0.98), new THREE.MeshStandardMaterial({ color: 0x241d16, emissive: 0xffb060, emissiveIntensity: 0.14, roughness: 0.5 }));
      store.position.set(x, 1.0, z); g.add(store);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.4, d + 0.3), new THREE.MeshStandardMaterial({ color: 0x20242b, roughness: 0.9 })); cap.position.set(x, h + 0.2, z); g.add(cap);
      // setback tower + spire for tall buildings
      if (h > 20) {
        const uw = w * 0.66, ud = d * 0.66, uh = h * 0.5 + 4;
        const up = new THREE.Mesh(new THREE.BoxGeometry(uw, uh, ud), mat); up.position.set(x, h + uh / 2, z); up.castShadow = true; g.add(up);
        const cap2 = new THREE.Mesh(new THREE.BoxGeometry(uw + 0.3, 0.4, ud + 0.3), new THREE.MeshStandardMaterial({ color: 0x1c2027, roughness: 0.9 })); cap2.position.set(x, h + uh + 0.2, z); g.add(cap2);
        if (r() < 0.6) {
          const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.14, 5.5, 8), new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.5, roughness: 0.5 })); spire.position.set(x, h + uh + 3, z); g.add(spire);
          const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0xff2222, emissiveIntensity: 0.45 })); beacon.position.set(x, h + uh + 5.7, z); g.add(beacon);
        }
      }
      if (r() < 0.28) { // rooftop water tower
        const wtg = new THREE.Group();
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 14), new THREE.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 0.85 })); tank.position.y = 0.8; wtg.add(tank);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.05, 0.7, 14), new THREE.MeshStandardMaterial({ color: 0x3a2f24, roughness: 0.85 })); cone.position.y = 1.9; wtg.add(cone);
        for (let k = 0; k < 4; k++) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), new THREE.MeshStandardMaterial({ color: 0x2a2a2a })); const a = k * Math.PI / 2; leg.position.set(Math.cos(a) * 0.7, -0.7, Math.sin(a) * 0.7); wtg.add(leg); }
        wtg.position.set(x + w * 0.22, h + 0.2, z + d * 0.22); g.add(wtg);
      }
    };
    for (let i = 0; i < 12; i++) addBuilding(-30 + i * 5.2 + (r() - 0.5) * 1.5, -11 - r() * 4, 3.5 + r() * 3, 4 + r() * 3, 8 + r() * 15);
    for (let i = 0; i < 14; i++) addBuilding(-42 + i * 6.2 + (r() - 0.5) * 2, -27 - r() * 12, 5 + r() * 4, 6 + r() * 4, 16 + r() * 30);
    for (let i = 0; i < 18; i++) addBuilding(-70 + i * 8 + (r() - 0.5) * 3, -60 - r() * 26, 7 + r() * 6, 8 + r() * 6, 24 + r() * 46);
    addBuilding(-16, -3.5, 5, 6, 22); addBuilding(16, -3.5, 5, 6, 25);

    // street lamps
    const metal = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.6, metalness: 0.4 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffe0a0, emissiveIntensity: 0.4 });
    for (const lx of [-9, 0, 9]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.4, 10), metal); pole.position.set(lx, 2.2, -6.9); g.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.3), metal); arm.position.set(lx, 4.4, -6.3); g.add(arm);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 10), glow); head.position.set(lx, 4.35, -5.7); g.add(head);
    }
    const lampLight = new THREE.PointLight(0xffdca0, 1.1, 14, 2); lampLight.position.set(0, 4.3, -5.6); g.add(lampLight);

    // traffic light
    const tl = new THREE.Group();
    const tpole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.8, 10), metal); tpole.position.y = 2.4; tl.add(tpole);
    const tarm = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.1), metal); tarm.position.set(0.85, 4.7, 0); tl.add(tarm);
    const tbox = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.72, 0.24), new THREE.MeshStandardMaterial({ color: 0x1a1e22, roughness: 0.7 })); tbox.position.set(1.6, 4.35, 0); tl.add(tbox);
    [0xff3b30, 0xffcc00, 0x34c759].forEach((c, i) => { const dot = new THREE.Mesh(new THREE.CircleGeometry(0.07, 12), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i === 0 ? 0.8 : 0.15 })); dot.position.set(1.6, 4.6 - i * 0.22, 0.13); tl.add(dot); });
    tl.position.set(-9, 0, -4.7); g.add(tl);

    // fire hydrant
    const hyd = new THREE.Group(); const hMat = new THREE.MeshStandardMaterial({ color: 0xb02a1f, roughness: 0.5 });
    const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.6, 12), hMat); hb.position.y = 0.3; hyd.add(hb);
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), hMat); hd.position.y = 0.62; hyd.add(hd);
    const hc = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 10), hMat); hc.rotation.z = Math.PI / 2; hc.position.y = 0.45; hyd.add(hc);
    hyd.position.set(8.5, 0, -4.6); g.add(hyd);

    // yellow taxi
    const taxi = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.55, 1.0), new THREE.MeshPhysicalMaterial({ color: 0xf7c21e, roughness: 0.4, clearcoat: 0.6, metalness: 0.1 })); body.position.y = 0.5; body.castShadow = true; taxi.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.5, 0.92), new THREE.MeshStandardMaterial({ color: 0x141a20, roughness: 0.2, metalness: 0.3 })); cabin.position.set(-0.15, 0.98, 0); taxi.add(cabin);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe08a, emissiveIntensity: 0.26 })); sign.position.set(-0.15, 1.3, 0); taxi.add(sign);
    for (const [wx, wz] of [[-0.85, 0.5], [0.85, 0.5], [-0.85, -0.5], [0.85, -0.5]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.16, 14), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 })); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.26, wz); taxi.add(w); }
    taxi.position.set(6.5, 0, -2.2); g.add(taxi);

    // parked cars along the curb
    const makeCar = (color: number, x: number, z: number) => {
      const car = new THREE.Group();
      const cb = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.5, 0.95), new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, clearcoat: 0.8, metalness: 0.25 })); cb.position.y = 0.48; cb.castShadow = true; car.add(cb);
      const cc = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.46, 0.88), new THREE.MeshStandardMaterial({ color: 0x161b21, roughness: 0.12, metalness: 0.35 })); cc.position.set(-0.1, 0.92, 0); car.add(cc);
      for (const [wx, wz] of [[-0.8, 0.48], [0.8, 0.48], [-0.8, -0.48], [0.8, -0.48]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.15, 14), new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.85 })); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.25, wz); car.add(w); }
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.72), new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1010, emissiveIntensity: 0.4 })); tail.position.set(-1.16, 0.5, 0); car.add(tail);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.66), new THREE.MeshStandardMaterial({ color: 0xfff6d0, emissive: 0xfff0c0, emissiveIntensity: 0.4 })); head.position.set(1.16, 0.5, 0); car.add(head);
      car.position.set(x, 0, z); return car;
    };
    g.add(makeCar(0x2b6cb0, -6.5, -4.2)); g.add(makeCar(0xb03434, -1.5, -4.2)); g.add(makeCar(0xe8e8ea, 3.6, -4.2));

    // manhole covers
    for (const [mx, mz] of [[-3, 0.4], [4, -0.9], [-6, -1.8]]) { const mh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.03, 20), new THREE.MeshStandardMaterial({ color: 0x2b2f34, metalness: 0.55, roughness: 0.65 })); mh.position.set(mx, 0.016, mz); g.add(mh); }

    return g;
  }

  // ---------- location switching ----------
  private disposeObject(root: THREE.Object3D) {
    root.traverse((o) => {
      const any = o as any;
      any.geometry?.dispose?.();
      const mats = any.material ? (Array.isArray(any.material) ? any.material : [any.material]) : [];
      for (const m of mats) {
        for (const k of ["map", "emissiveMap", "roughnessMap", "metalnessMap", "normalMap", "bumpMap", "alphaMap", "envMap"]) {
          m[k]?.dispose?.();
        }
        m.dispose?.();
      }
    });
  }

  setLocation(l: SceneLocation) {
    if (this.env && l === this.location) return;
    this.location = l;
    if (this.env) {
      this.scene.remove(this.env);
      this.disposeObject(this.env);
      this.env = null;
    }
    const prevBg = this.scene.background as THREE.Texture | null;
    if (l === "fuji") { this.scene.background = makeFujiSkyTexture(); this.scene.fog = new THREE.Fog(0xe8c3a0, 45, 170); this.hemi.color.set(0xffd9b0); this.hemi.groundColor.set(0x4a5a3a); this.hemi.intensity = 0.26; }
    else if (l === "bangkok") { this.scene.background = makeBangkokSkyTexture(); this.scene.fog = new THREE.Fog(0x5a4356, 34, 130); this.hemi.color.set(0xffc0a0); this.hemi.groundColor.set(0x2a2030); this.hemi.intensity = 0.22; }
    else { this.scene.background = makeSkyTexture(); this.scene.fog = new THREE.Fog(0x2a3f5e, 30, 120); this.hemi.color.set(0xcfe0ff); this.hemi.groundColor.set(0x1a2026); this.hemi.intensity = 0.22; }
    prevBg?.dispose?.();
    this.env = l === "fuji" ? this.buildFuji() : l === "bangkok" ? this.buildBangkok() : this.buildCity();
    this.scene.add(this.env);
  }

  // ---------- Mount Fuji ----------
  private buildFuji(): THREE.Group {
    const g = new THREE.Group(); const r = rng(555);
    const meadow = new THREE.Mesh(new THREE.CircleGeometry(150, 48), new THREE.MeshStandardMaterial({ color: 0x5f7a3f, roughness: 1 }));
    meadow.rotation.x = -Math.PI / 2; meadow.receiveShadow = true; g.add(meadow);
    // snow-capped volcano
    const cone = new THREE.Mesh(new THREE.ConeGeometry(44, 34, 64, 1), new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.95 }));
    cone.position.set(-6, 17, -72); g.add(cone);
    const snow = new THREE.Mesh(new THREE.ConeGeometry(12.5, 12, 48), new THREE.MeshStandardMaterial({ color: 0xf7fbff, roughness: 0.7 }));
    snow.position.set(-6, 30, -72); g.add(snow);
    for (let i = 0; i < 6; i++) { const h = new THREE.Mesh(new THREE.SphereGeometry(10 + r() * 14, 20, 14), new THREE.MeshStandardMaterial({ color: 0x4f6a38, roughness: 1 })); h.position.set(-60 + i * 24 + (r() - 0.5) * 8, -6, -34 - r() * 20); h.scale.y = 0.5; g.add(h); }
    // torii gate
    const red = new THREE.MeshStandardMaterial({ color: 0xb5342a, roughness: 0.6 });
    const torii = new THREE.Group();
    for (const px of [-2.4, 2.4]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 6, 10), red); p.position.set(px, 3, 0); torii.add(p); }
    const tTop = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.5, 0.7), red); tTop.position.set(0, 6, 0); torii.add(tTop);
    const tBeam = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.4, 0.5), red); tBeam.position.set(0, 7, 0); torii.add(tBeam);
    torii.position.set(0, 0, -11); g.add(torii);
    // sakura trees
    const addSakura = (x: number, z: number, s: number) => {
      const t = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0x5b432f, roughness: 1 })); trunk.position.y = 1.2; t.add(trunk);
      for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.9 + r() * 0.4, 12, 10), new THREE.MeshStandardMaterial({ color: 0xffb7d0, roughness: 0.9 })); b.position.set((r() - 0.5) * 1.6, 2.6 + r() * 0.8, (r() - 0.5) * 1.6); t.add(b); }
      t.position.set(x, 0, z); t.scale.setScalar(s); g.add(t);
    };
    for (let i = 0; i < 5; i++) addSakura(-18 + i * 9 + (r() - 0.5) * 4, -9 - r() * 6, 0.9 + r() * 0.5);
    // little pavilion
    const pav = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 3), new THREE.MeshStandardMaterial({ color: 0xd9c9a8, roughness: 0.9 })); wall.position.y = 0.8; pav.add(wall);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.5, 4), new THREE.MeshStandardMaterial({ color: 0x2b3a4a, roughness: 0.8 })); roof.position.y = 2.35; roof.rotation.y = Math.PI / 4; pav.add(roof);
    pav.position.set(15, 0, -15); g.add(pav);
    return g;
  }

  // ---------- Bangkok ----------
  private buildBangkok(): THREE.Group {
    const g = new THREE.Group(); const r = rng(777);
    const asphalt = makeAsphaltTexture(); asphalt.repeat.set(50, 50);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 })); road.rotation.x = -Math.PI / 2; road.receiveShadow = true; g.add(road);
    const swTex = makeSidewalkTexture(); swTex.repeat.set(18, 2);
    const walk = new THREE.Mesh(new THREE.BoxGeometry(70, 0.24, 3.2), new THREE.MeshStandardMaterial({ map: swTex, roughness: 0.92, color: 0xc9c3b6 })); walk.position.set(0, 0.12, -6.4); walk.receiveShadow = true; g.add(walk);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(70, 0.3, 0.2), new THREE.MeshStandardMaterial({ color: 0x9a9488, roughness: 0.9 })); curb.position.set(0, 0.15, -4.85); g.add(curb);
    // golden wat prang
    const gold = new THREE.MeshStandardMaterial({ color: 0xd9a521, metalness: 0.6, roughness: 0.35, emissive: 0x2a1f06, emissiveIntensity: 0.22 });
    const wat = new THREE.Group(); let y = 0;
    for (let i = 0; i < 5; i++) { const w = 6 - i; const hh = 3.0; const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, w), gold); b.position.y = y + hh / 2; wat.add(b); y += hh * 0.92; }
    const spire = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4.5, 8), gold); spire.position.y = y + 2.2; wat.add(spire);
    wat.position.set(-15, 0, -17); g.add(wat);
    // palm trees
    const addPalm = (x: number, z: number) => {
      const t = new THREE.Group();
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 6, 10), new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1 })); tr.position.y = 3; t.add(tr);
      for (let k = 0; k < 7; k++) { const fr = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.6, 6), new THREE.MeshStandardMaterial({ color: 0x3f6b2f, roughness: 1 })); const a = k / 7 * Math.PI * 2; fr.position.set(Math.cos(a) * 0.9, 6.1, Math.sin(a) * 0.9); fr.rotation.z = 1.35; fr.rotation.y = -a; t.add(fr); }
      t.position.set(x, 0, z); g.add(t);
    };
    for (let i = 0; i < 5; i++) addPalm(-24 + i * 11 + (r() - 0.5) * 3, -9 - r() * 4);
    // tuk-tuk
    const tuk = new THREE.Group(); const teal = new THREE.MeshPhysicalMaterial({ color: 0x2aa198, roughness: 0.35, clearcoat: 0.8, metalness: 0.2 });
    const tb = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.9), teal); tb.position.y = 0.55; tuk.add(tb);
    const tc = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.8), teal); tc.position.set(-0.2, 1.05, 0); tuk.add(tc);
    const trf = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 1.0), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 })); trf.position.set(0, 1.5, 0); tuk.add(trf);
    for (const [wx, wz] of [[0.85, 0], [-0.75, 0.5], [-0.75, -0.5]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12), new THREE.MeshStandardMaterial({ color: 0x111111 })); w.rotation.x = Math.PI / 2; w.position.set(wx, 0.24, wz); tuk.add(w); }
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: 0x33ff99, emissive: 0x22cc66, emissiveIntensity: 0.36 })); tl.position.set(0.87, 0.6, 0); tuk.add(tl);
    tuk.position.set(6.5, 0, -2.2); g.add(tuk);
    // street-food stall with umbrella
    const stall = new THREE.Group();
    const cart = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 1.0), new THREE.MeshStandardMaterial({ color: 0x8a4b2a, roughness: 0.8 })); cart.position.y = 0.9; stall.add(cart);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x777777 })); pole.position.y = 1.6; stall.add(pole);
    const umb = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 12), new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.7, side: THREE.DoubleSide })); umb.position.y = 3.0; stall.add(umb);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffdd88, emissive: 0xffcc66, emissiveIntensity: 0.36 })); bulb.position.set(0, 2.5, 0); stall.add(bulb);
    stall.position.set(-7, 0, -4.4); g.add(stall);
    // neon signs
    const neon = (color: number, x: number, h: number) => { const p = new THREE.Mesh(new THREE.BoxGeometry(2.6, h, 0.3), new THREE.MeshStandardMaterial({ color: 0x111318, emissive: color, emissiveIntensity: 0.32 })); p.position.set(x, 2 + h / 2, -8.5); g.add(p); };
    neon(0xff3b6b, -3, 3.2); neon(0x4dd2ff, 2, 4.2); neon(0xffd24d, 7, 2.6);
    // street lamps
    const metal = new THREE.MeshStandardMaterial({ color: 0x2f3238, roughness: 0.6, metalness: 0.4 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffe9c0, emissive: 0xffdc9a, emissiveIntensity: 0.32 });
    for (const lx of [-9, 2, 12]) { const poleL = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 10), metal); poleL.position.set(lx, 2.1, -6.9); g.add(poleL); const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), glow); head.position.set(lx, 4.1, -6.4); g.add(head); }
    return g;
  }

  // ---------- 3D poop ----------
  private makePoop(scale = 1): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x5a3c20, roughness: 0.62, clearcoat: 0.28, clearcoatRoughness: 0.5,
      sheen: 0.35, sheenColor: new THREE.Color(0x9c7240), envMapIntensity: 0.45,
    });
    const lobes: [number, number, number, number][] = [
      [0.0, 0.10, 0.0, 0.17], [0.03, 0.28, 0.02, 0.13], [-0.03, 0.42, -0.02, 0.10], [0.02, 0.54, 0.01, 0.07],
    ];
    for (const [x, y, z, r] of lobes) { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mat); s.position.set(x, y, z); s.scale.set(1, 0.85, 1); s.castShadow = true; g.add(s); }
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 12), mat); tip.position.set(0, 0.63, 0); g.add(tip);
    g.scale.setScalar(scale * 0.62);
    return g;
  }

  private rebuildPile() {
    while (this.poopPile.children.length) { const c = this.poopPile.children.pop() as THREE.Mesh; c.traverse?.((o) => { const m = o as any; m.geometry?.dispose?.(); m.material?.dispose?.(); }); }
    const n = Math.min(this.pose.poopCount, 9);
    const pos: [number, number, number][] = [[0, 0.02, 0], [0.22, 0.02, 0.1], [-0.2, 0.02, 0.08], [0.08, 0.02, -0.2], [-0.12, 0.02, -0.18], [0.02, 0.24, 0.0], [0.18, 0.22, -0.1], [-0.16, 0.2, -0.02], [0.0, 0.42, 0.0]];
    for (let i = 0; i < n; i++) { const p = this.makePoop(1); p.position.set(pos[i][0], 0.98 + pos[i][1], pos[i][2]); p.rotation.y = i * 1.7; this.poopPile.add(p); }
  }

  // ---------- fly (same anatomy as before) ----------
  private buildFly(): THREE.Group {
    const bodyMat = () => new THREE.MeshPhysicalMaterial({ color: 0x3a4049, roughness: 0.58, clearcoat: 0.5, clearcoatRoughness: 0.35, sheen: 0.5, sheenColor: new THREE.Color(0x9fc0ff), iridescence: 0.35, iridescenceIOR: 1.3 });
    const eyeTex = makeOmmatidiaTexture(); const wingTex = makeWingTexture();
    const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x59241c, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.06, bumpMap: eyeTex, bumpScale: 0.009, roughnessMap: eyeTex, envMapIntensity: 1.1, iridescence: 0.25, iridescenceIOR: 1.4 });
    const legMat = new THREE.MeshPhysicalMaterial({ color: 0x191c20, roughness: 0.45, clearcoat: 0.4, sheen: 0.3 });
    const bristleMat = new THREE.MeshStandardMaterial({ color: 0x0e1114, roughness: 0.75 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x191d22, roughness: 0.6 });
    const wingMat = new THREE.MeshPhysicalMaterial({ map: wingTex, transparent: true, opacity: 0.5, roughness: 0.1, clearcoat: 0.85, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.0, iridescence: 0.5, iridescenceIOR: 1.5 });
    const dummy = new THREE.Object3D();

    const head = new THREE.Group(); head.position.set(0, 0.06, 0.66);
    this.head = head;
    const headShell = new THREE.Mesh(new THREE.SphereGeometry(0.34, 40, 28), bodyMat()); headShell.scale.set(1.05, 0.92, 0.9); headShell.castShadow = true; head.add(headShell);
    for (const sx of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.30, 48, 32), eyeMat); eye.position.set(sx * 0.26, 0.03, 0.03); eye.scale.set(0.95, 1, 0.78); eye.castShadow = true; head.add(eye); }
    for (const [ox, oy] of [[-0.07, 0.2], [0.07, 0.2], [0, 0.23]]) { const oc = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 10), new THREE.MeshPhysicalMaterial({ color: 0x7a2b22, roughness: 0.1, clearcoat: 1 })); oc.position.set(ox, oy, 0.16); head.add(oc); }
    for (const sx of [-1, 1]) { const a = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.16, 8), legMat); a.position.set(sx * 0.1, 0.02, 0.4); a.rotation.x = Math.PI / 2.4; a.rotation.z = sx * 0.25; head.add(a); const ar = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6), legMat); ar.position.set(sx * 0.12, 0.06, 0.5); ar.rotation.x = Math.PI / 2.2; ar.rotation.z = sx * 0.3; head.add(ar); }
    this.fly.add(head);

    const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.5, 40, 28), bodyMat()); thorax.scale.set(1, 0.95, 1.15); thorax.castShadow = true; this.fly.add(thorax);
    // four dark longitudinal stripes — the signature Musca domestica thorax
    for (const sx of [-0.19, -0.065, 0.065, 0.19]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.02, 0.62), stripeMat); st.position.set(sx, 0.452, 0.0); st.rotation.x = -0.05; this.fly.add(st); }
    const scut = new THREE.Mesh(new THREE.SphereGeometry(0.26, 28, 20), bodyMat()); scut.scale.set(1, 0.7, 0.8); scut.position.set(0, 0.06, -0.42); scut.castShadow = true; this.fly.add(scut);

    this.abdomen = new THREE.Group(); this.abdomen.position.set(0, -0.02, -0.72); this.abdomen.rotation.x = -0.18;
    const abdo = new THREE.Mesh(new THREE.SphereGeometry(0.52, 40, 28), new THREE.MeshPhysicalMaterial({ color: 0x474d55, roughness: 0.55, clearcoat: 0.45, sheen: 0.5, sheenColor: new THREE.Color(0xa8c4ff), iridescence: 0.45, iridescenceIOR: 1.3 }));
    abdo.scale.set(1, 0.98, 1.5); abdo.castShadow = true; this.abdomen.add(abdo);
    for (let i = 0; i < 4; i++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5 - i * 0.07, 0.014, 10, 40), new THREE.MeshStandardMaterial({ color: 0x1c2026, roughness: 0.5 })); ring.rotation.x = Math.PI / 2; ring.rotation.z = Math.PI / 2; ring.position.z = -0.25 + i * 0.26; this.abdomen.add(ring); }
    this.fly.add(this.abdomen);

    // dense bristle hairs (instanced cones) on thorax + abdomen
    const bristles = new THREE.InstancedMesh(new THREE.ConeGeometry(0.006, 0.05, 5), bristleMat, 300);
    for (let i = 0; i < 300; i++) {
      const onThorax = i < 180;
      const u = Math.random() * Math.PI * 2, v = Math.random() * 0.85;
      const ny = Math.sqrt(1 - v * v), rad = v;
      const nx = Math.cos(u) * rad, nz = Math.sin(u) * rad;
      const pos = onThorax
        ? new THREE.Vector3(nx * 0.48, ny * 0.44, nz * 0.55)
        : new THREE.Vector3(nx * 0.5, 0.46 * ny - 0.02, -0.72 + nz * 0.78);
      dummy.position.copy(pos);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, ny, nz).normalize());
      dummy.updateMatrix(); bristles.setMatrixAt(i, dummy.matrix);
    }
    bristles.instanceMatrix.needsUpdate = true;
    this.fly.add(bristles);

    for (const sx of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.position.set(sx * 0.26, 0.34, -0.08);
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(1.78, 0.8), wingMat); wing.position.set(sx * 0.88, 0, 0); wing.rotation.x = -Math.PI / 2; pivot.add(wing);
      pivot.rotation.z = sx * 0.28; pivot.userData.sx = sx; this.fly.add(pivot); this.wings.push(pivot);
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 6), legMat); stalk.position.set(sx * 0.16, 0.2, -0.4); stalk.rotation.x = 1.1; stalk.rotation.z = sx * 0.5; this.fly.add(stalk);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), legMat); knob.position.set(sx * 0.24, 0.14, -0.5); this.fly.add(knob);
    }

    const legDefs: [number, number, number, number][] = [
      [-0.34, -0.08, 0.3, -0.5], [0.34, -0.08, 0.3, -0.5], [-0.4, -0.12, -0.05, 0], [0.4, -0.12, -0.05, 0], [-0.36, -0.08, -0.45, 0.6], [0.36, -0.08, -0.45, 0.6],
    ];
    for (const [x, y, z, spread] of legDefs) {
      const leg = new THREE.Group(); leg.position.set(x, y, z); const sx = Math.sign(x);
      const femur = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.024, 0.42, 10), legMat); femur.position.set(sx * 0.16, -0.1, 0); femur.rotation.z = sx * 1.05; femur.rotation.x = spread * 0.4; leg.add(femur);
      const knee = new THREE.Group(); knee.position.set(sx * 0.32, -0.2, 0);
      const tibia = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.016, 0.44, 10), legMat); tibia.position.set(sx * 0.05, -0.2, 0); tibia.rotation.z = sx * 0.15; knee.add(tibia);
      const tarsus = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.008, 0.3, 8), legMat); tarsus.position.set(sx * 0.03, -0.52, 0.06); tarsus.rotation.x = -0.4; knee.add(tarsus);
      for (const ca of [-0.02, 0.02]) { const claw = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.045, 6), legMat); claw.position.set(sx * 0.03 + ca, -0.67, 0.1); claw.rotation.x = -1.9; knee.add(claw); }
      leg.add(knee); this.fly.add(leg); this.legs.push(leg);
    }

    // perch the fly on the seat (feet ~ local y = -0.9)
    const scale = 0.74;
    this.fly.scale.setScalar(scale);
    this.fly.position.set(0, SEAT_Y + 0.9 * scale, 0.06);
    this.fly.add(this.buildPhone());
    return this.fly;
  }

  // a 3D smartphone the fly holds (and looks at) while it poops / listens to music
  private buildPhone(): THREE.Group {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.70, 0.035), new THREE.MeshPhysicalMaterial({ color: 0x0e1114, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.25 }));
    g.add(frame);
    const c = document.createElement("canvas"); c.width = 140; c.height = 250; this.phoneCanvas = c;
    this.phoneTex = new THREE.CanvasTexture(c); this.phoneTex.colorSpace = THREE.SRGBColorSpace;
    // screen faces the phone's local +Z; the phone is rotated so +Z points at the fly
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.64), new THREE.MeshBasicMaterial({ map: this.phoneTex, color: 0x6d7885 }));
    screen.position.z = 0.019; g.add(screen);
    const punch = new THREE.Mesh(new THREE.CircleGeometry(0.012, 12), new THREE.MeshBasicMaterial({ color: 0x05070a }));
    punch.position.set(0, 0.30, 0.02); g.add(punch);
    // rear camera module on the back (the side facing the viewer)
    const bump = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.02), new THREE.MeshPhysicalMaterial({ color: 0x14181c, roughness: 0.3, clearcoat: 0.6 }));
    bump.position.set(-0.09, 0.28, -0.026); g.add(bump);
    for (const [lx, ly] of [[-0.12, 0.31], [-0.06, 0.31], [-0.09, 0.25]]) {
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.018, 14), new THREE.MeshPhysicalMaterial({ color: 0x05070a, roughness: 0.1, clearcoat: 1 }));
      l.rotation.y = Math.PI; l.position.set(lx, ly, -0.037); g.add(l);
    }
    // screen glow lights the fly's face (kept dim so it never blinds the view)
    this.phoneLight = new THREE.PointLight(0x9fd0ff, 0, 1.5, 2);
    this.phoneLight.position.set(0, 0.05, 0.16);
    g.add(this.phoneLight);

    g.position.set(0, -0.22, 1.24);   // held out lower, clear of the face
    g.rotation.x = -2.58;             // screen still faces the fly
    g.scale.setScalar(0.78);          // smaller so it does not fill the view
    g.visible = false;
    this.phone = g;
    return g;
  }

  private drawPhone(song: string | null, t: number) {
    const c = this.phoneCanvas; if (!c) return;
    const x = c.getContext("2d")!;
    x.fillStyle = "#0a0d12"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#182230"; x.fillRect(0, 0, c.width, 40);
    x.fillStyle = "#8fd0ff"; x.font = "bold 15px monospace"; x.fillText("PoopFly", 9, 26);
    x.fillStyle = "#e6edf6"; x.font = "bold 19px monospace";
    x.fillText(song ? "Song " + song : "no music", 10, 78);
    x.fillStyle = "#7f8ca0"; x.font = "11px monospace"; x.fillText("toilet break", 10, 98);
    // animated equalizer
    for (let i = 0; i < 10; i++) {
      const h = 18 + Math.abs(Math.sin(t * 3 + i * 0.6)) * 64;
      x.fillStyle = i % 2 ? "#c084fc" : "#8fd0ff";
      x.fillRect(12 + i * 12.6, 226 - h, 9, h);
    }
    x.fillStyle = "#3a4552"; x.fillRect(20, 236, 100, 5);
    this.phoneTex.needsUpdate = true;
  }

  setPose(p: StagePose) {
    const changed = p.poopCount !== this.pose.poopCount;
    this.pose = p;
    if (changed) this.rebuildPile();
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const t = this.clock.getElapsedTime(); const p = this.pose;
      const flapHz = p.defecating ? 9 : p.desperate ? 26 : 18, amp = p.defecating ? 0.28 : 0.6;
      for (const w of this.wings) { const sx = w.userData.sx as number; w.rotation.x = Math.sin(t * flapHz * Math.PI * 2) * amp * 0.5; w.rotation.z = sx * (0.28 + Math.abs(Math.sin(t * flapHz * Math.PI * 2)) * 0.12); }
      const baseY = SEAT_Y + 0.9 * 0.74;
      this.fly.position.y = baseY + Math.sin(t * (p.defecating ? 6 : 3)) * 0.02;
      const pulse = p.defecating ? 1 + Math.sin(t * 7) * 0.06 : 1 + Math.sin(t * 2) * 0.015;
      this.abdomen.scale.set(pulse, pulse, 1 + (p.defecating ? Math.sin(t * 7) * 0.03 : 0));
      this.abdomen.rotation.x = -0.18 + (p.defecating ? 0.12 : 0);
      const wantHold = p.defecating || !!p.music;
      // smooth 0..1 hold state so the phone/legs/head never pop or snap
      this.holdT += ((wantHold ? 1 : 0) - this.holdT) * 0.08;
      const h = this.holdT;
      // front pair of legs grips the phone (lerped); the rest tense when straining
      this.legs.forEach((leg, i) => {
        if (i < 2) {
          const tx = (-0.85 * h) + (1 - h) * (p.defecating ? 0.18 : 0) + Math.sin(t * 3 + i) * 0.04 * h;
          const tz = (i === 0 ? 1 : -1) * 0.22 * h;
          leg.rotation.x += (tx - leg.rotation.x) * 0.18;
          leg.rotation.z += (tz - leg.rotation.z) * 0.18;
        } else {
          leg.rotation.x = (p.defecating ? 0.18 : 0) + Math.sin(t * 2 + i) * 0.02;
          leg.rotation.z *= 0.9;
        }
      });
      // head tilts down toward the screen, following the same smoothed hold
      this.head.rotation.x += (0.84 * h - this.head.rotation.x) * 0.12;
      // phone grows + slides in from the fly, and shrinks away again on release
      this.phone.visible = h > 0.02;
      this.phone.scale.setScalar(0.98 * (0.55 + 0.45 * h));
      this.phone.position.z = 1.24 - (1 - h) * 0.2;
      this.phoneLight.intensity += ((h > 0.05 ? 0.35 : 0) - this.phoneLight.intensity) * 0.15;
      if (this.phone.visible) this.drawPhone(p.music, t);
      if (p.desperate) { this.fly.rotation.z = Math.sin(t * 40) * 0.015; this.fly.rotation.x = Math.sin(t * 33) * 0.01; } else { this.fly.rotation.z *= 0.9; this.fly.rotation.x *= 0.9; }
      this.fly.rotation.y = p.music ? Math.sin(t * 2.5) * 0.06 : this.fly.rotation.y * 0.9;
      this.controls.update();

      // falling poop while defecating
      if (p.defecating) {
        if (!this.fallingPoop) { this.fallingPoop = this.makePoop(0.7); this.scene.add(this.fallingPoop); this.dropPhase = 0; }
        this.dropPhase = (this.dropPhase + 1 / 60) % 0.8;
        const k = this.dropPhase / 0.8;
        this.fallingPoop.position.set(0, SEAT_Y - k * 0.32, 0.02);
        this.fallingPoop.visible = true; this.fallingPoop.rotation.x += 0.12;
      } else if (this.fallingPoop) { this.fallingPoop.visible = false; }

      this.composer.render();
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize); this.ro?.disconnect();
    const el = this.renderer.domElement; if (el.parentElement) el.parentElement.removeChild(el);
    this.disposeObject(this.scene);
    (this.scene.background as THREE.Texture | null)?.dispose?.();
    (this.scene.environment as THREE.Texture | null)?.dispose?.();
    this.composer?.dispose();
    this.controls?.dispose();
    this.renderer.dispose();
  }
}
