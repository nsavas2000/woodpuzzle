import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ======================================================================
//  AYARLAR
// ======================================================================
const MODEL_URL = 'model3.glb';
const MODEL_SIZE = 6;                          // modelin masadaki en büyük boyutu
const K = MODEL_SIZE / 3.4;                    // oda, masa ve pafta bu orana göre ölçeklenir
const FLOOR_Y = -3.2;                          // (K ile ölçeklenen "env" grubunun içinde)
const MODEL_BASE = new THREE.Vector3(0, 0, -1.3 * K); // modelin masadaki taban merkezi
const SNAP = MODEL_SIZE * 0.12;                // yapışma mesafesi
// Model, sahne YÜKSEKLİĞİNİN yaklaşık bu kadarını kaplar (0.5 küçük, 0.85 çok büyük).
// Kalan alt şerit parça paftası olur. Modeli büyütmek için bunu artır.
const MODEL_SCREEN_H = 0.68;
const QUEUE_SIZE = 4;          // masada aynı anda kaç parça dursun
const MAT_TOP = 0.07 * K;                      // pafta yüzeyinin yüksekliği

// Oyun bitince dönecek parçalar (isim içinde geçmesi yeterli, büyük/küçük harf fark etmez)
const SPIN_PARTS = ['parca_10', 'parca_11', 'parca_12', 'parca_13'];
const SPIN_AXIS = {};                          // gerekirse eksen belirt: { parca_12: 'z' }  (x, y veya z)
const SPIN_SPEED = 7;                          // radyan/sn

const COLOR_ORANGE = new THREE.Color(0xff9a24);
const COLOR_PINK = new THREE.Color(0xff6fae);
const DEFAULT_HINT = 'Pembe parçayı yerine sürükle • Modeli çevirmek için boşluğa sürükle';

const V3 = THREE.Vector3;
const rad = THREE.MathUtils.degToRad;

// ======================================================================
//  SAHNE (kamera sabit, sadece model döner)
// ======================================================================
const stage = document.getElementById('stage');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9d8ff);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const canvas = renderer.domElement;
stage.prepend(canvas);
const camTarget = new V3();

// Işıklar
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c8f5, 1.5));
scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const sun = new THREE.DirectionalLight(0xfff0d8, 1.7);
sun.position.set(2.5 * K, 12 * K, 4 * K);
sun.target.position.set(0, 0, 1 * K);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -9 * K, right: 9 * K, top: 8 * K, bottom: -8 * K, near: 1, far: 32 * K });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02 * K;
scene.add(sun, sun.target);

// Oda + masa (ölçek K)
const env = new THREE.Group();
env.scale.setScalar(K);
scene.add(env);

// Dönen grup: hayalet model + yerleşen parçalar bunun çocuğu (görünmez, sadece döner)
const turntable = new THREE.Group();
turntable.position.copy(MODEL_BASE);
scene.add(turntable);

// ======================================================================
//  YARDIMCI FONKSİYONLAR
// ======================================================================
function canvasTexture(size, draw, repX = 1, repY = 1, height = size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  draw(c.getContext('2d'), size, height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repX, repY);
  t.anisotropy = 4;
  return t;
}

function roundedSlab(w, d, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2);
  return g;
}

function box(w, h, d, color, x, y, z, parent, cast = true) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7 })
  );
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// ======================================================================
//  ODA
// ======================================================================
function seeded(seed) {
  let v = seed;
  return () => (v = (v * 16807) % 2147483647) / 2147483647;
}

function drawGear(g, x, y, r, teeth = 10) {
  g.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.82 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.moveTo(x + r * 0.36, y);
  g.arc(x, y, r * 0.36, 0, Math.PI * 2, true); // ortada delik
  g.fill('evenodd');
}

function buildRoom() {
  // ---- Zemin: açık renk, uzun ahşap parke ----
  const floorTex = canvasTexture(512, (g) => {
    const cols = ['#ecc88f', '#f2d3a0', '#e4bb7e', '#efcb94'];
    const rnd = seeded(11);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = cols[i % 4];
      g.fillRect(0, i * 64, 512, 64);
      g.strokeStyle = 'rgba(150,100,40,0.16)';
      g.lineWidth = 1.5;
      for (let j = 0; j < 4; j++) {
        const y = i * 64 + 8 + rnd() * 48;
        g.beginPath(); g.moveTo(0, y); g.lineTo(512, y + rnd() * 3 - 1.5); g.stroke();
      }
      g.fillStyle = 'rgba(120,75,25,0.35)';
      g.fillRect(0, i * 64, 512, 3);
      g.fillRect(rnd() * 512, i * 64, 3, 64);
    }
  }, 14, 14);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  env.add(floor);

  // ---- Duvar: gökyüzü mavisi, dişli ve devre desenli (robotik teması) ----
  const wallTex = canvasTexture(640, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#b8e0ff');
    gr.addColorStop(1, '#8fc8fb');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);

    const rnd = seeded(7);
    g.fillStyle = 'rgba(255,255,255,0.24)';
    [[120, 250, 70, 10], [470, 190, 95, 12], [330, 520, 62, 9], [560, 560, 80, 11], [90, 600, 48, 8], [250, 120, 40, 8]]
      .forEach(([x, y, r, t]) => drawGear(g, x, y, r, t));

    // devre çizgileri
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 6;
    g.lineCap = g.lineJoin = 'round';
    const trace = (pts) => {
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      pts.slice(1).forEach(([x, y]) => g.lineTo(x, y));
      g.stroke();
      const [ex, ey] = pts[pts.length - 1];
      g.beginPath(); g.arc(ex, ey, 11, 0, 7); g.fill();
    };
    trace([[30, 400], [210, 400], [250, 440], [400, 440]]);
    trace([[610, 340], [470, 340], [430, 300], [330, 300]]);
    trace([[60, 700], [180, 700], [220, 660], [360, 660]]);

    // küçük yıldız/noktalar
    g.fillStyle = 'rgba(255,255,255,0.45)';
    for (let i = 0; i < 28; i++) {
      g.beginPath(); g.arc(rnd() * w, rnd() * h, 3 + rnd() * 5, 0, 7); g.fill();
    }
  }, 6, 1, 768);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(90, 18), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1 }));
  wall.position.set(0, FLOOR_Y + 9, -11);
  env.add(wall);
  box(90, 0.8, 0.3, 0xffffff, 0, FLOOR_Y + 0.4, -10.85, env, false);   // süpürgelik
  box(90, 0.12, 0.32, 0xffd166, 0, FLOOR_Y + 0.86, -10.84, env, false); // sarı şerit

  // ---- Halı: yumuşak mercan renkli, krem kenarlı dikdörtgen ----
  const rugTex = canvasTexture(768, (g, w, h) => {
    const rr = (x, y, ww, hh, r, c) => {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + ww, y, x + ww, y + hh, r);
      g.arcTo(x + ww, y + hh, x, y + hh, r);
      g.arcTo(x, y + hh, x, y, r);
      g.arcTo(x, y, x + ww, y, r);
      g.closePath();
      g.fillStyle = c; g.fill();
    };
    rr(6, 6, w - 12, h - 12, 70, '#fff1dc');
    rr(34, 34, w - 68, h - 68, 52, '#ff8fa3');
    rr(70, 70, w - 140, h - 140, 36, '#ff7b93');
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let y = 120; y < h - 100; y += 64) {
      for (let x = 120 + ((y / 64) % 2) * 32; x < w - 100; x += 64) {
        g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill();
      }
    }
  }, 1, 1, 512);
  rugTex.wrapS = rugTex.wrapT = THREE.ClampToEdgeWrapping;
  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 16),
    new THREE.MeshStandardMaterial({ map: rugTex, transparent: true, roughness: 1 })
  );
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, FLOOR_Y + 0.02, 1);
  rug.receiveShadow = true;
  env.add(rug);
}

// ======================================================================
//  MASA
// ======================================================================
function buildDesk() {
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x3f63d8, roughness: 0.55 });
  const desk = new THREE.Mesh(new RoundedBoxGeometry(11.4, 0.35, 9.0, 4, 0.12), deskMat);
  desk.position.set(0, -0.175, 0.9);
  desk.receiveShadow = true;
  desk.castShadow = true;
  env.add(desk);

  const legH = -FLOOR_Y - 0.35;
  [[-5.3, -3.2], [5.3, -3.2], [-5.3, 5.0], [5.3, 5.0]].forEach(([x, z]) => {
    box(0.4, legH, 0.4, 0x2f4fb8, x, -0.35 - legH / 2, z, env);
  });
}

// ======================================================================
//  SAKSIDA KÜÇÜK ÇİÇEK (eski lambanın yerinde, masanın sağ arkası)
// ======================================================================
let flowerSway = null;

function buildFlower() {
  const g = new THREE.Group();
  g.position.set(3.3, 0, -1.6); // env birimi: eski lambanın durduğu yer (masanın sağ arka tarafı)
  g.scale.setScalar(1.25);
  const mat = (c, r = 0.6) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const part = (geo, m, x, y, z, parent = g) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    o.receiveShadow = true;
    parent.add(o);
    return o;
  };

  // Saksı + toprak
  part(new THREE.CylinderGeometry(0.34, 0.25, 0.42, 24), mat(0xe0764a, 0.8), 0, 0.21, 0);
  part(new THREE.CylinderGeometry(0.39, 0.39, 0.09, 24), mat(0xea8a5c, 0.8), 0, 0.455, 0);
  part(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 24), mat(0x5a3a22, 1), 0, 0.505, 0);

  // Gövde + yapraklar + çiçek başı (hafifçe sallanır)
  const sway = new THREE.Group();
  sway.position.set(0, 0.51, 0);
  g.add(sway);
  part(new THREE.CylinderGeometry(0.035, 0.045, 0.78, 10), mat(0x3fae4f), 0, 0.39, 0, sway);
  [[-1, 0.26], [1, 0.42]].forEach(([side, y]) => {
    const leaf = part(new THREE.SphereGeometry(1, 14, 10), mat(0x57c965), side * 0.14, y, 0, sway);
    leaf.scale.set(0.2, 0.06, 0.1);
    leaf.rotation.z = side * 0.45;
  });

  const head = new THREE.Group();
  head.position.set(0, 0.82, 0);
  head.rotation.x = -rad(34); // kameraya doğru dönük
  sway.add(head);
  part(new THREE.SphereGeometry(0.1, 16, 12), mat(0xffd166, 0.5), 0, 0, 0.02, head);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = part(new THREE.SphereGeometry(1, 12, 8), mat(0xff7eb3, 0.5), Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0, head);
    p.scale.set(0.075, 0.13, 0.035);
    p.rotation.z = a - Math.PI / 2;
  }

  env.add(g);
  flowerSway = sway;
}

// ======================================================================
//  ÇİZİM PAFTASI (PARÇA TEPSİSİ)
// ======================================================================
const gridTex = canvasTexture(64, (g, s) => {
  g.fillStyle = '#1c3c9c'; g.fillRect(0, 0, s, s);
  g.strokeStyle = '#3f68d6'; g.lineWidth = 3;
  g.strokeRect(0, 0, s, s);
}, 2 / K, 2 / K); // UV dünya birimi: kareler ~0.5*K
const matGrid = new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.85 });
const matBorder = new THREE.MeshStandardMaterial({ color: 0x2b55cf, roughness: 0.6 });
let trayGroup = null;

function buildTray(cfg) {
  if (trayGroup) {
    scene.remove(trayGroup);
    trayGroup.traverse((o) => o.geometry && o.geometry.dispose());
  }
  trayGroup = new THREE.Group();
  const border = new THREE.Mesh(roundedSlab(cfg.W + 0.4 * K, cfg.D + 0.4 * K, 0.05 * K, 0.35 * K), matBorder);
  const inner = new THREE.Mesh(roundedSlab(cfg.W, cfg.D, 0.03 * K, 0.25 * K), matGrid);
  inner.position.y = 0.04 * K;
  border.receiveShadow = inner.receiveShadow = true;
  trayGroup.add(border, inner);
  trayGroup.position.set(0, 0, cfg.cz);
  scene.add(trayGroup);
}

buildRoom();
buildDesk();
buildFlower();

// Modelin altında yumuşak "temas gölgesi" (model nereye oturuyor belli olsun)
const blobTex = canvasTexture(128, (g, sz) => {
  const gr = g.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.65)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, sz, sz);
});
blobTex.wrapS = blobTex.wrapT = THREE.ClampToEdgeWrapping;
const blob = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.28, depthWrite: false })
);
blob.rotation.x = -Math.PI / 2;
blob.position.set(MODEL_BASE.x, 0.02 * K, MODEL_BASE.z);
blob.scale.setScalar(MODEL_SIZE * 0.9);
scene.add(blob);

// ======================================================================
//  PARLAMA EFEKTLERİ (sıradaki parça)
// ======================================================================
const glowTex = canvasTexture(128, (g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,90,170,1)');
  gr.addColorStop(0.5, 'rgba(255,90,170,0.4)');
  gr.addColorStop(1, 'rgba(255,90,170,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
});
glowTex.wrapS = glowTex.wrapT = THREE.ClampToEdgeWrapping;
const trayGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
);
trayGlow.rotation.x = -Math.PI / 2;
trayGlow.visible = false;
scene.add(trayGlow);

const shellMat = new THREE.MeshBasicMaterial({
  color: 0xff4fa0, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
});

const arrow = new THREE.Group();
const arrowMat = new THREE.MeshStandardMaterial({ color: 0xff4fa0, emissive: 0xff2d8a, emissiveIntensity: 0.5, roughness: 0.4 });
const arrowCone = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.5, 20), arrowMat);
arrowCone.rotation.x = Math.PI;
arrowCone.position.y = 0.25;
const arrowStem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 16), arrowMat);
arrowStem.position.y = 0.7;
arrow.add(arrowCone, arrowStem);
arrow.visible = false;
arrow.scale.setScalar(0.6 * K);
scene.add(arrow);

// ======================================================================
//  DURUM
// ======================================================================
const countEl = document.getElementById('count');
const barEl = document.getElementById('bar');
const hintEl = document.getElementById('hint');
const toastEl = document.getElementById('toast');

const pieces = [];
let S = 1;
let dragging = null;
let rotating = null;
let spinVel = 0;
let autoSpin = false;
let finished = false;
let loaded = false;
const dragPoint = new V3();
const dragPlane = new THREE.Plane();
const camRight = new V3(), camUp = new V3(), camBack = new V3();
const ndc = new THREE.Vector2();
const pointerPx = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();
const IDENT_Q = new THREE.Quaternion();

let hintTimer = null;
function showHint(text, ms = 2200) {
  hintEl.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintEl.textContent = finished ? 'Modeli çevirerek her açıdan inceleyebilirsin.' : DEFAULT_HINT;
  }, ms);
}

// ======================================================================
//  SES
// ======================================================================
let audioCtx = null;
function beep(freq, dur = 0.12, type = 'triangle', vol = 0.3, endFreq = null, delay = 0) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur * 0.8);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const sfx = {
  pop: () => beep(520, 0.09, 'sine', 0.25, 780),
  knock: () => beep(380, 0.13, 'triangle', 0.4, 110),
  nope: () => beep(210, 0.16, 'square', 0.1, 150),
  win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.35, 'triangle', 0.3, null, i * 0.12)),
};

// ======================================================================
//  KONFETİ
// ======================================================================
const N = 260;
const cPos = new Float32Array(N * 3), cCol = new Float32Array(N * 3), cVel = new Float32Array(N * 3), cLife = new Float32Array(N);
for (let i = 0; i < N; i++) cPos[i * 3 + 1] = -100;
const cGeo = new THREE.BufferGeometry();
cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
cGeo.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
const dotTex = canvasTexture(64, (g) => { g.beginPath(); g.arc(32, 32, 30, 0, 7); g.fillStyle = '#fff'; g.fill(); });
const confetti = new THREE.Points(cGeo, new THREE.PointsMaterial({
  size: 0.17 * K, map: dotTex, vertexColors: true, transparent: true, alphaTest: 0.3, depthWrite: false,
}));
confetti.frustumCulled = false;
scene.add(confetti);
const palette = [0xff9a24, 0xff7eb3, 0xffd166, 0x4cc9f0, 0x80ed99].map((c) => new THREE.Color(c));
let cNext = 0;

function burst(pos, count, power) {
  for (let k = 0; k < count; k++) {
    const i = cNext; cNext = (cNext + 1) % N;
    const a = Math.random() * Math.PI * 2;
    const up = Math.random();
    const sp = power * K * (0.4 + Math.random());
    cPos[i * 3] = pos.x; cPos[i * 3 + 1] = pos.y; cPos[i * 3 + 2] = pos.z;
    cVel[i * 3] = Math.cos(a) * sp * (1 - up * 0.4);
    cVel[i * 3 + 1] = sp * (0.6 + up);
    cVel[i * 3 + 2] = Math.sin(a) * sp * (1 - up * 0.4);
    cLife[i] = 1.2 + Math.random() * 0.9;
    const c = palette[(Math.random() * palette.length) | 0];
    cCol[i * 3] = c.r; cCol[i * 3 + 1] = c.g; cCol[i * 3 + 2] = c.b;
  }
  cGeo.attributes.color.needsUpdate = true;
}

function updateConfetti(dt) {
  let any = false;
  for (let i = 0; i < N; i++) {
    if (cLife[i] <= 0) continue;
    any = true;
    cLife[i] -= dt;
    cVel[i * 3 + 1] -= 9 * K * dt;
    cPos[i * 3] += cVel[i * 3] * dt;
    cPos[i * 3 + 1] += cVel[i * 3 + 1] * dt;
    cPos[i * 3 + 2] += cVel[i * 3 + 2] * dt;
    if (cLife[i] <= 0) cPos[i * 3 + 1] = -100;
  }
  if (any) cGeo.attributes.position.needsUpdate = true;
}

// ======================================================================
//  KAMERA (sabit): önce MODEL ekrana sığdırılır, kalan alt şerit pafta olur
// ======================================================================
const CAM_ELEV = rad(34);
const CAM_DIR = new V3(0, Math.sin(CAM_ELEV), Math.cos(CAM_ELEV));
const CAM_UP = new V3(0, Math.cos(CAM_ELEV), -Math.sin(CAM_ELEV));
const DESK_PLANE = new THREE.Plane(new V3(0, 1, 0), 0);
const rayCaster2 = new THREE.Raycaster();

let modelHalf = MODEL_SIZE * 0.35;   // modelin taban yarıçapı (yüklenince gerçek değer yazılır)
let modelHeight = MODEL_SIZE;        // modelin yüksekliği
let trayCfg = { W: 8 * K, D: 2.5 * K, cz: 2.4 * K }; // paftanın iç ölçüsü (fitCamera hesaplar)

function projectExtents(pts) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const q = p.clone().project(camera);
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return { x0, x1, y0, y1 };
}

function fitCamera() {
  const tanV = Math.tan(rad(camera.fov / 2));

  // Modelin kapladığı kutu (dönünce taşmasın diye dairesel taban yarıçapı kullanılır)
  const pts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, modelHeight]) {
    pts.push(new V3(sx * modelHalf, y, MODEL_BASE.z + sz * modelHalf));
  }

  const T = new V3(0, modelHeight / 2, MODEL_BASE.z);
  const TOP = 0.80;                       // modelin üst sınırı (üstte ilerleme çubuğuna yer)
  const targetH = MODEL_SCREEN_H * 2;     // ndc'de hedef yükseklik (ekran = 2)
  const maxW = 1.7;                       // genişlikte en fazla (dar ekranlarda sınırlar)
  let dist = MODEL_SIZE * 3;

  const place = () => {
    camera.position.copy(T).addScaledVector(CAM_DIR, dist);
    camera.lookAt(T);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  for (let i = 0; i < 16; i++) {
    place();
    const e = projectExtents(pts);
    const scale = Math.max((e.y1 - e.y0) / targetH, (e.x1 - e.x0) / maxW);
    dist = Math.max(1, dist * Math.pow(scale, 0.9));
    T.addScaledVector(CAM_UP, -(TOP - e.y1) * dist * tanV);
  }
  place();
  camTarget.copy(T);
  const ext = projectExtents(pts);

  // Modelin altında kalan ekran şeridini masa düzlemine yansıt: pafta burası olur
  const stripTop = ext.y0 - 0.06;
  const stripBot = -0.96;
  const hit = (x, y) => {
    rayCaster2.setFromCamera(new THREE.Vector2(x, y), camera);
    const out = new V3();
    return rayCaster2.ray.intersectPlane(DESK_PLANE, out) ? out : null;
  };
  const bl = hit(-0.95, stripBot), br = hit(0.95, stripBot);
  const tl = hit(-0.95, stripTop), tr = hit(0.95, stripTop);
  if (bl && br && tl && tr && stripTop - stripBot > 0.15) {
    const wOut = Math.min(br.x - bl.x, tr.x - tl.x);
    const zFront = (bl.z + br.z) / 2, zBack = (tl.z + tr.z) / 2;
    trayCfg = {
      W: Math.max(2 * K, wOut - 0.4 * K),
      D: Math.max(1.2 * K, zFront - zBack - 0.4 * K),
      cz: (zFront + zBack) / 2,
    };
  }
}

function resize() {
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  fitCamera();
  applyLayout();
}
new ResizeObserver(resize).observe(stage);

// ======================================================================
//  TEPSİDE PARÇA DİZİLİMİ
// ======================================================================
const slots = new Array(QUEUE_SIZE).fill(null); // masadaki yuvalar
let slotGeom = null;

function applyLayout() {
  const cfg = trayCfg;
  buildTray(cfg);

  // Geniş şeritte tek sıra, dar (telefon) alanda 2x2 ızgara
  const pad = 0.12 * K;
  const availW = cfg.W - pad * 2, availH = cfg.D - pad * 2;
  const cols = availW / availH >= 3 ? QUEUE_SIZE : 2;
  const rows = Math.ceil(QUEUE_SIZE / cols);
  slotGeom = { cols, cellW: availW / cols, cellH: availH / rows, x0: -availW / 2, z0: cfg.cz - availH / 2 };
  pieces.forEach((p) => { if (p.slot >= 0) fitToSlot(p, p.slot); });
}

// Parçayı yuvasına sığacak kadar büyüt (en fazla gerçek boyutu)
function fitToSlot(p, i) {
  const g = slotGeom;
  const col = i % g.cols, row = Math.floor(i / g.cols);
  const w = g.cellW - 0.2 * K, h = g.cellH - 0.1 * K;
  const f = Math.min(1, w / (p.dimL * S), h / (p.dimM * S));
  p.trayScale = S * f;
  p.trayPos.set(g.x0 + g.cellW * (col + 0.5), MAT_TOP + (p.dimT * S * f) / 2, g.z0 + g.cellH * (row + 0.5));
}

// Sıra her zaman soldan başlar: ilk parça 0. yuvada, biri yerleşince diğerleri sola kayar
function refillSlots() {
  const anyPlaced = pieces.some((p) => p.placed);
  const queue = pieces.filter((p) => !p.placed).slice(0, QUEUE_SIZE);
  pieces.forEach((p) => { if (!queue.includes(p)) p.slot = -1; });
  slots.fill(null);
  queue.forEach((p, i) => {
    const isNew = p.slot < 0;
    p.slot = i;
    slots[i] = p;
    fitToSlot(p, i);               // trayPos değişir, ana döngü parçayı kaydırarak götürür
    if (isNew) p.enter = anyPlaced ? 'right' : 'drop';
  });
}

// ======================================================================
//  MODEL YÜKLEME
// ======================================================================
const AXES = [new V3(1, 0, 0), new V3(0, 1, 0), new V3(0, 0, 1)];

new GLTFLoader().load(
  MODEL_URL,
  (gltf) => {
    const root = gltf.scene;
    scene.add(root);
    root.updateMatrixWorld(true);

    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    meshes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    console.log('Parçalar:', meshes.map((m) => m.name));

    const whole = new THREE.Box3();
    const temp = [];

    meshes.forEach((m) => {
      const box3 = new THREE.Box3().setFromObject(m);
      whole.union(box3);
      const center = box3.getCenter(new V3());
      const size = box3.getSize(new V3());

      const pivot = new THREE.Group();
      pivot.position.copy(center);
      scene.add(pivot);
      pivot.updateMatrixWorld(true);
      pivot.attach(m);
      m.material = new THREE.MeshStandardMaterial({ color: COLOR_ORANGE.clone(), roughness: 0.45 });
      m.castShadow = true;
      m.receiveShadow = true;

      const shell = pivot.clone(true);
      shell.traverse((o) => { if (o.isMesh) { o.material = shellMat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 2; } });
      shell.visible = false;

      const ghost = pivot.clone(true);
      const ghostMat = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.2, depthWrite: false, roughness: 0.2 });
      const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 });
      ghost.traverse((o) => {
        if (!o.isMesh) return;
        o.material = ghostMat;
        o.castShadow = true; // şeffaf modelin de masaya gölgesi düşsün
        o.renderOrder = 1;
        o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30), edgeMat));
      });

      // Tepsiye düz yatma yönelimi: en ince eksen yukarı, en uzun eksen sağa
      const sz = [size.x, size.y, size.z];
      const [l, mid, t] = [0, 1, 2].sort((a, b) => sz[b] - sz[a]);
      const s = new V3().crossVectors(AXES[l], AXES[mid]).dot(AXES[t]) >= 0 ? 1 : -1;
      const cols = [new V3(), new V3(), new V3()];
      cols[l].set(1, 0, 0);
      cols[mid].set(0, 0, -1);
      cols[t].set(0, s, 0);
      const trayQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(cols[0], cols[1], cols[2]));

      temp.push({ m, pivot, ghost, shell, ghostMat, edgeMat, center, sz, l, mid, t, trayQuat });
    });

    const wholeSize = whole.getSize(new V3());
    const wholeCenter = whole.getCenter(new V3());
    S = MODEL_SIZE / Math.max(wholeSize.x, wholeSize.y, wholeSize.z);

    temp.forEach((o) => {
      const targetLocal = new V3(
        (o.center.x - wholeCenter.x) * S,
        (o.center.y - whole.min.y) * S,
        (o.center.z - wholeCenter.z) * S
      );
      o.ghost.position.copy(targetLocal);
      o.ghost.scale.setScalar(S);
      o.shell.position.copy(targetLocal);
      o.shell.scale.setScalar(S * 1.09);
      turntable.add(o.ghost, o.shell);

      // Oyun sonunda dönecek parça mı?
      const lname = o.m.name.toLowerCase();
      const key = SPIN_PARTS.find((k) => lname.includes(k));
      const axisName = key && SPIN_AXIS[key];
      const spin = key
        ? { axis: axisName ? AXES['xyz'.indexOf(axisName)].clone() : AXES[o.t].clone(), v: 0 }
        : null;

      pieces.push({
        name: o.m.name, pivot: o.pivot, ghost: o.ghost, shell: o.shell,
        ghostMat: o.ghostMat, edgeMat: o.edgeMat, mat: o.m.material,
        targetLocal, target: new V3(), trayQuat: o.trayQuat,
        halfY: (o.sz[1] * S) / 2,
        dimL: o.sz[o.l], dimM: o.sz[o.mid], dimT: o.sz[o.t],
        trayPos: new V3(), trayScale: S,
        placed: false, arrived: false, shake: 0, spin, slot: -1, enter: false,
      });
    });

    modelHeight = wholeSize.y * S;
    blob.scale.setScalar(Math.max(1, Math.hypot(wholeSize.x, wholeSize.z) * S * 1.15));
    modelHalf = (Math.hypot(wholeSize.x, wholeSize.z) * S) / 2 * 0.9;
    console.log('Model ölçüsü (orijinal):', wholeSize.toArray().map((v) => +v.toFixed(2)), '| ölçek S =', +S.toFixed(3),
      '| sahnedeki boyut:', wholeSize.toArray().map((v) => +(v * S).toFixed(2)));

    loaded = true;
    fitCamera();
    applyLayout();

    refillSlots();
    updateInfo();
  },
  undefined,
  (err) => {
    console.error(err);
    countEl.textContent = 'Model yüklenemedi (F12 konsola bak)';
  }
);

// ======================================================================
//  OYUN MANTIĞI
// ======================================================================
const activePiece = () => pieces.find((p) => !p.placed) || null;

function updateInfo() {
  if (!pieces.length) return;
  const done = pieces.filter((p) => p.placed).length;
  countEl.textContent = finished ? 'Tamamlandı!' : `${done} / ${pieces.length}`;
  barEl.style.width = `${(done / pieces.length) * 100}%`;
}

function place(p) {
  p.placed = true;
  dragging = null;
  refillSlots();
  updateInfo();
}

function finish() {
  finished = true;
  updateInfo();
  toastEl.classList.add('show');
  hintEl.textContent = 'Modeli çevirerek her açıdan inceleyebilirsin.';
  const top = turntable.localToWorld(new V3(0, MODEL_SIZE * 0.6, 0));
  burst(top, 150, 4.5);
  setTimeout(() => burst(top, 110, 5.5), 450);
  sfx.win();
  autoSpin = true; // dönen parçalar (pervane vb.) döngüde hızlanarak dönmeye başlar
}

// ----- Dokunma / fare -----
function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  pointerPx.set(e.clientX - r.left, e.clientY - r.top);
  ndc.set((pointerPx.x / r.width) * 2 - 1, -(pointerPx.y / r.height) * 2 + 1);
}

function pickPiece() {
  const live = pieces.filter((p) => !p.placed && p.slot >= 0);
  if (!live.length) return null;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(live.map((p) => p.pivot), true);
  if (hits.length) {
    let o = hits[0].object;
    while (o) {
      const found = live.find((p) => p.pivot === o);
      if (found) return found;
      o = o.parent;
    }
  }
  const r = canvas.getBoundingClientRect();
  let best = null, bd = 44;
  for (const p of live) {
    const v = p.pivot.position.clone().project(camera);
    const d = Math.hypot((v.x * 0.5 + 0.5) * r.width - pointerPx.x, (-v.y * 0.5 + 0.5) * r.height - pointerPx.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function updateDragPoint() {
  raycaster.setFromCamera(ndc, camera);
  raycaster.ray.intersectPlane(dragPlane, dragPoint);
}

function release() {
  if (dragging) {
    const p = dragging;
    if (p.pivot.position.distanceTo(p.target) < SNAP) place(p);
    else dragging = null;
  }
  rotating = null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!loaded) return;
  setPointer(e);
  canvas.setPointerCapture(e.pointerId);
  spinVel = 0;

  const p = finished ? null : pickPiece();

  if (!p) { // boşluğa basıldı: modeli çevir
    rotating = { lastX: e.clientX };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (p !== activePiece()) {
    p.shake = 0.45;
    sfx.nope();
    showHint('Önce pembe parlayan parçayı yerleştir! 💗');
    return;
  }

  dragging = p;
  canvas.style.cursor = 'grabbing';
  sfx.pop();
  camera.matrixWorld.extractBasis(camRight, camUp, camBack);
  dragPlane.setFromNormalAndCoplanarPoint(camBack, p.target);
  updateDragPoint();
});

canvas.addEventListener('pointermove', (e) => {
  setPointer(e);
  if (dragging) {
    updateDragPoint();
  } else if (rotating) {
    const dx = e.clientX - rotating.lastX;
    rotating.lastX = e.clientX;
    turntable.rotation.y += dx * 0.012;
    spinVel = spinVel * 0.5 + dx * 0.012 * 0.5;
  } else if (loaded && !finished) {
    canvas.style.cursor = pickPiece() === activePiece() ? 'grab' : 'default';
  }
});
const endDrag = () => { release(); canvas.style.cursor = 'default'; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ======================================================================
//  ANA DÖNGÜ
// ======================================================================
resize();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const k = 1 - Math.exp(-dt * 11);
  const time = clock.elapsedTime;
  const pulse = 0.5 + 0.5 * Math.sin(time * 4.5);

  if (!rotating) {
    if (Math.abs(spinVel) > 0.0004) {
      turntable.rotation.y += spinVel * (dt * 60);
      spinVel *= Math.pow(0.92, dt * 60);
    } else if (autoSpin) {
      turntable.rotation.y += dt * 0.6;
    }
  }
  turntable.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  updateConfetti(dt);

  const active = activePiece();

  pieces.forEach((p) => {
    const shown = p.placed || p.slot >= 0;
    p.pivot.visible = shown;
    if (p.enter && !p.placed) {
      const fromRight = p.enter === 'right';
      p.enter = false;
      if (fromRight) p.pivot.position.copy(p.trayPos).add(new V3(2.5 * K, 0, 0));
      else p.pivot.position.copy(p.trayPos).add(new V3(0, (4 + Math.max(0, p.slot) * 0.6) * K, 0));
      p.pivot.quaternion.copy(p.trayQuat);
      p.pivot.scale.setScalar(p.trayScale * (fromRight ? 1 : 0.4));
    }

    if (!p.arrived && shown) {
      p.target.copy(p.targetLocal);
      turntable.localToWorld(p.target);

      let goalPos, goalScale, goalQuat;
      if (p.placed) {
        goalPos = p.target; goalScale = S; goalQuat = turntable.quaternion;
      } else if (p === dragging) {
        goalPos = dragPoint; goalScale = S; goalQuat = turntable.quaternion;
      } else {
        goalPos = p.trayPos.clone();
        goalScale = p.trayScale;
        goalQuat = p.trayQuat;
        if (p === active) goalPos.y += (0.05 + 0.07 * Math.abs(Math.sin(time * 3))) * K;
        if (p.shake > 0) { p.shake -= dt; goalPos.x += Math.sin(time * 60) * 0.06 * K * (p.shake / 0.45); }
      }

      p.pivot.position.lerp(goalPos, k);
      p.pivot.quaternion.slerp(goalQuat, k);
      p.pivot.scale.setScalar(THREE.MathUtils.lerp(p.pivot.scale.x, goalScale, k));

      if (p.placed && p.pivot.position.distanceTo(p.target) < 0.01 * K && p.pivot.quaternion.angleTo(turntable.quaternion) < 0.03) {
        turntable.attach(p.pivot);
        p.pivot.position.copy(p.targetLocal);
        p.pivot.quaternion.copy(IDENT_Q);
        p.pivot.scale.setScalar(S);
        p.arrived = true;
        p.ghost.visible = false;
        sfx.knock();
        burst(p.target, 26, 2.2);
        if (pieces.every((x) => x.arrived)) finish();
      }
    }

    // Oyun bitince pervane vb. parçalar kendi ekseninde dönmeye başlar (yavaşça hızlanır)
    if (finished && p.spin && p.arrived) {
      p.spin.v = THREE.MathUtils.lerp(p.spin.v, SPIN_SPEED, 1 - Math.exp(-dt * 1.5));
      p.pivot.rotateOnAxis(p.spin.axis, p.spin.v * dt);
    }

    // Parlama: sıradaki parça
    const isNext = p === active && !p.placed;
    p.mat.color.lerp(isNext ? COLOR_PINK : COLOR_ORANGE, 0.25);
    p.mat.emissive.setHex(isNext ? 0xff2d8a : 0x000000);
    p.mat.emissiveIntensity = isNext ? 0.12 + 0.2 * pulse : 0;
    p.shell.visible = isNext;

    if (!p.arrived) {
      let op = 0.1, eo = 0.25;
      if (isNext) {
        op = 0.3 + 0.12 * pulse; eo = 0.85;
        if (p === dragging && p.pivot.position.distanceTo(p.target) < MODEL_SIZE * 0.35) op = 0.55;
      }
      p.ghostMat.opacity = THREE.MathUtils.lerp(p.ghostMat.opacity, op, 0.25);
      p.edgeMat.opacity = THREE.MathUtils.lerp(p.edgeMat.opacity, eo, 0.25);
      p.ghostMat.color.setHex(isNext ? 0xffb8d6 : 0xbfe6ff);
      p.edgeMat.color.setHex(isNext ? 0xffeaf3 : 0xffffff);
    }
  });

  shellMat.opacity = 0.12 + 0.18 * pulse;

  if (active && !finished) {
    arrow.visible = true;
    arrow.position.copy(active.target);
    arrow.position.y += active.halfY + (0.25 + 0.08 * Math.abs(Math.sin(time * 4))) * K;
    arrow.rotation.y = time * 2;
  } else {
    arrow.visible = false;
  }

  if (active && active !== dragging && !finished) {
    trayGlow.visible = true;
    trayGlow.position.set(active.trayPos.x, MAT_TOP + 0.012 * K, active.trayPos.z);
    const size = Math.max(active.dimL, active.dimM) * active.trayScale * 1.45;
    trayGlow.scale.setScalar(size * (1 + 0.06 * pulse));
    trayGlow.material.opacity = 0.3 + 0.2 * pulse;
  } else {
    trayGlow.visible = false;
  }

  if (flowerSway) flowerSway.rotation.z = Math.sin(time * 1.4) * 0.035;

  renderer.render(scene, camera);
});