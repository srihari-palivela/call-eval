// The 3D story behind the page. One instanced mesh holds every call as an orb; each scene arranges the orbs in a
// layout (a field of calls, one call up close, the persona × journey grid, two racing prompt streams, a funnel)
// and the scroll position blends between them. A shader ribbon is the one call's waveform. Everything reads
// story.t each frame, so scrolling never re-renders React.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import * as THREE from 'three';
import { story } from '../story';

const Effects = lazy(() => import('./Effects'));

const GOOD = new THREE.Color('#3ddc97');
const PROBLEM = new THREE.Color('#ff6b5e');
const NEUTRAL = new THREE.Color('#7d90b0');
const BG = '#06080c';

// Layout per scene (field, dive, dive, grid, grid, race, funnel, calm, calm) and how bright the orbs are.
enum L { Field, Dive, Grid, Race, Funnel, Calm }
const SCENE_LAYOUT = [L.Field, L.Dive, L.Dive, L.Grid, L.Grid, L.Race, L.Funnel, L.Calm, L.Calm];
const SCENE_DIM = [1, 0.9, 0.75, 1, 0.42, 1, 1, 0.55, 0.8];
// Camera position and target per scene.
const CAM: [number, number, number, number, number, number][] = [
  [0, 0, 13, 0, 0, 0],
  [0, 0.25, 5.4, 0, 0, 0],
  [0, 0.6, 6.4, 0, 0, 0],
  [0, 7.2, 8.6, 0, 0.4, 0],
  [2.4, 6.2, 9.6, 0.8, 0.5, 0],
  [0, 0.7, 9.4, 0, 0, 0],
  [0, 0.8, 10.6, 0, 0, 0],
  [0, 0, 14.5, 0, 0, 0],
  [0, 0, 12.5, 0, 0, 0],
];
const SCENES = SCENE_LAYOUT.length;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Where the story is between two scenes: scene i, blending to i + 1 by w over the last part of scene i. */
function phase(t: number) {
  const i = Math.min(SCENES - 1, Math.max(0, Math.floor(t)));
  const w = i === SCENES - 1 ? 0 : smooth(0.62, 1, t - i);
  return { i, j: Math.min(SCENES - 1, i + 1), w };
}
/** How present a set of scenes is at t, 0 to 1. */
function presence(t: number, scenes: number[]) {
  const { i, j, w } = phase(t);
  return (scenes.includes(i) ? 1 - w : 0) + (scenes.includes(j) && j !== i ? w : 0);
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Layout = { pos: Float32Array; col: Float32Array; scale: Float32Array; flick: Float32Array };
const layout = (n: number): Layout => ({ pos: new Float32Array(n * 3), col: new Float32Array(n * 3), scale: new Float32Array(n), flick: new Float32Array(n) });
const setCol = (l: Layout, i: number, c: THREE.Color, k = 1) => {
  l.col[i * 3] = c.r * k;
  l.col[i * 3 + 1] = c.g * k;
  l.col[i * 3 + 2] = c.b * k;
};

// The persona × journey grid: 7 caller types by 8 journeys; one weak cell.
const ROWS = 7, COLS = 8, WEAK = 3 * COLS + 5;
const cellScore = (cell: number) => (cell === WEAK ? 49 : 62 + (((cell / COLS) | 0) * 37 + (cell % COLS) * 53) % 31);

function buildStatic(n: number) {
  const r = mulberry32(1284);
  const seed = new Float32Array(n);
  const kind = new Uint8Array(n); // 0 good, 1 neutral, 2 problem
  const field = layout(n), dive = layout(n), grid = layout(n), calm = layout(n);
  // Cells get calls in proportion to a weight, so columns differ in height.
  const weights = Array.from({ length: ROWS * COLS }, (_, c) => 0.5 + ((c * 7919) % 13) / 13 + (c === WEAK ? 0.4 : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const cellOf = new Uint16Array(n), slot = new Uint16Array(n), filled = new Uint16Array(ROWS * COLS);
  let acc = 0, cell = 0;
  for (let i = 0; i < n; i++) {
    seed[i] = r();
    const k = r();
    kind[i] = i === 0 ? 2 : k < 0.03 ? 2 : k < 0.18 ? 1 : 0;
    while (cell < ROWS * COLS - 1 && (i + 0.5) / n > (acc + weights[cell]) / total) acc += weights[cell++];
    cellOf[i] = cell;
    slot[i] = filled[cell]++;
  }
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const depth = r();
    // Field: a wide, shallow cloud of calls; the call we follow sits near the front, right of centre.
    if (i === 0) field.pos.set([2.4, 0.5, 4], i3);
    else field.pos.set([(r() - 0.5) * 24, (r() - 0.5) * 13, -13 + depth * 15], i3);
    field.scale[i] = 0.55 + r() * 0.9;
    setCol(field, i, kind[i] === 2 ? PROBLEM : kind[i] === 1 ? NEUTRAL : GOOD, 0.55 + depth * 0.6);
    field.flick[i] = kind[i] === 2 ? 1 : 0;

    // Dive: the one call at the centre; the rest pushed far back and dimmed.
    if (i === 0) {
      dive.pos.set([0, 0, 0], i3);
      dive.scale[i] = 2.6;
      setCol(dive, i, PROBLEM, 1.1);
      dive.flick[i] = 0.25;
    } else {
      const fx = field.pos[i3], fy = field.pos[i3 + 1], fz = field.pos[i3 + 2] - 2;
      const len = Math.hypot(fx, fy, fz) || 1, rad = 16 + seed[i] * 12;
      dive.pos.set([(fx / len) * rad, (fy / len) * rad * 0.6, -Math.abs((fz / len) * rad) - 6], i3);
      dive.scale[i] = 0.45;
      setCol(dive, i, kind[i] === 2 ? PROBLEM : NEUTRAL, 0.32);
    }

    // Grid: a column of orbs per cell, coloured by the cell's median score; the weak cell lifts and glows.
    const c = cellOf[i], row = (c / COLS) | 0, col = c % COLS;
    const weak = c === WEAK;
    grid.pos.set([(col - 3.5) * 1.18, -1.25 + slot[i] * 0.105 + (weak ? 1.3 : 0), (row - 3) * 1.18], i3);
    grid.scale[i] = 0.9;
    const s = cellScore(c);
    setCol(grid, i, weak ? PROBLEM : s >= 70 ? GOOD : NEUTRAL, weak ? 1.25 : 0.8);
    grid.flick[i] = weak ? 0.45 : 0;

    // Calm: after the fixes, a tighter field where the problems have turned good.
    calm.pos.set([field.pos[i3] * 0.72, field.pos[i3 + 1] * 0.72, field.pos[i3 + 2] * 0.8 - 1], i3);
    calm.scale[i] = field.scale[i] * 0.95;
    setCol(calm, i, kind[i] === 1 ? NEUTRAL : GOOD, 0.5 + depth * 0.55);
    calm.flick[i] = 0;
  }
  return { seed, kind, field, dive, grid, calm };
}

// Race: two lanes of calls running left to right; the challenger takes 20% of calls and runs a little brighter.
function buildRace(l: Layout, seed: Float32Array, kind: Uint8Array, time: number) {
  const n = seed.length, span = 20;
  for (let i = 0; i < n; i++) {
    const challenger = i % 5 === 0;
    const speed = challenger ? 1.25 : 1.05;
    const x = ((seed[i] * span + time * speed) % span) - span / 2;
    const lane = challenger ? 1.15 : -1.15;
    l.pos[i * 3] = x;
    l.pos[i * 3 + 1] = lane + Math.sin(seed[i] * 91) * 0.32;
    l.pos[i * 3 + 2] = Math.cos(seed[i] * 57) * 0.9;
    l.scale[i] = challenger ? 1.05 : 0.8;
    setCol(l, i, challenger ? GOOD : kind[i] === 2 ? PROBLEM : NEUTRAL, challenger ? 1.15 : 0.6);
    l.flick[i] = 0;
  }
}

// Funnel: leads drop in at the top, narrow through the stages and leave the bottom as meetings.
function buildFunnel(l: Layout, seed: Float32Array, time: number) {
  const n = seed.length;
  for (let i = 0; i < n; i++) {
    const u = (seed[i] + time * 0.045) % 1;
    const radius = 3.8 + (0.32 - 3.8) * Math.pow(u, 0.75);
    const a = seed[i] * Math.PI * 2 * 7 + time * 0.35;
    l.pos[i * 3] = Math.cos(a) * radius * (0.55 + 0.45 * ((seed[i] * 13) % 1));
    l.pos[i * 3 + 1] = 3.1 - u * 6.4;
    l.pos[i * 3 + 2] = Math.sin(a) * radius * 0.5;
    l.scale[i] = 0.75;
    const met = u > 0.9;
    setCol(l, i, met ? GOOD : NEUTRAL, met ? 1.3 : 0.55 + (1 - u) * 0.3);
    l.flick[i] = 0;
  }
}

function Orbs({ count, boost }: { count: number; boost: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const s = useMemo(() => buildStatic(count), [count]);
  const race = useMemo(() => layout(count), [count]);
  const funnel = useMemo(() => layout(count), [count]);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.075, 14, 10), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  const smoothT = useRef(0);
  const { invalidate } = useThree();

  useEffect(() => {
    const m = mesh.current;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    invalidate();
  }, [count, invalidate]);

  useFrame((state, dt) => {
    const m = mesh.current;
    if (!m.instanceColor) return;
    smoothT.current += (story.t - smoothT.current) * (1 - Math.exp(-dt * 4));
    const t = smoothT.current, time = state.clock.elapsedTime;
    const { i: si, j: sj, w } = phase(t);
    const pick = (id: L): Layout => {
      if (id === L.Race) { buildRace(race, s.seed, s.kind, time); return race; }
      if (id === L.Funnel) { buildFunnel(funnel, s.seed, time); return funnel; }
      return id === L.Field ? s.field : id === L.Dive ? s.dive : id === L.Grid ? s.grid : s.calm;
    };
    const A = pick(SCENE_LAYOUT[si]);
    const B = SCENE_LAYOUT[sj] === SCENE_LAYOUT[si] ? A : pick(SCENE_LAYOUT[sj]);
    const dim = (SCENE_DIM[si] * (1 - w) + SCENE_DIM[sj] * w) * boost;
    // The field and the calm field turn slowly.
    const spin = presence(t, [0, 7, 8]) * time * 0.025;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const mat = m.instanceMatrix.array as Float32Array;
    const col = m.instanceColor.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3, i16 = i * 16, sd = s.seed[i];
      let x = A.pos[i3] + (B.pos[i3] - A.pos[i3]) * w;
      const y = A.pos[i3 + 1] + (B.pos[i3 + 1] - A.pos[i3 + 1]) * w + Math.sin(time * 0.4 + sd * 40) * 0.04;
      let z = A.pos[i3 + 2] + (B.pos[i3 + 2] - A.pos[i3 + 2]) * w;
      if (spin && i !== 0) {
        const rx = x * cs - z * sn;
        z = x * sn + z * cs;
        x = rx;
      }
      const sc = A.scale[i] + (B.scale[i] - A.scale[i]) * w;
      mat[i16] = sc; mat[i16 + 1] = 0; mat[i16 + 2] = 0; mat[i16 + 3] = 0;
      mat[i16 + 4] = 0; mat[i16 + 5] = sc; mat[i16 + 6] = 0; mat[i16 + 7] = 0;
      mat[i16 + 8] = 0; mat[i16 + 9] = 0; mat[i16 + 10] = sc; mat[i16 + 11] = 0;
      mat[i16 + 12] = x; mat[i16 + 13] = y; mat[i16 + 14] = z; mat[i16 + 15] = 1;
      const fl = A.flick[i] + (B.flick[i] - A.flick[i]) * w;
      const pulse = 0.5 + 0.5 * Math.sin(time * 6.5 + sd * 60);
      const k = dim * (1 - fl * 0.6 * pulse * pulse);
      col[i3] = (A.col[i3] + (B.col[i3] - A.col[i3]) * w) * k;
      col[i3 + 1] = (A.col[i3 + 1] + (B.col[i3 + 1] - A.col[i3 + 1]) * w) * k;
      col[i3 + 2] = (A.col[i3 + 2] + (B.col[i3 + 2] - A.col[i3 + 2]) * w) * k;
    }
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, count]} frustumCulled={false} />;
}

// The one call's waveform: a ribbon that unrolls in scene 2, splits into introduction, body and conclusion in
// scene 3, and flashes when the compliance gate fails.
const RIBBON_VERT = /* glsl */ `
uniform float uTime, uSplit;
varying float vX;
varying float vSeg;
void main() {
  vec3 p = position;
  float x = p.x / 5.2 + 0.5;
  float seg = x < 0.34 ? 0.0 : (x < 0.71 ? 1.0 : 2.0);
  float words = smoothstep(0.08, 0.3, fract(x * 6.0 + 0.15)) * smoothstep(1.0, 0.72, fract(x * 6.0 + 0.15));
  float edge = smoothstep(0.0, 0.05, x) * smoothstep(1.0, 0.95, x);
  float wave = abs(sin(x * 71.0 + uTime * 2.4) * 0.6 + sin(x * 23.0 - uTime * 1.3) * 0.4);
  p.y *= 0.06 + words * edge * (0.25 + wave * 1.6);
  p.x += (seg - 1.0) * uSplit * 0.42;
  vX = x;
  vSeg = seg;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const RIBBON_FRAG = /* glsl */ `
uniform float uReveal, uSplit, uFlash, uOpacity, uBoost;
uniform vec3 uGood, uNeutral, uProblem;
varying float vX;
varying float vSeg;
void main() {
  float shown = 1.0 - smoothstep(uReveal - 0.04, uReveal, vX);
  vec3 c = vSeg == 1.0 ? mix(uGood, uNeutral, uSplit) : uGood;
  c = vSeg == 1.0 ? mix(c, uProblem, uFlash) : mix(c, uProblem, uFlash * 0.35);
  // Quieter on the left, where the scene's headline sits over it.
  float quiet = mix(0.3, 1.0, smoothstep(0.18, 0.6, vX));
  gl_FragColor = vec4(c * uBoost, shown * uOpacity * 0.9 * quiet);
}`;

function Ribbon({ boost }: { boost: number }) {
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 }, uReveal: { value: 0 }, uSplit: { value: 0 }, uFlash: { value: 0 }, uOpacity: { value: 0 }, uBoost: { value: boost },
    uGood: { value: GOOD.clone() }, uNeutral: { value: NEUTRAL.clone() }, uProblem: { value: PROBLEM.clone() },
  }), [boost]);
  const smoothT = useRef(0);
  useFrame((state, dt) => {
    smoothT.current += (story.t - smoothT.current) * (1 - Math.exp(-dt * 4));
    const t = smoothT.current, u = mat.current.uniforms;
    u.uTime.value = state.clock.elapsedTime;
    u.uOpacity.value = smooth(0.9, 1.2, t) * (1 - smooth(2.7, 3.05, t));
    u.uReveal.value = smooth(1.0, 1.55, t) * 1.05;
    u.uSplit.value = smooth(2.0, 2.3, t);
    // The gate fails at about 40% into scene 3, and the body stays marked after.
    u.uFlash.value = smooth(2.36, 2.42, t) * (0.55 + 0.45 * (1 - smooth(2.42, 2.55, t)));
  });
  return (
    <mesh position={[0, 0, 0.3]}>
      <planeGeometry args={[5.2, 0.9, 260, 1]} />
      <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={RIBBON_VERT} fragmentShader={RIBBON_FRAG} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </mesh>
  );
}

// Faint guides that make the grid, the lanes and the funnel stages readable.
function Guides() {
  const grid = useRef<THREE.GridHelper>(null!);
  const lanes = useRef<THREE.Group>(null!);
  const rings = useRef<THREE.Group>(null!);
  const smoothT = useRef(0);
  const gridHelper = useMemo(() => {
    const g = new THREE.GridHelper(COLS * 1.18, COLS, NEUTRAL, NEUTRAL);
    (g.material as THREE.Material).transparent = true;
    return g;
  }, []);
  const ringGeo = useMemo(() => [0.25, 0.5, 0.75].map((u) => new THREE.TorusGeometry(3.8 + (0.32 - 3.8) * Math.pow(u, 0.75), 0.01, 6, 120)), []);
  const lineMat = useMemo(() => new THREE.MeshBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0, toneMapped: false }), []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0, toneMapped: false }), []);
  useFrame((_, dt) => {
    smoothT.current += (story.t - smoothT.current) * (1 - Math.exp(-dt * 4));
    const t = smoothT.current;
    (grid.current.material as THREE.Material).opacity = 0.16 * presence(t, [3, 4]);
    lineMat.opacity = 0.22 * presence(t, [5]);
    ringMat.opacity = 0.3 * presence(t, [6]);
    grid.current.visible = presence(t, [3, 4]) > 0.01;
    lanes.current.visible = lineMat.opacity > 0.005;
    rings.current.visible = ringMat.opacity > 0.005;
  });
  return (
    <>
      <primitive ref={grid} object={gridHelper} position={[0, -1.32, 0]} />
      <group ref={lanes}>
        {[1.15, -1.15].map((y) => (
          <mesh key={y} position={[0, y, 0]} material={lineMat}><boxGeometry args={[20, 0.006, 0.006]} /></mesh>
        ))}
      </group>
      <group ref={rings}>
        {ringGeo.map((g, k) => (
          <mesh key={k} geometry={g} material={ringMat} position={[0, 3.1 - [0.25, 0.5, 0.75][k] * 6.4, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 0.5, 1]} />
        ))}
      </group>
    </>
  );
}

function CameraRig({ parallax }: { parallax: boolean }) {
  const { camera, pointer } = useThree();
  const look = useRef(new THREE.Vector3());
  const smoothT = useRef(0);
  const goal = useMemo(() => new THREE.Vector3(), []);
  const aim = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    smoothT.current += (story.t - smoothT.current) * (1 - Math.exp(-dt * 3));
    const { i, j, w } = phase(smoothT.current);
    const a = CAM[i], b = CAM[j];
    const px = parallax ? pointer.x * 0.35 : 0, py = parallax ? pointer.y * 0.2 : 0;
    goal.set(a[0] + (b[0] - a[0]) * w + px, a[1] + (b[1] - a[1]) * w + py, a[2] + (b[2] - a[2]) * w);
    aim.set(a[3] + (b[3] - a[3]) * w, a[4] + (b[4] - a[4]) * w, a[5] + (b[5] - a[5]) * w);
    const k = 1 - Math.exp(-dt * 3.2);
    camera.position.lerp(goal, k);
    look.current.lerp(aim, k);
    camera.lookAt(look.current);
  });
  return null;
}

function Ready() {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    document.documentElement.dataset.stage = 'ready';
  });
  return null;
}

export default function Stage({ mobile }: { mobile: boolean }) {
  const [dpr, setDpr] = useState(mobile ? 1.25 : 1.6);
  const count = mobile ? 420 : 1284;
  const boost = mobile ? 1.05 : 1.55;
  useEffect(() => () => { delete document.documentElement.dataset.stage; }, []);
  return (
    <div className="stage" aria-hidden="true">
      <Canvas
        dpr={dpr}
        gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
        camera={{ fov: 42, position: [0, 0, 13], near: 0.1, far: 80 }}
        onCreated={({ scene }) => { scene.fog = new THREE.Fog(BG, 9, 34); }}
      >
        <PerformanceMonitor onDecline={() => setDpr(1)} />
        <CameraRig parallax={!mobile} />
        <Orbs count={count} boost={boost} />
        <Ribbon boost={boost} />
        <Guides />
        {!mobile && (
          <Suspense fallback={null}>
            <Effects />
          </Suspense>
        )}
        <Ready />
      </Canvas>
    </div>
  );
}
