import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import "./App.css";

/* =====================================================================
   HELPERS
   ===================================================================== */
const sstep = THREE.MathUtils.smoothstep;

function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function canvasTex(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---- value noise / fbm (used for mountains) ----
function hash2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 4) {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f);
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

// ---- road centre-line: gentle mountain bends ----
const curve = (t) => 30 * Math.sin(t / 230) + 12 * Math.sin(t / 83 + 1.3);
const dcurve = (t) => (30 / 230) * Math.cos(t / 230) + (12 / 83) * Math.cos(t / 83 + 1.3);

// ---- terrain height (xl = metres from road centre, t = distance along road) ----
function heightAt(xl, t) {
  const d = Math.abs(xl);
  const w = sstep(d, 7, 16);
  if (w <= 0) return -0.05;
  const n = fbm(xl * 0.011 + 3.1, t * 0.011, 4);
  const r = 1 - Math.abs(2 * fbm(xl * 0.004 + 9, t * 0.004, 3) - 1);
  let h;
  if (xl > 0) {
    h = sstep(d, 10, 80) * (30 + n * 95) + sstep(d, 90, 300) * (r * r * 330);
  } else {
    h = -sstep(d, 10, 55) * 24 + n * 9 * sstep(d, 30, 120) + sstep(d, 170, 380) * (r * r * 300);
  }
  h += (fbm(xl * 0.07, t * 0.07, 3) - 0.5) * 7 * sstep(d, 12, 40);
  return -0.05 + w * h;
}

function waterNormalTexture() {
  const N = 256;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  const img = g.createImageData(N, N);
  const waves = [
    [3, 1, 0.5],
    [1, 4, 0.4],
    [5, 5, 0.25],
    [7, 2, 0.2],
    [2, 9, 0.15]
  ];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / N) * Math.PI * 2;
      const v = (y / N) * Math.PI * 2;
      let dx = 0;
      let dy = 0;
      for (const [a, b, amp] of waves) {
        const dd = Math.cos(a * u + b * v + a * b) * amp;
        dx += dd * a;
        dy += dd * b;
      }
      let nx = -dx * 0.05;
      let ny = -dy * 0.05;
      const l = Math.hypot(nx, ny, 1);
      nx /= l;
      ny /= l;
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function cloudTexture(seed) {
  return canvasTex(
    256,
    128,
    (g, w, h) => {
      const r = makeRng(seed);
      for (let i = 0; i < 30; i++) {
        const x = w * (0.15 + 0.7 * r());
        const y = h * (0.42 + 0.28 * r());
        const rad = 16 + r() * 30;
        const gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, "rgba(255,255,255,0.55)");
        gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr;
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    },
    { repeat: false }
  );
}

// distant hazy mountain ring (fills the horizon)
function makeMountainRing(radius, minH, maxH, seed, topHex, botColor) {
  const rng = makeRng(seed);
  const N = 360;
  const ph = [rng() * 6, rng() * 6, rng() * 6, rng() * 6];
  const pos = [];
  const col = [];
  const idx = [];
  const top = new THREE.Color(topHex);
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.sin(a) * radius;
    const z = -Math.cos(a) * radius;
    const n =
      0.5 +
      0.5 *
        (Math.sin(a * 7 + ph[0]) * 0.45 +
          Math.sin(a * 17 + ph[1]) * 0.3 +
          Math.sin(a * 41 + ph[2]) * 0.18 +
          Math.sin(a * 97 + ph[3]) * 0.1);
    const hgt = minH + (maxH - minH) * Math.pow(n, 1.3);
    pos.push(x, -60, z, x, hgt, z);
    col.push(botColor.r, botColor.g, botColor.b, top.r, top.g, top.b);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })
  );
}

/* =====================================================================
   TERRAIN CONSTANTS
   ===================================================================== */
const CHUNK_LEN = 60;
const NCH = 9;
const SX = 96;
const SZ = 30;
const XMAX = 400;
const TREES = 130;
const ROCKS = 36;
const XS = [];
for (let i = 0; i <= SX; i++) {
  const u = (i / SX) * 2 - 1;
  XS.push(Math.sign(u) * XMAX * u * u);
}

const C_MEADOW = new THREE.Color("#6e8b3d");
const C_FOREST = new THREE.Color("#3c5a2a");
const C_ALPINE = new THREE.Color("#8a8156");
const C_ROCK = new THREE.Color("#7a746b");
const C_SNOW = new THREE.Color("#f1f4f8");
const C_SHORE = new THREE.Color("#7c7863");
const C_GRAVEL = new THREE.Color("#8b867a");
const tmpC = new THREE.Color();
const dummy = new THREE.Object3D();

/* =====================================================================
   COMPONENT
   ===================================================================== */
export default function App() {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const W = () => mount.clientWidth;
    const H = () => mount.clientHeight;
    const PR = Math.min(window.devicePixelRatio, 1.75);

    // ---------- RENDERER ----------
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(PR);
    renderer.setSize(W(), H());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.55;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // ---------- SCENE ----------
    const scene = new THREE.Scene();
    const HAZE = new THREE.Color("#b9cde0");
    scene.fog = new THREE.FogExp2(HAZE, 0.0021);

    const camera = new THREE.PerspectiveCamera(65, W() / H(), 0.1, 5000);
    camera.position.set(0, 4.2, 9.5);

    // ---------- SKY + SUN (morning, low sun ahead-left) ----------
    const SUN = new THREE.Vector3(-0.8, 0.5, -0.35).normalize();
    const setupSky = (s) => {
      const u = s.material.uniforms;
      u.turbidity.value = 5;
      u.rayleigh.value = 1.4;
      u.mieCoefficient.value = 0.005;
      u.mieDirectionalG.value = 0.82;
      u.sunPosition.value.copy(SUN);
      s.scale.setScalar(450000);
    };
    const sky = new Sky();
    setupSky(sky);
    scene.add(sky);

    const envScene = new THREE.Scene();
    const envSky = new Sky();
    setupSky(envSky);
    envScene.add(envSky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(envScene);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.55;

    // ---------- LIGHTS ----------
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x6b7a4a, 0.9));

    const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    scene.add(sun);
    scene.add(sun.target);

    // ---------- FAR MOUNTAINS + LAKE ----------
    const mountains = new THREE.Group();
    mountains.add(makeMountainRing(1700, 260, 760, 11, "#a9bdd3", HAZE));
    mountains.add(makeMountainRing(1350, 160, 480, 23, "#8fa6bf", HAZE));
    scene.add(mountains);

    const waterNormal = waterNormalTexture();
    waterNormal.repeat.set(500, 500);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshStandardMaterial({
        color: "#1d5068",
        roughness: 0.08,
        metalness: 0.1,
        normalMap: waterNormal,
        normalScale: new THREE.Vector2(0.35, 0.35),
        envMapIntensity: 1.2
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, -19, -1500);
    scene.add(water);

    // ---------- CLOUDS ----------
    const clouds = [];
    const cloudRng = makeRng(99);
    const cloudTexs = [cloudTexture(3), cloudTexture(8), cloudTexture(21)];
    for (let i = 0; i < 18; i++) {
      const ang = (cloudRng() - 0.5) * 2.6;
      const R = 900 + cloudRng() * 1600;
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: cloudTexs[i % 3],
          transparent: true,
          depthWrite: false,
          opacity: 0.85,
          color: "#f6f8ff",
          fog: false
        })
      );
      const w = 600 + cloudRng() * 700;
      sp.scale.set(w, w * 0.42, 1);
      sp.position.set(Math.sin(ang) * R, 230 + cloudRng() * 380, -Math.cos(ang) * R);
      scene.add(sp);
      clouds.push(sp);
    }

    // ---------- TRACK (everything that scrolls lives here) ----------
    const track = new THREE.Group();
    scene.add(track);

    // asphalt texture (24 m tile)
    const ROAD_TILE = 24;
    const roadTex = canvasTex(512, 1024, (g, w, h) => {
      const r = makeRng(77);
      g.fillStyle = "#4b4d53";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 22000; i++) {
        const v = 60 + r() * 70;
        g.fillStyle = `rgba(${v},${v},${v + 4},${0.08 + r() * 0.18})`;
        g.fillRect(r() * w, r() * h, 1.6, 1.6);
      }
      g.fillStyle = "rgba(20,20,22,0.12)";
      g.fillRect(w * 0.18, 0, 54, h);
      g.fillRect(w * 0.68, 0, 54, h);
      g.strokeStyle = "rgba(20,20,22,0.35)";
      g.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        let x = r() * w;
        let y = r() * h;
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          x += (r() - 0.5) * 40;
          y += 20 + r() * 40;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.fillStyle = "#e9e9e2";
      g.fillRect(14, 0, 9, h);
      g.fillRect(w - 23, 0, 9, h);
      g.fillStyle = "#f2d04a";
      for (let k = 0; k < 3; k++) g.fillRect(w * 0.5 - 4, k * 341.33 + 30, 8, 170);
    });
    const roadMat = new THREE.MeshStandardMaterial({
      map: roadTex,
      roughness: 0.88,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const railMat = new THREE.MeshStandardMaterial({
      color: "#b9bec4",
      roughness: 0.45,
      metalness: 0.35,
      side: THREE.DoubleSide
    });
    const postMat = new THREE.MeshStandardMaterial({ color: "#8d9298", roughness: 0.6, metalness: 0.3 });
    const rockMat = new THREE.MeshStandardMaterial({ color: "#7d776e", roughness: 0.95, flatShading: true });
    const treeMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1 });

    const coneA = new THREE.ConeGeometry(1.5, 4, 7);
    coneA.translate(0, 2.6, 0);
    const coneB = new THREE.ConeGeometry(1.05, 3, 7);
    coneB.translate(0, 4.7, 0);
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    {
      const p = rockGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const s = 1 + 0.22 * Math.sin(x * 5.1 + y * 3.7) * Math.cos(z * 4.3);
        p.setXYZ(i, x * s, y * s * 0.75, z * s);
      }
      rockGeo.computeVertexNormals();
    }
    const postGeo = new THREE.BoxGeometry(0.12, 0.9, 0.12);

    const terrainIndex = [];
    for (let iz = 0; iz < SZ; iz++) {
      for (let ix = 0; ix < SX; ix++) {
        const a = iz * (SX + 1) + ix;
        const b = a + 1;
        const c = a + SX + 1;
        const d = c + 1;
        terrainIndex.push(a, b, c, b, d, c);
      }
    }
    const roadIndex = [];
    for (let j = 0; j < SZ; j++) {
      const a = j * 2;
      roadIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const railIndex = [];
    for (let j = 0; j < SZ; j++) {
      const b0 = j * 4;
      const b1 = b0 + 4;
      for (const o of [0, 2]) {
        railIndex.push(b0 + o, b0 + o + 1, b1 + o, b0 + o + 1, b1 + o + 1, b1 + o);
      }
    }
    const POSTS = Math.floor(CHUNK_LEN / 4) * 2;
    const treeRng = makeRng(555);

    function createChunk() {
      const group = new THREE.Group();
      const nV = (SX + 1) * (SZ + 1);

      const tGeo = new THREE.BufferGeometry();
      tGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
      tGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
      tGeo.setIndex(terrainIndex);
      const terrain = new THREE.Mesh(tGeo, terrainMat);
      terrain.receiveShadow = true;
      terrain.frustumCulled = false;
      group.add(terrain);

      const rGeo = new THREE.BufferGeometry();
      rGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SZ + 1) * 2 * 3), 3));
      rGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((SZ + 1) * 2 * 2), 2));
      rGeo.setIndex(roadIndex);
      const roadMesh = new THREE.Mesh(rGeo, roadMat);
      roadMesh.receiveShadow = true;
      roadMesh.frustumCulled = false;
      group.add(roadMesh);

      const gGeo = new THREE.BufferGeometry();
      gGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SZ + 1) * 4 * 3), 3));
      gGeo.setIndex(railIndex);
      const rail = new THREE.Mesh(gGeo, railMat);
      rail.frustumCulled = false;
      group.add(rail);

      const posts = new THREE.InstancedMesh(postGeo, postMat, POSTS);
      posts.frustumCulled = false;
      posts.castShadow = true;
      group.add(posts);

      const treesA = new THREE.InstancedMesh(coneA, treeMat, TREES);
      const treesB = new THREE.InstancedMesh(coneB, treeMat, TREES);
      [treesA, treesB].forEach((m) => {
        m.frustumCulled = false;
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      });
      for (let i = 0; i < TREES; i++) {
        const v = 0.7 + treeRng() * 0.5;
        tmpC.setRGB(0.05 * v, 0.2 * v, 0.07 * v);
        treesA.setColorAt(i, tmpC);
        tmpC.setRGB(0.06 * v, 0.24 * v, 0.08 * v);
        treesB.setColorAt(i, tmpC);
      }

      const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
      rocks.frustumCulled = false;
      rocks.castShadow = true;
      rocks.receiveShadow = true;
      group.add(rocks);

      track.add(group);
      return { group, tGeo, rGeo, gGeo, posts, treesA, treesB, rocks };
    }

    function buildChunk(c, distance) {
      const z0 = c.group.position.z;
      const pos = c.tGeo.attributes.position.array;
      const col = c.tGeo.attributes.color.array;
      const rowT = [];

      for (let iz = 0; iz <= SZ; iz++) {
        const lz = (-CHUNK_LEN * iz) / SZ;
        const t = -(z0 + lz) + distance;
        rowT.push(t);
        const cx = curve(t);
        for (let ix = 0; ix <= SX; ix++) {
          const k = (iz * (SX + 1) + ix) * 3;
          pos[k] = cx + XS[ix];
          pos[k + 1] = heightAt(XS[ix], t);
          pos[k + 2] = lz;
        }
      }
      c.tGeo.attributes.position.needsUpdate = true;
      c.tGeo.computeVertexNormals();
      const nrm = c.tGeo.attributes.normal.array;

      for (let iz = 0; iz <= SZ; iz++) {
        const t = rowT[iz];
        for (let ix = 0; ix <= SX; ix++) {
          const k = (iz * (SX + 1) + ix) * 3;
          const h = pos[k + 1];
          const ny = nrm[k + 1];
          const xl = XS[ix];
          const d = Math.abs(xl);
          tmpC.copy(C_MEADOW);
          tmpC.lerp(C_FOREST, sstep(h, 2, 30));
          tmpC.lerp(C_ALPINE, sstep(h, 60, 110));
          tmpC.lerp(C_ROCK, sstep(1 - ny, 0.16, 0.42));
          tmpC.lerp(C_ROCK, sstep(h, 120, 180) * 0.7);
          tmpC.lerp(C_SNOW, sstep(h, 150, 210) * sstep(ny, 0.45, 0.72));
          tmpC.lerp(C_SHORE, 1 - sstep(h, -24, -13));
          tmpC.lerp(C_GRAVEL, 1 - sstep(d, 8, 13));
          tmpC.multiplyScalar(0.82 + 0.32 * vnoise(xl * 0.35, t * 0.35));
          col[k] = tmpC.r;
          col[k + 1] = tmpC.g;
          col[k + 2] = tmpC.b;
        }
      }
      c.tGeo.attributes.color.needsUpdate = true;

      // road + guardrails
      const rp = c.rGeo.attributes.position.array;
      const ruv = c.rGeo.attributes.uv.array;
      const gp = c.gGeo.attributes.position.array;
      for (let j = 0; j <= SZ; j++) {
        const lz = (-CHUNK_LEN * j) / SZ;
        const t = rowT[j];
        const cx = curve(t);
        rp.set([cx - 6, 0.02, lz, cx + 6, 0.02, lz], j * 6);
        ruv.set([0, t / ROAD_TILE, 1, t / ROAD_TILE], j * 4);
        gp.set([cx - 6.8, 0.4, lz, cx - 6.8, 0.95, lz, cx + 6.8, 0.4, lz, cx + 6.8, 0.95, lz], j * 12);
      }
      c.rGeo.attributes.position.needsUpdate = true;
      c.rGeo.attributes.uv.needsUpdate = true;
      c.gGeo.attributes.position.needsUpdate = true;

      // guardrail posts
      let pi = 0;
      for (let p = 0; p < CHUNK_LEN / 4; p++) {
        const lz = -p * 4 - 2;
        const t = -(z0 + lz) + distance;
        const cx = curve(t);
        for (const s of [-1, 1]) {
          dummy.position.set(cx + s * 6.8, 0.45, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          c.posts.setMatrixAt(pi++, dummy.matrix);
        }
      }
      c.posts.instanceMatrix.needsUpdate = true;

      // pine trees
      for (let i = 0; i < TREES; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const xl = side * (10 + Math.pow(Math.random(), 1.5) * 85);
        const lz = -Math.random() * CHUNK_LEN;
        const t = -(z0 + lz) + distance;
        const h = heightAt(xl, t);
        const slope = Math.abs(heightAt(xl + 2, t) - h) / 2;
        const ok = h > -12 && h < 95 && slope < 0.85;
        const s = ok ? 1.1 + Math.random() * 1.7 : 0;
        dummy.position.set(curve(t) + xl, h - 0.2, lz);
        dummy.rotation.set(0, Math.random() * 6.28, 0);
        dummy.scale.set(s, s * (0.9 + Math.random() * 0.4), s);
        dummy.updateMatrix();
        c.treesA.setMatrixAt(i, dummy.matrix);
        c.treesB.setMatrixAt(i, dummy.matrix);
      }
      c.treesA.instanceMatrix.needsUpdate = true;
      c.treesB.instanceMatrix.needsUpdate = true;

      // roadside rocks
      for (let i = 0; i < ROCKS; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const xl = side * (8 + Math.random() * 35);
        const lz = -Math.random() * CHUNK_LEN;
        const t = -(z0 + lz) + distance;
        const h = heightAt(xl, t);
        const s = 0.5 + Math.random() * 2;
        dummy.position.set(curve(t) + xl, h + s * 0.2, lz);
        dummy.rotation.set(Math.random(), Math.random() * 6.28, Math.random() * 0.5);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        c.rocks.setMatrixAt(i, dummy.matrix);
      }
      c.rocks.instanceMatrix.needsUpdate = true;
    }

    const chunks = [];
    for (let i = 0; i < NCH; i++) {
      const c = createChunk();
      c.group.position.z = 60 - i * CHUNK_LEN;
      chunks.push(c);
    }

    // ---------- PLAYER CAR ----------
    const car = new THREE.Group();
    scene.add(car);

    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.65, 2.5),
      new THREE.MeshStandardMaterial({ color: "#d63a1f", roughness: 0.4, metalness: 0.4 })
    );
    placeholder.position.y = 0.55;
    placeholder.castShadow = true;
    car.add(placeholder);

    let modelLoaded = false;
    let modelFailed = false;
    let modelObject = null;

    new GLTFLoader().load(
      "/models/output.glb",
      (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(maxDim) || maxDim <= 0) {
          modelFailed = true;
          console.error("Invalid dimensions in output.glb");
          return;
        }
        const scale = 4.5 / maxDim;
        model.scale.setScalar(scale);
        model.position.x = -center.x * scale;
        model.position.z = -center.z * scale;
        model.position.y = -box.min.y * scale + 0.04;
        model.rotation.y = Math.PI;
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            if (o.material) o.material.envMapIntensity = 1.1;
          }
        });
        car.add(model);
        modelObject = model;
        modelLoaded = true;
        placeholder.visible = false;
      },
      undefined,
      (error) => {
        modelFailed = true;
        console.error("Could not load /models/output.glb:", error);
      }
    );

    // ---------- COLLECTIBLES + OBSTACLES (live inside the curving track) ----------
    const random = makeRng(2718);

    const rings = [];
    const ringMat = new THREE.MeshStandardMaterial({
      color: "#ffc233",
      emissive: "#ff9a00",
      emissiveIntensity: 0.6,
      metalness: 0.6,
      roughness: 0.3
    });
    for (let i = 0; i < 14; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.09, 12, 32), ringMat);
      ring.position.set(0, 1.15, -12 - i * 12);
      ring.userData.lane = (random() - 0.5) * 7;
      ring.userData.collected = false;
      ring.castShadow = true;
      track.add(ring);
      rings.push(ring);
    }

    const barrierTex = canvasTex(
      256,
      64,
      (g, w, h) => {
        g.fillStyle = "#f4f4f0";
        g.fillRect(0, 0, w, h);
        g.fillStyle = "#e8541a";
        for (let x = -h; x < w + h; x += 64) {
          g.beginPath();
          g.moveTo(x, h);
          g.lineTo(x + 32, h);
          g.lineTo(x + 32 + h, 0);
          g.lineTo(x + h, 0);
          g.fill();
        }
      },
      { repeat: false }
    );
    const barrierMat = new THREE.MeshStandardMaterial({ map: barrierTex, roughness: 0.6 });

    const obstacles = [];
    for (let i = 0; i < 9; i++) {
      const o = new THREE.Group();
      if (i % 2 === 0) {
        const r1 = new THREE.Mesh(rockGeo, rockMat);
        r1.scale.set(1.25, 1.1, 1.1);
        r1.position.y = 0.7;
        r1.rotation.y = i;
        r1.castShadow = true;
        const r2 = new THREE.Mesh(rockGeo, rockMat);
        r2.scale.set(0.7, 0.6, 0.65);
        r2.position.set(0.9, 0.35, 0.3);
        r2.castShadow = true;
        o.add(r1, r2);
        o.userData.hw = 1.45;
      } else {
        const board = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 0.18), barrierMat);
        board.position.y = 0.85;
        board.castShadow = true;
        o.add(board);
        for (const sx of [-0.9, 0.9]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.5), postMat);
          leg.position.set(sx, 0.45, 0);
          leg.castShadow = true;
          o.add(leg);
        }
        o.userData.hw = 1.7;
      }
      o.position.set(0, 0, -32 - i * 24);
      o.userData.lane = (random() - 0.5) * 7.4;
      o.userData.hit = false;
      track.add(o);
      obstacles.push(o);
    }

    // ---------- POST FX (very soft sun haze only) ----------
    const rt = new THREE.WebGLRenderTarget(W() * PR, H() * PR, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(PR);
    composer.setSize(W(), H());
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), 0.16, 0.5, 0.95);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // ---------- HUD ----------
    const hud = document.createElement("div");
    hud.className = "game-hud";
    hud.innerHTML = `
      <div class="hud-card">
        <small>SPEED</small>
        <strong id="speed">000</strong>
        <small>KM/H</small>
      </div>

      <div class="hud-card hud-brand">
        <small>ALPINE PASS // MORNING RUN</small>
        <strong>SKETCH<span>2</span>SPEED</strong>
        <small>VI3W ASSET EXPERIMENT</small>
      </div>

      <div class="hud-card">
        <small>SCORE</small>
        <strong id="score">0000</strong>
        <small>POINTS</small>
      </div>

      <div class="hud-card">
        <small>HULL</small>
        <strong id="health">100%</strong>
        <div class="meter"><div id="health-fill"></div></div>
      </div>

      <div class="hud-card">
        <small>NITRO</small>
        <strong id="nitro">100%</strong>
        <div class="meter nitro-meter"><div id="nitro-fill"></div></div>
      </div>
    `;
    mount.appendChild(hud);

    const speedEl = hud.querySelector("#speed");
    const scoreEl = hud.querySelector("#score");
    const healthEl = hud.querySelector("#health");
    const nitroEl = hud.querySelector("#nitro");
    const healthFill = hud.querySelector("#health-fill");
    const nitroFill = hud.querySelector("#nitro-fill");

    // ---------- START / GAME OVER OVERLAY ----------
    const overlay = document.createElement("div");
    overlay.className = "game-intro";
    overlay.innerHTML = `
      <div class="intro-panel">
        <span class="eyebrow">VI3W ASSET LAB / EXPERIMENT 001</span>
        <h1 id="overlay-title">SKETCH<span>2</span>SPEED</h1>
        <p id="overlay-description">
          One generated model. A whole mountain pass at sunrise.
        </p>

        <div class="intro-tags">
          <span>ALPINE PASS</span>
          <span>SUNNY MORNING</span>
          <span>NITRO ENABLED</span>
        </div>

        <button id="start-game">START THE CLIMB ↗</button>

        <small>WASD / ARROW KEYS TO DRIVE</small>
        <small>HOLD SPACE FOR NITRO · AVOID ROCKS AND BARRIERS</small>
        <small id="model-message">Loading your VI3W vehicle...</small>
      </div>
    `;
    mount.appendChild(overlay);

    const overlayTitle = overlay.querySelector("#overlay-title");
    const overlayDescription = overlay.querySelector("#overlay-description");
    const startButton = overlay.querySelector("#start-game");
    const modelMessage = overlay.querySelector("#model-message");

    const restartButton = document.createElement("button");
    restartButton.className = "restart-button";
    restartButton.textContent = "↻ RESTART RACE";
    restartButton.style.display = "none";
    mount.appendChild(restartButton);

    // ---------- GAME STATE ----------
    const keys = new Set();
    let started = false;
    let gameOver = false;
    let score = 0;
    let health = 100;
    let nitro = 100;
    let speed = 0;
    let distance = 0;
    let invulnerable = 0;
    let collisionFlash = 0;
    let animationId;
    let ringRespawnTimers = [];

    const placeObstacle = (o, z) => {
      o.position.z = z;
      o.userData.lane = (random() - 0.5) * 7.4;
      o.userData.hit = false;
    };
    const placeRing = (r, z) => {
      r.position.z = z;
      r.userData.lane = (random() - 0.5) * 7;
    };
    const syncObjects = () => {
      rings.forEach((r) => (r.position.x = curve(-r.position.z + distance) + r.userData.lane));
      obstacles.forEach((o) => (o.position.x = curve(-o.position.z + distance) + o.userData.lane));
      track.position.x = -curve(distance);
    };

    function showStartScreen() {
      started = false;
      gameOver = false;
      overlayTitle.innerHTML = "SKETCH<span>2</span>SPEED";
      overlayDescription.textContent = "One generated model. A whole mountain pass at sunrise.";
      startButton.textContent = "START THE CLIMB ↗";
      overlay.classList.remove("hidden");
      restartButton.style.display = "none";
    }

    function startRace() {
      if (modelFailed) {
        modelMessage.textContent = "Car model failed to load. Check public/models/output.glb.";
        return;
      }
      if (!modelLoaded) {
        modelMessage.textContent = "Please wait for the car to load.";
        return;
      }
      started = true;
      gameOver = false;
      overlay.classList.add("hidden");
      restartButton.style.display = "none";
      keys.clear();
    }

    function finishRace() {
      started = false;
      gameOver = true;
      speed = 0;
      keys.clear();
      overlayTitle.innerHTML = "RACE <span>OVER</span>";
      overlayDescription.textContent = `Final score: ${score} points · Distance: ${Math.floor(distance)} m`;
      startButton.textContent = "TRY AGAIN ↗";
      overlay.classList.remove("hidden");
      restartButton.style.display = "block";
    }

    function resetRace() {
      ringRespawnTimers.forEach((t) => window.clearTimeout(t));
      ringRespawnTimers = [];
      score = 0;
      health = 100;
      nitro = 100;
      speed = 0;
      distance = 0;
      invulnerable = 0;
      collisionFlash = 0;
      car.position.set(0, 0, 0);
      car.rotation.set(0, 0, 0);

      rings.forEach((r, i) => {
        r.userData.collected = false;
        r.visible = true;
        placeRing(r, -12 - i * 12);
      });
      obstacles.forEach((o, i) => placeObstacle(o, -32 - i * 24));
      chunks.forEach((c, i) => {
        c.group.position.z = 60 - i * CHUNK_LEN;
        buildChunk(c, distance);
      });
      syncObjects();

      started = false;
      gameOver = false;
      camera.position.set(0, 4.2, 9.5);
      showStartScreen();
      updateHUD();
    }

    function updateHUD() {
      speedEl.textContent = String(Math.round(speed * 5)).padStart(3, "0");
      scoreEl.textContent = String(score).padStart(4, "0");
      healthEl.textContent = `${Math.round(health)}%`;
      nitroEl.textContent = `${Math.round(nitro)}%`;
      healthFill.style.width = `${health}%`;
      nitroFill.style.width = `${nitro}%`;
      healthFill.style.background = health <= 30 ? "#e5342c" : "#2db36f";
      nitroFill.style.background = "#1f9bff";
    }

    startButton.addEventListener("click", () => {
      if (gameOver) resetRace();
      startRace();
    });
    restartButton.addEventListener("click", () => {
      resetRace();
      startRace();
    });

    // ---------- KEYBOARD ----------
    const onKeyDown = (event) => {
      const key = event.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(key)) event.preventDefault();
      keys.add(key);
    };
    const onKeyUp = (event) => keys.delete(event.key.toLowerCase());
    const onBlur = () => keys.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    // first build of the world
    chunks.forEach((c) => buildChunk(c, distance));
    syncObjects();

    // ---------- CAMERA ----------
    const desiredCameraPosition = new THREE.Vector3();
    const cameraLookTarget = new THREE.Vector3();

    // ---------- GAME LOOP ----------
    const clock = new THREE.Clock();

    function animate(now) {
      animationId = requestAnimationFrame(animate);

      const dt = Math.min(clock.getDelta(), 0.04);
      const time = now * 0.001;
      let dz = 0;
      let boosting = false;

      invulnerable = Math.max(0, invulnerable - dt);
      collisionFlash = Math.max(0, collisionFlash - dt);

      if (modelLoaded) modelMessage.textContent = "VI3W VEHICLE READY";
      else if (modelFailed) modelMessage.textContent = "Model failed to load. Check public/models/output.glb.";
      else modelMessage.textContent = "Loading your VI3W vehicle...";

      waterNormal.offset.x = time * 0.003;
      waterNormal.offset.y = time * 0.002;
      clouds.forEach((c, i) => {
        c.position.x += dt * (2 + (i % 4));
        if (c.position.x > 2600) c.position.x = -2600;
      });

      if (started && !gameOver) {
        const accelerating = keys.has("w") || keys.has("arrowup");
        const braking = keys.has("s") || keys.has("arrowdown");
        const left = keys.has("a") || keys.has("arrowleft");
        const right = keys.has("d") || keys.has("arrowright");
        boosting = keys.has(" ") && nitro > 0;

        if (boosting) nitro = Math.max(0, nitro - 28 * dt);
        else nitro = Math.min(100, nitro + 13 * dt);

        const targetSpeed = boosting ? 52 : accelerating ? 36 : braking ? 0 : 14;
        speed = THREE.MathUtils.damp(speed, targetSpeed, boosting ? 4 : 1.8, dt);

        dz = speed * dt;
        distance += dz;

        car.position.x = THREE.MathUtils.clamp(
          car.position.x + ((right ? 1 : 0) - (left ? 1 : 0)) * dt * (2 + speed * 0.12),
          -4.7,
          4.7
        );

        // scroll the mountain pass towards the player
        chunks.forEach((c) => {
          c.group.position.z += dz;
          if (c.group.position.z - CHUNK_LEN > 25) {
            c.group.position.z -= NCH * CHUNK_LEN;
            buildChunk(c, distance);
          }
        });

        rings.forEach((ring) => {
          ring.position.z += dz;
          ring.rotation.y += dt * 1.6;
          if (ring.position.z > 4 && !ring.userData.collected) placeRing(ring, -125 - random() * 40);
        });
        obstacles.forEach((o) => {
          o.position.z += dz;
          if (o.position.z > 5) placeObstacle(o, -135 - random() * 45);
        });
        syncObjects();

        // collect rings
        rings.forEach((ring) => {
          const wx = ring.position.x + track.position.x;
          if (
            !ring.userData.collected &&
            Math.abs(ring.position.z - car.position.z) < 1.6 &&
            Math.abs(wx - car.position.x) < 1.3
          ) {
            ring.userData.collected = true;
            ring.visible = false;
            score += 100;
            const timer = window.setTimeout(() => {
              placeRing(ring, -125 - random() * 40);
              ring.userData.collected = false;
              ring.visible = true;
            }, 900);
            ringRespawnTimers.push(timer);
          }
        });

        // collisions
        obstacles.forEach((o) => {
          const wx = o.position.x + track.position.x;
          if (
            invulnerable <= 0 &&
            !o.userData.hit &&
            Math.abs(o.position.z - car.position.z) < 1.55 &&
            Math.abs(wx - car.position.x) < o.userData.hw
          ) {
            o.userData.hit = true;
            health = Math.max(0, health - 25);
            speed *= 0.35;
            invulnerable = 1.25;
            collisionFlash = 0.35;
            placeObstacle(o, -135 - random() * 45);
            syncObjects();
            if (health <= 0) {
              updateHUD();
              finishRace();
            }
          }
        });

        updateHUD();
      } else {
        syncObjects();
      }

      // car follows the road's heading, leans when steering
      const steerLeft = keys.has("a") || keys.has("arrowleft");
      const steerRight = keys.has("d") || keys.has("arrowright");
      car.rotation.y = THREE.MathUtils.damp(car.rotation.y, -Math.atan(dcurve(distance)) * 0.9, 6, dt);
      car.rotation.z = THREE.MathUtils.damp(car.rotation.z, steerLeft ? 0.07 : steerRight ? -0.07 : 0, 4, dt);
      if (modelObject) {
        modelObject.rotation.y = Math.PI + (steerLeft ? 0.05 : 0) - (steerRight ? 0.05 : 0);
      }

      // chase camera, looks into the bend
      desiredCameraPosition.set(car.position.x * 0.58, boosting ? 4.55 : 4.2, 9.5);
      camera.position.lerp(desiredCameraPosition, 1 - Math.exp(-3.2 * dt));
      const shake = collisionFlash * 0.5 + speed * 0.0008;
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      const bend = (curve(distance + 28) - curve(distance)) * 0.65;
      cameraLookTarget.set(car.position.x * 0.35 + bend, 0.8, -8);
      camera.lookAt(cameraLookTarget);
      camera.fov = THREE.MathUtils.damp(camera.fov, 65 + speed * 0.22 + (boosting ? 6 : 0), 4, dt);
      camera.updateProjectionMatrix();

      // sun + shadow follow the car
      sun.position.copy(SUN).multiplyScalar(160).add(car.position);
      sun.target.position.set(car.position.x, 0, -12);
      sky.position.copy(camera.position);

      if (invulnerable > 0 && modelObject) modelObject.visible = Math.floor(time * 14) % 2 === 0;
      else if (modelObject) modelObject.visible = true;
      placeholder.visible = !modelLoaded;

      composer.render();
    }

    animate(0);
    updateHUD();

    // ---------- RESIZE ----------
    const onResize = () => {
      camera.aspect = W() / H();
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
      composer.setSize(W(), H());
      bloom.setSize(W(), H());
    };
    window.addEventListener("resize", onResize);

    // ---------- CLEANUP ----------
    return () => {
      cancelAnimationFrame(animationId);
      ringRespawnTimers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);

      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      envScene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      envRT.dispose();
      pmrem.dispose();
      composer.dispose();
      rt.dispose();
      renderer.dispose();

      [hud, overlay, restartButton].forEach((el) => {
        if (el.parentNode === mount) mount.removeChild(el);
      });
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <main className="game-shell">
      <div className="game-view" ref={mountRef} />
    </main>
  );
}