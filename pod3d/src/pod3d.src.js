// Live 3D for the Set Up Pod table. The models are built and baked in Blender
// (pod3d/blender/make_pod.py -> pod-table.glb, pod-spire.glb, pod-crest.glb);
// this draws them with three.js so thrones can slide, swivel and re-space at
// any seat count, the table can turn to any seat, and every orb can change
// state without a pre-rendered frame for each combination.
//
// Bundled with esbuild into pod3d.js (see pod3d/README.md). app.js loads it
// lazily on the first visit to the pod tab and falls back to the CSS table if
// WebGL, the models, or the load itself fail.

import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Points, PlaneGeometry, SphereGeometry,
  BufferGeometry, Float32BufferAttribute, ShaderMaterial, MeshBasicMaterial, CanvasTexture,
  SRGBColorSpace, AdditiveBlending, Color, Vector3, DirectionalLight, HemisphereLight, PointLight, Quaternion,
  PMREMGenerator, ACESFilmicToneMapping, Raycaster, Vector2, BackSide, DoubleSide,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const TABLE_R = 2.4;
const SEAT_R = 3.3;       // table centre to a throne
const TUCKED_R = 2.0;     // under the table's edge: where thrones slide from/to
const ORB_Y = 1.55;       // orb height over the floor, level with the throne's arch
const SIGIL_K = (TABLE_R * 2) / 100; // world units per sigil unit (table radius = 50)
const GROOVE_R = 27, NODE_R = 22;

// ---- easing ----

function bezier(x1, y1, x2, y2) {
  const bx = s => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = s => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  return t => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0, hi = 1, s = t;
    for (let i = 0; i < 24; i++) {
      const x = bx(s);
      if (Math.abs(x - t) < 1e-5) break;
      if (x < t) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return by(s);
  };
}
// The same curves the CSS table used, so the 3D one moves like it did.
const EASE_SPIN = bezier(0.32, 0.72, 0, 1);
const EASE_SLIDE = bezier(0.23, 1, 0.32, 1);
const EASE_ARC = bezier(0.77, 0, 0.175, 1);
const EASE_OUT_ACCEL = bezier(0.5, 0, 0.75, 1);
const EASE_LINEAR = t => t;

class Tween {
  constructor(v) { this.v = v; this.a = v; this.b = v; this.t0 = 0; this.d = 0; this.ease = EASE_LINEAR; this.on = false; }
  to(b, d, ease, now) {
    if (!d) { this.v = this.a = this.b = b; this.on = false; return; }
    this.a = this.v; this.b = b; this.t0 = now; this.d = d; this.ease = ease; this.on = true;
  }
  step(now) {
    if (!this.on) return false;
    const k = Math.min(1, (now - this.t0) / this.d);
    this.v = this.a + (this.b - this.a) * this.ease(k);
    if (k >= 1) { this.on = false; this.v = this.b; }
    return true;
  }
}

// ---- spellfire palettes (the CSS orb's per-state fire) ----

// Each state has a personality as well as a palette: how big and how
// restless the fire is (size, speed, turb), how much it flickers and breathes,
// how hard it lights the room (lightK), and how often it "glances up"
// (surge: a min/max gap in seconds).
const FIRE = {
  waiting: { e1: "#4a2bd0", c1: "#a48bff", e2: "#7b5cff", c2: "#d9ccff", c3: "#efe8ff", ember: "#c9b6ff", halo: "#8e6bff",
    size: 0.62, speed: 0.8, turb: 0.9, flick: 0.28, breath: 0.12, glow: 0.4, lightK: 0.55, embers: 0, heat: 0.6, energy: 0.55, surge: [3, 6] },
  sealed: { e1: "#5a2ee0", c1: "#e7a8ff", e2: "#b86bff", c2: "#ffe1a0", c3: "#fff2c8", ember: "#ffd27a", halo: "#b06eff",
    size: 1, speed: 1, turb: 0.75, flick: 0.1, breath: 0.05, glow: 0.75, lightK: 1, embers: 1, heat: 1, energy: 0.9, surge: [6, 12] },
  flagged: { e1: "#a3140a", c1: "#ff6a2a", e2: "#ff4a12", c2: "#ffc061", c3: "#fff0b0", ember: "#ffb347", halo: "#ff5028",
    size: 1.05, speed: 1.9, turb: 1.7, flick: 0.34, breath: 0.03, glow: 0.9, lightK: 1.2, embers: 1, heat: 1.9, energy: 1.1, surge: [1.5, 3] },
  revealed: { size: 1.12, speed: 1.1, turb: 1, flick: 0.1, breath: 0.06, glow: 0.9, lightK: 1.35, embers: 1, heat: 1.1, energy: 1, surge: [5, 9] },
};
const LIFE_KEYS = ["size", "speed", "embers", "glow", "crack", "turb", "flick", "breath", "lightK", "heat", "energy"];
const LIGHT_BASE = 2.2;   // candela of a calm sealed orb's light
const _cw = new Vector3(), _l = new Vector3(), _q = new Quaternion();
const GEM = { waiting: "#b59cff", sealed: "#ffe6a6", revealed: "#ffe6a6", flagged: "#ff8a5c" };

// ---- shaders ----

const BILLBOARD_VERT = /* glsl */`
  uniform vec2 uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    gl_Position = projectionMatrix * mv;
  }`;

const NOISE = /* glsl */`
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
  }`;

// Anchored at the bottom centre so a flame grows up out of its root as it swells.
const BASE_VERT = /* glsl */`
  uniform vec2 uSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += vec2(position.x * uSize.x, (position.y + 0.5) * uSize.y);
    gl_Position = projectionMatrix * mv;
  }`;

const FLAME_FRAG = /* glsl */`
  uniform float uTime, uSpeed, uAlpha, uFlick, uTurb, uLean, uSeed, uInner;
  uniform vec3 uE1, uC1, uC2, uC3;
  varying vec2 vUv;
  ${NOISE}
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return s;
  }
  // A flame grown from rising, scrolling turbulence: it bends more toward the
  // tip, tears off raggedly at the top, and is hottest at its root.
  void main() {
    vec2 p = vec2((vUv.x - 0.5) * 2.0, vUv.y);
    float t = uTime * uSpeed + uSeed * 13.0;
    float h = p.y;
    p.x -= uLean * h * h * 0.55 + sin(t * 1.1) * 0.05 * h * h;
    vec2 q = vec2(p.x * 1.5 + uSeed * 4.0, h * 1.3 - t * 1.15);
    float w1 = fbm(q);
    float w2 = fbm(q * 1.9 + vec2(4.1, -t * 0.8));
    p.x += (w1 - 0.5) * uTurb * h * 1.25 + (w2 - 0.5) * uTurb * 0.4 * h * h;
    float width = mix(0.9, 0.05, pow(h, 0.7)) * (1.0 - uInner * 0.45) * (0.8 + 0.35 * w1);
    float d = abs(p.x) / max(width, 0.02);
    float body = smoothstep(1.0, 0.2, d);
    float top = 1.0 - smoothstep(0.55, 1.02, h + (w2 - 0.5) * 0.5 + (1.0 - uFlick) * 0.35);
    body *= top * smoothstep(0.0, 0.05, h);
    float heat = clamp((1.0 - d) * (1.0 - h * 0.85) + (w1 - 0.5) * 0.35 + uInner * 0.25, 0.0, 1.0);
    vec3 col = mix(uE1, uC1, smoothstep(0.0, 0.5, heat));
    col = mix(col, uC2, smoothstep(0.45, 0.85, heat));
    col = mix(col, uC3, smoothstep(0.8, 1.0, heat));
    float a = body * (0.5 + 1.1 * heat) * uFlick;
    gl_FragColor = vec4(col * (0.75 + 0.7 * heat), clamp(a, 0.0, 1.0) * uAlpha);
    #include <colorspace_fragment>
  }`;

// The living thing inside the glass: swirling plasma that churns slowly,
// brighter toward the middle where you look straight through it.
const PLASMA_VERT = /* glsl */`
  varying vec3 vP, vN, vV;
  void main() {
    vP = normalize(position);
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const PLASMA_FRAG = /* glsl */`
  uniform float uTime, uAlpha, uEnergy;
  uniform vec3 uE1, uC1, uC2, uC3;
  varying vec3 vP, vN, vV;
  float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float vn3(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    vec3 p = vP * 1.8;
    float ang = uTime * 0.45 + p.y * 1.4;
    float cs = cos(ang), sn = sin(ang);
    p.xz = mat2(cs, -sn, sn, cs) * p.xz;
    float n1 = vn3(p * 1.3 + vec3(0.0, -uTime * 0.5, 0.0));
    float n2 = vn3(p * 2.9 + vec3(3.0, uTime * 0.4, -uTime * 0.3));
    float plasma = n1 * 0.65 + n2 * 0.35;
    float e = pow(clamp(plasma * 1.45, 0.0, 1.0), 1.9) * (0.3 + 0.7 * facing) * uEnergy;
    vec3 col = mix(uE1, uC1, smoothstep(0.1, 0.6, e));
    col = mix(col, uC2, smoothstep(0.55, 0.95, e));
    col = mix(col, uC3, smoothstep(1.0, 1.4, e * 1.1));
    gl_FragColor = vec4(col * (0.5 + 0.7 * e), (0.16 + e * 0.6) * uAlpha);
    #include <colorspace_fragment>
  }`;

const GLOW_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.4) * uAlpha;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

const RING_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha, uR;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float a = smoothstep(0.12, 0.0, abs(r - uR)) * uAlpha;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

const TEX_FRAG = /* glsl */`
  uniform sampler2D uTex; uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D(uTex, vUv);
    gl_FragColor = vec4(t.rgb, t.a * uAlpha);
    #include <colorspace_fragment>
  }`;

const GLASS_VERT = /* glsl */`
  varying vec3 vN, vV;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const GLASS_FRAG = /* glsl */`
  uniform vec3 uHalo; uniform float uAlpha;
  varying vec3 vN, vV;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);
    float gloss = smoothstep(0.9, 1.0, dot(normalize(vN), normalize(vec3(-0.4, 0.65, 0.65))));
    vec3 col = uHalo * f * 1.5 + vec3(1.0) * gloss * 0.9;
    gl_FragColor = vec4(col, clamp(f * 0.85 + gloss + 0.06, 0.0, 1.0) * uAlpha);
    #include <colorspace_fragment>
  }`;

// Embers and sparks lift off the orb on curling paths that widen as they
// rise. Sparks (the quicker, tinier ones) burn hotter and fly faster when the
// fire is agitated (uHeat).
const EMBER_VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime, uPx, uAlpha, uHeat;
  varying float vA, vKind;
  void main() {
    float kind = step(0.68, aSeed);
    float sp = mix(0.26, 0.5, kind) * (0.7 + 0.3 * uHeat);
    float ph = fract(uTime * sp * (0.7 + aSeed * 0.6) + aSeed * 3.7);
    float rise = ph * (0.5 + 0.35 * kind) * (0.8 + 0.2 * uHeat);
    float curl = sin(ph * 7.0 + aSeed * 30.0 + uTime * 0.6) * 0.06 * (0.4 + ph);
    float curl2 = cos(ph * 5.0 + aSeed * 17.0) * 0.04 * ph;
    vec3 p = vec3((aSeed - 0.5) * 0.3 + curl, 0.2 + rise, curl2);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = max(1.0, uPx * (1.0 - ph * 0.75) * mix(1.0, 0.5, kind) * (0.6 + aSeed) / -mv.z);
    vA = sin(ph * 3.14159) * mix(0.9, 1.4, kind) * uAlpha;
    vKind = kind;
  }`;
const EMBER_FRAG = /* glsl */`
  uniform vec3 uColor, uHot; varying float vA, vKind;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(mix(uColor, uHot, vKind), smoothstep(0.5, 0.0, d) * vA);
    #include <colorspace_fragment>
  }`;

const WELL_FRAG = /* glsl */`
  uniform vec3 uA, uB; uniform float uTime;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    vec2 p = vUv - 0.5; float r = length(p) * 2.0;
    float a = atan(p.y, p.x);
    float sw = vn(vec2(a * 1.6 + uTime * 0.25, r * 3.0 - uTime * 0.35));
    vec3 col = mix(uB, uA, smoothstep(0.9, 0.0, r) * (0.65 + 0.5 * sw));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

// ---- small helpers ----

const col3 = hex => new Color(hex);
function canvasTex(w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; t.anisotropy = 4;
  return { c, ctx: c.getContext("2d"), tex: t };
}

function billboard(frag, uniforms, w, h, order) {
  const m = new Mesh(new PlaneGeometry(1, 1), new ShaderMaterial({
    vertexShader: BILLBOARD_VERT, fragmentShader: frag, transparent: true, depthWrite: false, depthTest: false,
    blending: AdditiveBlending, toneMapped: false,
    uniforms: { uSize: { value: new Vector2(w, h) }, ...uniforms },
  }));
  m.renderOrder = order; m.frustumCulled = false;
  return m;
}

function crackTexture() {
  const { c, ctx, tex } = canvasTex(128, 128);
  ctx.scale(128 / 40, 128 / 40);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,230,200,.85)"; ctx.lineWidth = 1.3;
  ctx.beginPath(); [[15, 2], [19, 12], [13, 18], [21, 25], [17, 38]].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(19, 12); ctx.lineTo(27, 14); ctx.stroke();
  ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(21, 25); ctx.lineTo(28, 29); ctx.stroke();
  tex.needsUpdate = true;
  return tex;
}

// ---- the module ----

export async function createPod3D({ host, base, suffix = "", adaptiveQuality = false, reducedMotion, fontFamily, onPick, onMove, onFail }) {
  // a boolean, or a function so a changed OS setting is honoured live
  const isReduced = () => (typeof reducedMotion === "function" ? reducedMotion() : !!reducedMotion);
  const loader = new GLTFLoader();
  const load = name => new Promise((res, rej) => loader.load(`${base}/${name}${suffix}`, res, undefined, rej));
  const [tableGltf, spireGltf, crestGltf] = await Promise.all([load("pod-table.glb"), load("pod-spire.glb"), load("pod-crest.glb")]);

  const canvas = document.createElement("canvas");
  canvas.className = "pod-gl";
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  host.insertBefore(canvas, host.firstChild);

  const scene = new Scene();
  const camera = new PerspectiveCamera(26, 1.24, 0.5, 60);
  const EL = (41 * Math.PI) / 180;
  const THRONE_K = 1.2;                    // thrones read small next to the table at 1:1
  const LOOK_Y = 1.05;

  // Soft studio-style lighting: a procedural environment for the gold and
  // the wood, one warm key, and a little fill. No shadow maps (phones).
  {
    const env = new Scene();
    const sky = new Mesh(new SphereGeometry(20, 24, 16), new ShaderMaterial({
      side: BackSide, depthWrite: false,
      uniforms: {},
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
      fragmentShader: `varying vec3 vP; void main(){
        float h = vP.y;
        vec3 top = vec3(0.34,0.28,0.52), mid = vec3(0.55,0.42,0.3), low = vec3(0.05,0.04,0.07);
        vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.7)) : mix(mid, low, pow(-h, 0.5));
        float key = smoothstep(0.82, 0.96, dot(vP, normalize(vec3(-0.5, 0.75, 0.45))));
        c += vec3(1.0, 0.82, 0.58) * key * 2.2;
        gl_FragColor = vec4(c, 1.0); }`,
    }));
    env.add(sky);
    const pm = new PMREMGenerator(renderer);
    scene.environment = pm.fromScene(env, 0.02).texture;
    pm.dispose(); sky.geometry.dispose(); sky.material.dispose();
  }
  scene.environmentIntensity = 0.9;
  const key = new DirectionalLight(0xffe2b8, 1.6); key.position.set(-4, 7, 5); scene.add(key);
  scene.add(new HemisphereLight(0x9a86e8, 0x2a1a10, 0.5));
  // Each lit orb lights its throne, the gold and the table with its own flickering
  // light. A fixed pool (a constant light count never recompiles shaders as
  // seats come and go); unused ones sit at zero.
  const lightPool = Array.from({ length: 8 }, () => {
    const l = new PointLight(0xffffff, 0, 3.4, 2); l.userData.used = false; scene.add(l); return l;
  });

  const root = new Group(); scene.add(root);
  const rig = new Group(); root.add(rig);   // turns with the table

  // The floor: a faint summoning circle and a soft shadow, drawn once.
  {
    const { c, ctx, tex } = canvasTex(1024, 1024);
    const k = 1024 / 100;
    ctx.translate(512, 512); ctx.strokeStyle = "rgba(181,156,255,.34)"; ctx.lineWidth = 0.55 * k;
    for (const r of [48, 40]) { ctx.beginPath(); ctx.arc(0, 0, r * k, 0, 6.2832); ctx.stroke(); }
    ctx.setLineDash([0.8 * k, 2.2 * k]); ctx.beginPath(); ctx.arc(0, 0, 45 * k, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < 12; i++) {
      const t = (i * Math.PI) / 6; ctx.beginPath();
      ctx.moveTo(45 * k * Math.sin(t), 45 * k * Math.cos(t)); ctx.lineTo(48 * k * Math.sin(t), 48 * k * Math.cos(t)); ctx.stroke();
    }
    tex.needsUpdate = true;
    const floorR = TABLE_R * 1.79;
    const floor = new Mesh(new PlaneGeometry(floorR * 2, floorR * 2), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.002; floor.renderOrder = -3; root.add(floor);
    const sh = canvasTex(256, 256);
    const g = sh.ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, "rgba(0,0,0,.55)"); g.addColorStop(0.6, "rgba(0,0,0,0)"); sh.ctx.fillStyle = g; sh.ctx.fillRect(0, 0, 256, 256); sh.tex.needsUpdate = true;
    const shadow = new Mesh(new PlaneGeometry(TABLE_R * 3.1, TABLE_R * 3.1), new MeshBasicMaterial({ map: sh.tex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.004; shadow.renderOrder = -2; root.add(shadow);
  }

  // The table.
  const table = tableGltf.scene; rig.add(table);
  const wellMat = new ShaderMaterial({
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
    fragmentShader: WELL_FRAG, toneMapped: false,
    uniforms: { uA: { value: col3("#c4b0ff") }, uB: { value: col3("#281640") }, uTime: { value: 0 } },
  });
  table.traverse(o => {
    if (!o.isMesh) return;
    if (/well/i.test(o.name)) {
      // cap UVs are not guaranteed radial; derive them from position instead
      const p = o.geometry.attributes.position, uv = new Float32Array(p.count * 2);
      let m = 0; for (let i = 0; i < p.count; i++) m = Math.max(m, Math.hypot(p.getX(i), p.getZ(i)));
      for (let i = 0; i < p.count; i++) { uv[2 * i] = 0.5 + 0.5 * p.getX(i) / m; uv[2 * i + 1] = 0.5 + 0.5 * p.getZ(i) / m; }
      o.geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
      o.material = wellMat;
    }
    if (o.material && o.material.map) o.material.map.anisotropy = 8;
  });
  const wellColors = { violet: [col3("#c4b0ff"), col3("#281640")], gold: [col3("#ffeaa8"), col3("#46300f")] };
  const wellT = { k: 0, to: 0 };

  // Sigil (on the table, turns with it) and the count in the well (world-fixed, upright).
  const sig = canvasTex(1024, 1024);
  const sigil = new Mesh(new PlaneGeometry(TABLE_R * 2, TABLE_R * 2), new MeshBasicMaterial({ map: sig.tex, transparent: true, depthWrite: false, toneMapped: false }));
  sigil.rotation.x = -Math.PI / 2; sigil.position.y = 1.014; sigil.renderOrder = 1; rig.add(sigil);
  const lab = canvasTex(256, 160);
  const label = new Mesh(new PlaneGeometry(0.98, 0.61), new MeshBasicMaterial({ map: lab.tex, transparent: true, depthWrite: false, toneMapped: false }));
  label.rotation.x = -Math.PI / 2; label.position.y = 1.03; label.renderOrder = 2; root.add(label);

  let sigilModel = { seats: [], ready: false, count: "0", word: "Seats" };
  function drawSigil() {
    const { ctx } = sig, k = 1024 / 100, m = sigilModel, n = m.seats.length;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 1024, 1024); ctx.translate(512, 512);
    ctx.lineCap = "round";
    const glow = m.ready ? "rgba(255,211,107,.85)" : "rgba(130,100,255,.9)";
    ctx.shadowColor = glow; ctx.shadowBlur = 10;
    const segCol = s => (s === "flagged" ? "#ff6b4a" : s === "waiting" ? "#b9a4ff" : "#ffd36b");
    const pt = (r, deg) => [-r * k * Math.sin((deg * Math.PI) / 180), r * k * Math.cos((deg * Math.PI) / 180)];
    const ang = deg => ((deg + 90) * Math.PI) / 180;
    ctx.lineWidth = 1.8 * k;
    if (n === 0) {
      ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.setLineDash([1.5 * k, 3 * k]);
      ctx.beginPath(); ctx.arc(0, 0, GROOVE_R * k, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
    } else if (n === 1) {
      ctx.strokeStyle = segCol(m.seats[0].state); ctx.beginPath(); ctx.arc(0, 0, GROOVE_R * k, 0, 6.2832); ctx.stroke();
    } else {
      const step = 360 / n, gap = 8;
      m.seats.forEach((s, i) => {
        const c = (i * 360) / n;
        ctx.strokeStyle = segCol(s.state); ctx.beginPath();
        ctx.arc(0, 0, GROOVE_R * k, ang(c - step / 2 + gap / 2), ang(c + step / 2 - gap / 2)); ctx.stroke();
      });
      const skips = n <= 3 ? [1] : n === 4 ? [1, 2] : n <= 6 ? [2] : [3];
      const drawn = new Set(); ctx.lineWidth = 0.9 * k; ctx.strokeStyle = m.ready ? "#ffd36b" : "#d8caff";
      for (const sk of skips) for (let i = 0; i < n; i++) {
        const j = (i + sk) % n, key = `${Math.min(i, j)}-${Math.max(i, j)}`;
        if (drawn.has(key)) continue; drawn.add(key);
        const [x1, y1] = pt(NODE_R, (i * 360) / n), [x2, y2] = pt(NODE_R, (j * 360) / n);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    ctx.shadowBlur = 0; ctx.lineWidth = 0.9 * k;
    m.seats.forEach((s, i) => {
      const [x, y] = pt(NODE_R, (i * 360) / (n || 1));
      const bad = s.state === "flagged", on = s.state !== "waiting" && !bad;
      ctx.fillStyle = bad ? "#ff5a2a" : on ? "#ffd36b" : "#2f1d13";
      ctx.strokeStyle = bad ? "#ffc2a8" : on ? "#fff1c4" : "#d8caff";
      ctx.beginPath(); ctx.arc(x, y, 2.2 * k, 0, 6.2832); ctx.fill(); ctx.stroke();
    });
    sig.tex.needsUpdate = true;
    const l = lab.ctx; l.clearRect(0, 0, 256, 160); l.textAlign = "center";
    l.shadowColor = "rgba(40,20,80,.95)"; l.shadowBlur = 8;
    l.fillStyle = "#fbf6ff"; l.font = `700 70px ${fontFamily}`; l.textBaseline = "alphabetic";
    l.fillText(m.count, 128, 92);
    l.fillStyle = m.ready ? "#ffe6a6" : "rgba(251,246,255,.8)"; l.font = `600 24px ${fontFamily}`;
    if ("letterSpacing" in l) l.letterSpacing = "3px";
    l.fillText(m.word.toUpperCase(), 128, 126);
    lab.tex.needsUpdate = true;
  }
  drawSigil();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawSigil(); dirty = true; });

  // ---- seats ----

  const seats = new Map();
  const crackTex = crackTexture();
  const emberSeeds = Float32Array.from({ length: 9 }, (_, i) => (i + 0.5) / 9 + (Math.sin(i * 12.9898) * 0.04));
  let T = 0, dirty = true, pxPerUnit = 400;
  // Adaptive quality: if the first couple of seconds of animation run slowly (an
  // older phone, a throttled battery-saver GPU), render at a lower pixel ratio
  // once rather than stutter for good.
  let quality = 1; const frameTimes = []; let qualityChecked = !adaptiveQuality;
  let focusId = null;

  function buildSeat(id, crest) {
    const src = (crest ? crestGltf : spireGltf).scene;
    const pivot = new Group(), carrier = new Group(), inner = src.clone(true);
    const mats = [];
    let gemMat = null;
    inner.traverse(o => {
      if (!o.isMesh) return;
      o.material = o.material.clone(); mats.push(o.material);
      if (/gem/i.test(o.name)) gemMat = o.material;
    });
    const mount = new Group(); mount.rotation.y = Math.PI; mount.add(inner);   // back to the outside
    carrier.scale.setScalar(THRONE_K); carrier.add(mount); pivot.add(carrier); rig.add(pivot);

    // soft contact shadow under the throne
    const sh = new Mesh(new PlaneGeometry(1.5, 1.5), new MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.006; sh.renderOrder = -1; carrier.add(sh);

    // the orb
    const orb = new Group(); orb.position.y = ORB_Y; carrier.add(orb);
    const U = {
      time: { value: 0 }, speed: { value: 1 }, alpha: { value: 1 },
      e1: { value: new Color() }, c1: { value: new Color() }, e2: { value: new Color() }, c2: { value: new Color() }, c3: { value: new Color() },
    };
    const halo = new Color(), emberC = new Color();
    const glow = billboard(GLOW_FRAG, { uColor: { value: halo }, uAlpha: { value: 0.6 } }, 1.5, 1.5, 10);
    orb.add(glow);
    // two flames rooted in the orb: a wide ragged outer one and a narrow white-hot one
    const flameU = inner => ({
      uTime: U.time, uSpeed: U.speed, uAlpha: { value: 1 }, uFlick: { value: 1 }, uTurb: { value: 1 }, uLean: { value: 0 },
      uSeed: { value: inner ? 0.37 : 0.0 }, uInner: { value: inner }, uE1: inner ? U.c1 : U.e1, uC1: inner ? U.c2 : U.c1, uC2: inner ? U.c3 : U.c2, uC3: U.c3,
    });
    const mkFlame = (inner, order) => {
      const m = billboard(FLAME_FRAG, flameU(inner), 0.6, 0.8, order);
      m.material.vertexShader = BASE_VERT; m.material.needsUpdate = true;
      m.position.y = 0.04; return m;
    };
    const flame = mkFlame(0, 12), flameIn = mkFlame(1, 13);
    const flameWrap = new Group(); flameWrap.add(flame, flameIn); orb.add(flameWrap);
    const plasma = new Mesh(new SphereGeometry(0.235, 28, 18), new ShaderMaterial({
      vertexShader: PLASMA_VERT, fragmentShader: PLASMA_FRAG, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false,
      uniforms: { uTime: U.time, uAlpha: { value: 1 }, uEnergy: { value: 1 }, uE1: U.e1, uC1: U.c1, uC2: U.c2, uC3: U.c3 },
    }));
    plasma.renderOrder = 11.5; orb.add(plasma);
    const glass = new Mesh(new SphereGeometry(0.26, 28, 18), new ShaderMaterial({
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false,
      uniforms: { uHalo: { value: halo }, uAlpha: { value: 1 } },
    }));
    glass.renderOrder = 14; orb.add(glass);
    // a generous, invisible tap target: the orb is only ~15px across on a phone
    const pick = new Mesh(new SphereGeometry(0.6, 8, 6), new MeshBasicMaterial({ visible: false }));
    pick.userData.seatId = id; orb.add(pick);
    const crack = billboard(TEX_FRAG, { uTex: { value: crackTex }, uAlpha: { value: 0 } }, 0.41, 0.41, 15);
    crack.material.blending = 1; // NormalBlending
    orb.add(crack);
    const ring = billboard(RING_FRAG, { uColor: { value: halo }, uAlpha: { value: 0 }, uR: { value: 0.3 } }, 1.5, 1.5, 11);
    orb.add(ring);
    const eg = new BufferGeometry();
    eg.setAttribute("position", new Float32BufferAttribute(new Float32Array(emberSeeds.length * 3), 3));
    eg.setAttribute("aSeed", new Float32BufferAttribute(emberSeeds, 1));
    const hotC = new Color();
    const embers = new Points(eg, new ShaderMaterial({
      vertexShader: EMBER_VERT, fragmentShader: EMBER_FRAG, transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false,
      uniforms: { uTime: U.time, uPx: { value: 0.07 * pxPerUnit }, uAlpha: { value: 0 }, uHeat: { value: 1 }, uColor: { value: emberC }, uHot: { value: hotC } },
    }));
    embers.frustumCulled = false; embers.renderOrder = 16; orb.add(embers);
    const light = lightPool.find(l => !l.userData.used) || null;
    if (light) light.userData.used = true;

    const s = {
      id, crest, pick, pivot, carrier, mount, orb, mats, gemMat, U, halo, emberC, hotC, flame, flameIn, plasma, light, glow, glass, crack, ring, embers, flameWrap,
      ang: new Tween(0), r: new Tween(SEAT_R), sw: new Tween(0), alpha: new Tween(1), flare: new Tween(1), ringT: new Tween(0),
      state: null, target: null, cur: { size: 1, speed: 1, embers: 0, glow: 0.5, crack: 0, turb: 1, flick: 0.1, breath: 0.05, lightK: 1, heat: 1, energy: 1 }, leaving: false,
      phase: Math.random() * 6.28, seedT: Math.random() * 50, dim: 1, focus: false,
      surgeAt: 0, surgeStart: -9, lag: new Vector3(), prevCW: null, foc: 0,
    };
    return s;
  }

  let _shadowTex = null;
  function shadowTex() {
    if (_shadowTex) return _shadowTex;
    const t = canvasTex(128, 128), g = t.ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(0,0,0,.5)"); g.addColorStop(0.7, "rgba(0,0,0,0)");
    t.ctx.fillStyle = g; t.ctx.fillRect(0, 0, 128, 128); t.tex.needsUpdate = true;
    return (_shadowTex = t.tex);
  }

  function applyAlpha(s) {
    const a = s.alpha.v, fading = a < 0.999;
    for (const m of s.mats) { m.transparent = fading; m.opacity = a; }
    s.carrier.visible = a > 0.002;
  }

  function targetFor(seat) {
    const st = seat.state;
    const base = FIRE[st] || FIRE.sealed;
    const p = st === "revealed" && seat.palette ? seat.palette : base;
    return {
      e1: col3(p.e1), c1: col3(p.c1), e2: col3(p.e2), c2: col3(p.c2), c3: col3(p.c3),
      halo: col3(p.halo || p.c1), ember: col3(p.ember || p.c1),
      size: base.size, speed: base.speed, embers: base.embers, glow: base.glow, crack: st === "flagged" ? 1 : 0,
      turb: base.turb, flick: base.flick, breath: base.breath, lightK: base.lightK, heat: base.heat, energy: base.energy,
      surge: base.surge,
    };
  }

  function setSeats(list, opts = {}) {
    const now = T, entering = opts.entering || new Set();
    const ids = new Set(list.map(s => s.id));
    for (const [id, s] of seats) {
      if (ids.has(id) || s.leaving) continue;
      s.leaving = true;
      if (isReduced()) { removeSeat(s); continue; }
      const side = s.crest ? 10 : -10;
      s.r.to(TUCKED_R, 0.3, EASE_OUT_ACCEL, now);
      s.sw.to(side, 0.3, EASE_OUT_ACCEL, now);
      s.alpha.to(0, 0.24, EASE_OUT_ACCEL, now);
    }
    list.forEach(seat => {
      let s = seats.get(seat.id);
      const isNew = !s;
      if (isNew) { s = buildSeat(seat.id, seat.crest); seats.set(seat.id, s); }
      s.leaving = false;
      const prev = s.state;
      s.state = seat.state; s.palette = seat.palette; s.focus = !!seat.focus; s.locked = !!seat.locked;
      if (isNew) {
        s.ang.to(seat.angle, 0);
        if (entering.has(seat.id) && !isReduced()) {
          s.r.to(TUCKED_R, 0); s.alpha.to(0, 0); s.sw.to(s.crest ? -16 : 16, 0);
          s.r.to(SEAT_R, 0.5, EASE_SLIDE, now); s.sw.to(0, 0.6, EASE_SLIDE, now); s.alpha.to(1, 0.3, EASE_LINEAR, now);
          s.flare.to(0, 0); s.flare.to(1, 0.5, EASE_SLIDE, now); s.ringT.to(0, 0); s.ringT.to(1, 0.6, EASE_SLIDE, now);
        } else { s.r.to(SEAT_R, 0); s.sw.to(0, 0); s.alpha.to(1, 0); }
        const t = targetFor(seat); s.target = t; snapSeat(s, t);
      } else {
        s.ang.to(seat.angle, isReduced() ? 0 : 0.6, EASE_ARC, now);
        if (s.r.b !== SEAT_R || s.alpha.b !== 1) { s.r.to(SEAT_R, isReduced() ? 0 : 0.4, EASE_SLIDE, now); s.sw.to(0, isReduced() ? 0 : 0.4, EASE_SLIDE, now); s.alpha.to(1, isReduced() ? 0 : 0.2, EASE_LINEAR, now); }
        s.target = targetFor(seat);
        // a deck sealing or the pod passing flares the orb
        if (prev && prev !== seat.state && (seat.state === "sealed" || seat.state === "revealed") && !isReduced() && !opts.quiet) {
          s.flare.to(0, 0); s.flare.to(1, 0.5, EASE_SLIDE, now); s.ringT.to(0, 0); s.ringT.to(1, 0.6, EASE_SLIDE, now);
        }
      }
      const gemHex = GEM[seat.state] || GEM.waiting;
      if (s.gemMat) { s.gemMat.emissive && s.gemMat.emissive.set(gemHex); s.gemMat.color && s.gemMat.color.set(gemHex); }
    });
    focusId = list.find(s => s.focus)?.id ?? null;
    dirty = true; wake();
  }

  function snapSeat(s, t) {
    s.U.e1.value.copy(t.e1); s.U.c1.value.copy(t.c1); s.U.e2.value.copy(t.e2); s.U.c2.value.copy(t.c2); s.U.c3.value.copy(t.c3);
    s.halo.copy(t.halo); s.emberC.copy(t.ember);
    s.cur = { size: t.size, speed: t.speed, embers: t.embers, glow: t.glow, crack: t.crack, turb: t.turb, flick: t.flick, breath: t.breath, lightK: t.lightK, heat: t.heat, energy: t.energy };
    s.hotC.copy(t.c3);
  }

  function removeSeat(s) {
    seats.delete(s.id); rig.remove(s.pivot);
    if (s.light) { s.light.intensity = 0; s.light.userData.used = false; }
    for (const m of s.mats) m.dispose();
    for (const o of [s.flame, s.flameIn, s.plasma, s.glow, s.glass, s.crack, s.ring, s.embers, s.pick]) o.material.dispose();
    s.pick.geometry.dispose(); s.glass.geometry.dispose(); s.plasma.geometry.dispose();
    s.embers.geometry.dispose();
  }

  function setSigil(model) { sigilModel = model; drawSigil(); wellT.to = model.ready ? 1 : 0; dirty = true; wake(); }

  // ---- table turn ----

  const spin = new Tween(0);
  function setSpin(deg, animate) {
    spin.to(deg, animate && !isReduced() ? 0.7 : 0, EASE_SPIN, T);
    dirty = true; wake();
  }

  // ---- layout ----

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * quality;
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit the whole ring of thrones across the width, then check the height.
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const dW = 4.6 / (half * camera.aspect), dH = 3.3 / half;
    const D = Math.max(dW, dH * 0.8);
    camera.position.set(0, LOOK_Y + D * Math.sin(EL), D * Math.cos(EL));
    camera.lookAt(0, LOOK_Y - 0.55, 0);
    camera.updateProjectionMatrix();
    pxPerUnit = (h / 2) / half;
    for (const s of seats.values()) s.embers.material.uniforms.uPx.value = 0.07 * pxPerUnit * dpr;
    dirty = true; wake(); onMove && onMove();
  }
  const ro = new ResizeObserver(resize); ro.observe(host);

  // ---- picking / anchors ----

  const ray = new Raycaster(), ndc = new Vector2();
  const picks = () => [...seats.values()].filter(s => !s.leaving).map(s => s.pick);
  canvas.addEventListener("click", e => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    ray.setFromCamera(ndc, camera);
    // a generous target: the orb plus its flame
    const hit = ray.intersectObjects(picks(), false)[0];
    if (hit && onPick) onPick(hit.object.userData.seatId);
  });
  const v3 = new Vector3();
  function anchor(id) {
    const s = seats.get(id);
    if (!s) return null;
    s.orb.updateWorldMatrix(true, false);
    v3.set(0, -0.36, 0).applyMatrix4(s.orb.matrixWorld).project(camera);
    return { x: (v3.x * 0.5 + 0.5) * host.clientWidth, y: (-v3.y * 0.5 + 0.5) * host.clientHeight };
  }

  // ---- loop ----

  const ids = { raf: 0, last: 0, lastRender: 0 };
  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) wake(); }).observe(host);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); onFail && onFail(new Error("context lost")); });

  function wake() { if (!ids.raf && visible && !document.hidden) ids.raf = requestAnimationFrame(frame); }
  const lerpTo = (a, b, k) => a + (b - a) * k;

  function frame(ts) {
    ids.raf = 0;
    if (!visible || document.hidden) return;
    const now = ts / 1000, dt = Math.min(0.1, ids.last ? now - ids.last : 0.016);
    ids.last = now; T = now;
    let moving = spin.step(now);
    rig.rotation.y = (-spin.v * Math.PI) / 180;

    for (const s of [...seats.values()]) {
      const a = s.ang.step(now), r = s.r.step(now), w = s.sw.step(now), al = s.alpha.step(now);
      s.flare.step(now); s.ringT.step(now);
      if (a || r || w || al) moving = true;
      if (s.leaving && !s.alpha.on && s.alpha.v <= 0.002) { removeSeat(s); moving = true; continue; }
      s.pivot.rotation.y = (-s.ang.v * Math.PI) / 180;
      s.carrier.position.set(0, 0, s.r.v);
      s.mount.rotation.y = Math.PI + (s.sw.v * Math.PI) / 180;
      applyAlpha(s);

      // fire eases toward its state's look
      const t = s.target, k = isReduced() ? 1 : 1 - Math.exp(-dt * 9);
      if (t) {
        s.U.e1.value.lerp(t.e1, k); s.U.c1.value.lerp(t.c1, k); s.U.e2.value.lerp(t.e2, k); s.U.c2.value.lerp(t.c2, k); s.U.c3.value.lerp(t.c3, k);
        s.halo.lerp(t.halo, k); s.emberC.lerp(t.ember, k); s.hotC.copy(s.U.c3.value);
        for (const key of LIFE_KEYS) s.cur[key] = lerpTo(s.cur[key], t[key], k);
      }
      const still = isReduced(), c = s.cur;
      const tt = still ? s.seedT : now + s.seedT;
      s.U.time.value = tt;
      s.U.speed.value = c.speed;
      const focused = focusId !== null && s.id === focusId;
      s.dim = lerpTo(s.dim, focusId !== null && !focused ? 0.45 : 1, k);
      s.foc = lerpTo(s.foc, focused ? 1 : 0, k);
      const vis = s.alpha.v * s.dim;

      // ---- presence ----
      // Flicker: incommensurate sines, so it never settles into a pattern you can count.
      const fl = still
        ? 1 - c.flick * 0.4
        : 1 - c.flick * (0.5 + 0.5 * (Math.sin(tt * 7.1 + s.phase) * 0.5 + Math.sin(tt * 12.9 + s.phase * 1.7) * 0.3 + Math.sin(tt * 21.3 + s.phase * 2.3) * 0.2));
      // Breathing, a slow swell of the whole orb.
      const br = still ? 1 : 1 + c.breath * Math.sin(now * 1.45 + s.phase);
      // A glance: every few seconds the orb perks up, swells and brightens, like someone
      // looking up. Seats still waiting on a deck do it most.
      let surge = 0;
      if (!still && t) {
        const gap = () => t.surge[0] + Math.random() * (t.surge[1] - t.surge[0]);
        if (s.surgeAt === 0) s.surgeAt = now + gap();
        if (now > s.surgeAt) { s.surgeStart = now; s.surgeAt = now + gap(); }
        const kk = (now - s.surgeStart) / 1.1;
        if (kk >= 0 && kk < 1) surge = Math.pow(Math.sin(kk * Math.PI), 1.5);
      }
      // Secondary motion: the orb trails its throne when the table turns or a seat slides,
      // then settles, and drifts a little even at rest.
      s.carrier.getWorldPosition(_cw);
      if (s.prevCW && !still) s.lag.x -= (_cw.x - s.prevCW.x) * 0.9, s.lag.y -= (_cw.y - s.prevCW.y) * 0.9, s.lag.z -= (_cw.z - s.prevCW.z) * 0.9;
      if (!s.prevCW) s.prevCW = new Vector3();
      s.prevCW.copy(_cw);
      s.lag.multiplyScalar(Math.exp(-dt * 7));
      if (s.lag.lengthSq() > 0.0625) s.lag.setLength(0.25);
      _l.copy(s.lag); s.carrier.getWorldQuaternion(_q); _l.applyQuaternion(_q.invert()).divideScalar(THRONE_K);
      const drift = still ? 0 : 0.02, bob = still ? 0 : Math.sin(now * 1.96 + s.phase) * 0.04;
      s.orb.position.set(_l.x + Math.sin(now * 0.5 + s.phase) * drift, ORB_Y + bob + _l.y, _l.z + Math.cos(now * 0.43 + s.phase) * drift);
      // The flames lean with a slow wind and with the trailing; the focused seat stands upright.
      const wind = still ? 0 : (0.22 * Math.sin(now * 0.5 + s.phase) + 0.1 * Math.sin(now * 1.3 + s.phase * 2)) * (c.turb > 1.3 ? 1.8 : 1);
      const lean = wind * (1 - 0.7 * s.foc) + s.lag.x * 5;

      const flare = 1 + (1 - s.flare.v) * 0.7;               // swell, then settle
      const sz = c.size * br * (1 + 0.14 * surge + 0.1 * s.foc) * flare;
      const lift = 1 + 0.25 * surge;
      const fo = s.flame.material.uniforms, fi = s.flameIn.material.uniforms;
      fo.uSize.value.set(0.82 * sz, 1.0 * sz * lift); fo.uFlick.value = fl * (1 + 0.25 * surge); fo.uTurb.value = c.turb; fo.uLean.value = lean; fo.uAlpha.value = vis;
      fi.uSize.value.set(0.5 * sz, 0.72 * sz * lift); fi.uFlick.value = Math.min(1.1, fl * 1.1 + 0.2 * surge); fi.uTurb.value = c.turb * 1.2; fi.uLean.value = lean * 1.2; fi.uAlpha.value = vis * 0.7;
      const pu = s.plasma.material.uniforms;
      pu.uAlpha.value = vis; pu.uEnergy.value = c.energy * (0.75 + 0.3 * fl + 0.35 * surge);
      s.plasma.scale.setScalar(br * (1 + 0.05 * surge));
      s.glow.material.uniforms.uSize.value.setScalar(1.5 * br * (1 + 0.15 * surge + 0.1 * s.foc));
      s.glow.material.uniforms.uAlpha.value = c.glow * vis * (0.75 + 0.35 * fl + 0.4 * surge + (1 - s.flare.v) * 0.8);
      s.glass.material.uniforms.uAlpha.value = vis;
      s.crack.material.uniforms.uAlpha.value = c.crack * vis;
      const eu = s.embers.material.uniforms;
      eu.uAlpha.value = c.embers * vis * (still ? 0 : 1) * (0.8 + 0.3 * surge); eu.uHeat.value = c.heat;
      if (s.light) {
        const L = s.light;
        L.color.copy(s.halo); s.orb.getWorldPosition(L.position); L.position.y += 0.12;
        L.intensity = LIGHT_BASE * c.lightK * vis * (0.7 + 0.45 * fl + 0.5 * surge + 0.35 * s.foc + (1 - s.flare.v) * 1.5);
      }
      const rg = s.ring.material.uniforms; rg.uAlpha.value = (1 - s.ringT.v) * 0.9 * vis * (s.ringT.on ? 1 : 0); rg.uR.value = 0.25 + s.ringT.v * 0.7;
      if (s.flare.on || s.ringT.on) moving = true;
    }

    // well colour: violet scrying pool, gold once the pod has passed
    if (wellT.k !== wellT.to) {
      wellT.k = isReduced() ? wellT.to : lerpTo(wellT.k, wellT.to, 1 - Math.exp(-dt * 6));
      if (Math.abs(wellT.k - wellT.to) < 0.004) wellT.k = wellT.to;
      wellMat.uniforms.uA.value.copy(wellColors.violet[0]).lerp(wellColors.gold[0], wellT.k);
      wellMat.uniforms.uB.value.copy(wellColors.violet[1]).lerp(wellColors.gold[1], wellT.k);
      moving = true;
    }
    wellMat.uniforms.uTime.value = isReduced() ? 0 : now;

    const animated = seats.size > 0 && !isReduced();   // flames and embers never stop while a seat is lit
    if (moving || dirty || animated) {
      // idle flame frames at 30fps; transitions get every frame
      if (moving || dirty || now - ids.lastRender >= 0.032) {
        // Idle frames are throttled to ~30fps, so their spacing is a fair read of whether
        // this device keeps up: a median well over 33ms means it can't.
        const gap = (now - ids.lastRender) * 1000;
        renderer.render(scene, camera); ids.lastRender = now;
        if (!qualityChecked && animated && !moving && gap < 1000) {
          frameTimes.push(gap);
          if (frameTimes.length >= 60) {
            qualityChecked = true;
            frameTimes.sort((x, y) => x - y);
            if (frameTimes[30] > 45) { quality = 0.7; resize(); }
          }
        }
        if (moving) onMove && onMove();
      }
    }
    const again = moving || animated || dirty;
    dirty = false;
    if (again) ids.raf = requestAnimationFrame(frame);
    else ids.last = 0;
  }

  resize();
  wake();

  return {
    setSeats, setSpin, setSigil, anchor, resize,
    redraw() { dirty = true; wake(); },
    dispose() {
      ro.disconnect(); cancelAnimationFrame(ids.raf); renderer.dispose(); canvas.remove();
    },
  };
}
