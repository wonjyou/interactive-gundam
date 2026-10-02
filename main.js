import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const { lerp, clamp } = THREE.MathUtils;
const SPACE = 0x060a18;
const touchFirst = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const BODY_PARTICLES = touchFirst || Math.min(window.innerWidth, window.innerHeight) < 520 ? 70000 : 110000;
const S = 5.5;            // model units -> world units (the suit ends up about 10 tall)

// ---------- renderer / scene ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(SPACE);
const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 900);

// Lights only matter in the full-materials look; the particle and line shaders ignore them.
scene.add(new THREE.HemisphereLight(0xdbe6ff, 0x1a2140, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.8);
sun.position.set(7, 16, 12);
const rim = new THREE.DirectionalLight(0x7f9cff, 1.6);
rim.position.set(-9, 7, -12);
scene.add(sun, rim);

// ---------- model ----------
const gltf = await new GLTFLoader().loadAsync('gundam.glb');
const model = gltf.scene;
model.updateMatrixWorld(true);
const bones = {};
let skinned = null;
model.traverse((o) => {
  bones[o.name] = o;
  if (o.isSkinnedMesh) skinned = o;
});
const skeleton = skinned.skeleton;
const boneIndex = (name) => skeleton.bones.indexOf(bones[name]);

// Every vertex in this model follows exactly one bone, so a particle only needs one bone index.
function dominantBone(geo, i) {
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) {
    const w = sw.getComponent(i, k);
    if (w > bw) { bw = w; best = si.getComponent(i, k); }
  }
  return best;
}

function pixelsOf(texture) {
  if (!texture || !texture.image) return null;
  const img = texture.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}
function texel(px, u, v, out) {
  const x = Math.min(px.w - 1, Math.floor((u - Math.floor(u)) * px.w));
  const y = Math.min(px.h - 1, Math.floor((v - Math.floor(v)) * px.h));
  const i = (y * px.w + x) * 4;
  out[0] = px.data[i] / 255; out[1] = px.data[i + 1] / 255; out[2] = px.data[i + 2] / 255;
}
const basePixels = pixelsOf(skinned.material.map), glowPixels = pixelsOf(skinned.material.emissiveMap);
const _col = [0, 0, 0], _em = [0, 0, 0];
// The model's texture colour at a UV, adjusted to read as a glowing point or line on a dark background.
function surfaceColor(u, v, out, at) {
  _col[0] = _col[1] = _col[2] = 0.8; _em[0] = _em[1] = _em[2] = 0;
  if (basePixels) texel(basePixels, u, v, _col);
  if (glowPixels) texel(glowPixels, u, v, _em);
  // Dark parts (rifle, joints) would vanish against the background, so lift them to a visible steel blue.
  const peak = Math.max(_col[0], _col[1], _col[2], 1e-3);
  if (peak < 0.45) { const gain = 0.45 / peak; _col[0] *= gain * 0.72; _col[1] *= gain * 0.86; _col[2] *= gain * 1.15; }
  for (let k = 0; k < 3; k++) out[at + k] = Math.min(1, Math.pow(_col[k], 0.8) + _em[k]);
}

// Scatter points over the mesh surface, weighted by triangle area, and pick up the texture colour under each one.
function sampleSurface(mesh, count) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv, idx = geo.index;
  const tris = idx.count / 3;
  const cum = new Float32Array(tris);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, idx.getX(t * 3)); b.fromBufferAttribute(pos, idx.getX(t * 3 + 1)); c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
    total += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5;
    cum[t] = total;
  }
  const P = new Float32Array(count * 3), N = new Float32Array(count * 3), C = new Float32Array(count * 3);
  const B = new Float32Array(count), R = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = Math.random() * total;
    let lo = 0, hi = tris - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    const ia = idx.getX(lo * 3), ib = idx.getX(lo * 3 + 1), ic = idx.getX(lo * 3 + 2);
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    for (let k = 0; k < 3; k++) {
      P[i * 3 + k] = pos.getComponent(ia, k) * w + pos.getComponent(ib, k) * u + pos.getComponent(ic, k) * v;
      N[i * 3 + k] = nor.getComponent(ia, k) * w + nor.getComponent(ib, k) * u + nor.getComponent(ic, k) * v;
    }
    surfaceColor(uv.getX(ia) * w + uv.getX(ib) * u + uv.getX(ic) * v, uv.getY(ia) * w + uv.getY(ib) * u + uv.getY(ic) * v, C, i * 3);
    B[i] = dominantBone(geo, ia);
    for (let k = 0; k < 4; k++) R[i * 4 + k] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(C, 3));
  g.setAttribute('aBone', new THREE.BufferAttribute(B, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(R, 4));
  return g;
}

// Outline of the mesh: creases sharper than the threshold plus open borders, each line coloured like the face it edges.
function creaseLines(mesh, thresholdDeg = 22) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position, uv = geo.attributes.uv, idx = geo.index;
  const cosT = Math.cos(THREE.MathUtils.degToRad(thresholdDeg));
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const open = new Map();
  const P = [], C = [], B = [];
  const push = (e) => {
    for (const i of [e.i, e.j]) {
      P.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      C.push(e.col[0], e.col[1], e.col[2]);
      B.push(dominantBone(geo, i));
    }
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const ids = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    a.fromBufferAttribute(pos, ids[0]); b.fromBufferAttribute(pos, ids[1]); c.fromBufferAttribute(pos, ids[2]);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const col = [0, 0, 0];
    surfaceColor((uv.getX(ids[0]) + uv.getX(ids[1]) + uv.getX(ids[2])) / 3, (uv.getY(ids[0]) + uv.getY(ids[1]) + uv.getY(ids[2])) / 3, col, 0);
    const keys = ids.map(key);
    for (let e = 0; e < 3; e++) {
      const ki = keys[e], kj = keys[(e + 1) % 3];
      if (ki === kj) continue;
      const k = ki < kj ? ki + '|' + kj : kj + '|' + ki;
      const seen = open.get(k);
      if (seen === undefined) open.set(k, { i: ids[e], j: ids[(e + 1) % 3], n, col });
      else if (seen) { if (seen.n.dot(n) <= cosT) push(seen); open.set(k, null); }
    }
  }
  for (const e of open.values()) if (e) push(e);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aBone', new THREE.Float32BufferAttribute(B, 1));
  return g;
}

const bodyGeo = sampleSurface(skinned, BODY_PARTICLES);
const lineGeo = creaseLines(skinned);

// Where the rifle's muzzle is, in the rifle bone's own space (the barrel runs along +Z).
const muzzleLocal = (() => {
  const geo = skinned.geometry, pos = geo.attributes.position, j = boneIndex('ライフル');
  const v = new THREE.Vector3(), sum = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (dominantBone(geo, i) !== j) continue;
    v.fromBufferAttribute(pos, i).applyMatrix4(skeleton.boneInverses[j]);
    if (v.z > 0.72) { sum.add(v); n++; }
  }
  return n ? sum.divideScalar(n).setZ(0.78) : new THREE.Vector3(0, 0.05, 0.78);
})();

// ---------- rig: drive the model's own skeleton ----------
// Rotations are written in the suit's own axes (X = its left, Y = up, Z = forward) and
// converted into each bone's local space using the parent's rest orientation.
function rigBone(name) {
  const b = bones[name];
  const P = b.parent.getWorldQuaternion(new THREE.Quaternion());
  return { b, rest: b.quaternion.clone(), P, Pi: P.clone().invert() };
}
const RIG = {};
for (const n of ['上半身', '上半身2', '頭', '足L', 'ひざL', '足首L', '足R', 'ひざR', '足首R', '前スカートL', '前スカートR', '横スカートL', '横スカートR',
  '腕L', 'ひじL', '手首L', '肩アーマーL', '腕R', 'ひじR', '手首R', '肩アーマーR']) RIG[n] = rigBone(n);
const center = bones['センター'];
const centerRest = center.position.clone();
const THIGH = bones['ひざL'].position.length(), SHIN = bones['足首L'].position.length();

const _e = new THREE.Euler(), _d = new THREE.Quaternion(), _t = new THREE.Quaternion();
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _dir = new THREE.Vector3();
function setRot(name, x, y, z) {
  const r = RIG[name];
  _d.setFromEuler(_e.set(x, y, z));
  r.b.quaternion.copy(r.Pi).multiply(_d).multiply(r.P).multiply(r.rest);
}
// The model rests with its arms straight out. DOWN swings one to hang at the side,
// so arm angles below can be written as if the arm started hanging.
const DOWN = { L: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 2)), R: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)) };
const UP_AGAIN = { L: DOWN.L.clone().invert(), R: DOWN.R.clone().invert() };
function setArm(side, shX, shZ, elbow, wrist) {
  let r = RIG['腕' + side];
  _d.setFromEuler(_e.set(shX, 0, shZ)).multiply(DOWN[side]);
  r.b.quaternion.copy(r.Pi).multiply(_d).multiply(r.P).multiply(r.rest);
  for (const [name, angle] of [['ひじ', elbow], ['手首', wrist]]) {
    r = RIG[name + side];
    _d.copy(UP_AGAIN[side]).multiply(_t.setFromEuler(_e.set(angle, 0, 0))).multiply(DOWN[side]);
    r.b.quaternion.copy(r.Pi).multiply(_d).multiply(r.P).multiply(r.rest);
  }
  setRot('肩アーマー' + side, clamp(shX, -1.7, 0.6) * 0.45, 0, 0);
}

// The file's baked clip: two seconds of ready stance, then a leaping spin that snaps into an aimed shot.
// Firing plays that last stretch. Weapon tracks are dropped because the weapons ride on mount points here.
const FIRE_FROM = 2.0, FIRE_AT = 3.19, FIRE_END = 3.49, FIRE_RATE = 1.15;
const clipTracks = [];
const clipRest = new Map();
for (const track of gltf.animations[0].tracks) {
  const dot = track.name.lastIndexOf('.');
  const node = track.name.slice(0, dot), prop = track.name.slice(dot + 1);
  const bone = bones[node];
  if (!bone || ['盾', 'ライフル', 'ライフルグリップ', 'サーベル'].includes(node)) continue;
  if (prop !== 'quaternion' && !(prop === 'position' && bone === center)) continue;
  clipTracks.push({ bone, prop, interp: track.createInterpolant() });
  if (prop === 'quaternion') clipRest.set(bone, bone.quaternion.clone());
}
function blendClip(t, w) {
  for (const c of clipTracks) {
    const v = c.interp.evaluate(t);
    if (c.prop === 'quaternion') c.bone.quaternion.slerp(_t.fromArray(v), w);
    else c.bone.position.lerp(_v.fromArray(v), w);
  }
}

// Weapons sit loose beside the body in the file; hang them on the mount points the model provides.
function mount(item, onto) {
  if (item.parent === onto) return;
  onto.add(item);
  item.position.set(0, 0, 0);
  item.quaternion.identity();
  item.scale.set(1, 1, 1);
}
const rifle = bones['ライフル'], sabre = bones['サーベル'];
mount(bones['盾'], bones['手ダミーL']);
mount(rifle, bones['手ダミーR']);
mount(sabre, bones['サーベル背中ダミー']);

const root = new THREE.Group();
root.scale.setScalar(S);
root.add(model);
scene.add(root);

// In the particle and wireframe looks the real mesh is drawn into the depth buffer only,
// so whatever sits on the far side is hidden behind it. The full look uses its own material.
const fullMaterial = skinned.material;
const hideMaterial = new THREE.MeshBasicMaterial({
  colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
});
skinned.material = hideMaterial;
skinned.frustumCulled = false;
skinned.renderOrder = -1;
skinned.visible = false;

// ---------- body particles and lines ----------
skeleton.computeBoneTexture();
const lagMatrices = new Float32Array(skeleton.boneMatrices.length);
const lagTexture = new THREE.DataTexture(lagMatrices, skeleton.boneTexture.image.width, skeleton.boneTexture.image.height, THREE.RGBAFormat, THREE.FloatType);
lagTexture.needsUpdate = true;
let lagPrimed = false;

const BONE_GLSL = /* glsl */`
  mat4 boneMatrix(highp sampler2D tex, float i) {
    int size = textureSize(tex, 0).x;
    int j = int(i) * 4;
    int x = j % size, y = j / size;
    return mat4(texelFetch(tex, ivec2(x, y), 0), texelFetch(tex, ivec2(x + 1, y), 0),
                texelFetch(tex, ivec2(x + 2, y), 0), texelFetch(tex, ivec2(x + 3, y), 0));
  }`;
const SPRITE = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    gl_FragColor = vec4(vColor, smoothstep(0.5, 0.12, r) * vAlpha);
  }`;

// One uniform object each, shared by reference, so every material sees the same value.
const uBones = { value: skeleton.boneTexture }, uScale = { value: 1 }, uWhite = { value: 0 };

const bodyMat = new THREE.ShaderMaterial({
  uniforms: {
    uBones, uScale, uWhite,
    uBonesLag: { value: lagTexture },
    uTime: { value: 0 }, uAssemble: { value: 0 }, uThrough: { value: 0 },
  },
  vertexShader: /* glsl */`
    uniform highp sampler2D uBones;
    uniform highp sampler2D uBonesLag;
    uniform float uTime, uScale, uAssemble, uThrough, uWhite;
    attribute vec3 aColor;
    attribute float aBone;
    attribute vec4 aSeed;
    varying vec3 vColor;
    varying float vAlpha;
    ${BONE_GLSL}

    void main() {
      mat4 now = boneMatrix(uBones, aBone);
      mat4 late = boneMatrix(uBonesLag, aBone);
      // A few particles follow a delayed copy of the pose, so fast limbs shed a short wake.
      float lag = aSeed.x * aSeed.x * aSeed.x;
      vec3 p = mix((now * vec4(position, 1.0)).xyz, (late * vec4(position, 1.0)).xyz, lag);
      vec3 n = normalize(mat3(now) * normal);
      float pulse = sin(uTime * (1.4 + aSeed.y * 2.6) + aSeed.z * 6.2832);
      p += n * (0.03 + 0.03 * pulse);

      // Opening: every particle flies in from a wide swirl and settles on the surface.
      float a = clamp(uAssemble * 1.7 - aSeed.w * 0.7, 0.0, 1.0);
      a = a * a * (3.0 - 2.0 * a);
      vec3 away = normalize(aSeed.yzw - 0.5 + 1e-4) * (16.0 + 34.0 * aSeed.x);
      away.y = abs(away.y) * 0.7;
      p = mix(p + away, p, a);
      float turn = (1.0 - a) * 2.6;
      p.xz = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p.xz;

      vec4 mv = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float facing = dot(normalize(mat3(viewMatrix) * n), normalize(-mv.xyz));
      float front = smoothstep(-0.2, 0.3, facing);
      vAlpha = mix(mix(0.0, 0.1, uThrough), 1.0, front) * (0.72 + 0.28 * pulse) * mix(0.4, 1.0, a) * 0.8;
      // White keeps a little of each colour's brightness so panels still separate.
      float luma = dot(aColor, vec3(0.3, 0.55, 0.15));
      vColor = mix(aColor, vec3(0.62 + 0.38 * luma), uWhite);
      gl_PointSize = max(1.0, 0.058 * (0.7 + 0.7 * aSeed.y) * uScale / -mv.z);
    }`,
  fragmentShader: SPRITE,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const body = new THREE.Points(bodyGeo, bodyMat);
body.frustumCulled = false;
scene.add(body);

const lineMat = new THREE.ShaderMaterial({
  uniforms: { uBones, uWhite },
  vertexShader: /* glsl */`
    uniform highp sampler2D uBones;
    uniform float uWhite;
    attribute vec3 aColor;
    attribute float aBone;
    varying vec3 vColor;
    ${BONE_GLSL}
    void main() {
      gl_Position = projectionMatrix * viewMatrix * (boneMatrix(uBones, aBone) * vec4(position, 1.0));
      vColor = mix(aColor, vec3(0.95), uWhite);
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vColor;
    void main() { gl_FragColor = vec4(vColor, 1.0); }`,
  transparent: true, depthWrite: false,
});
const lines = new THREE.LineSegments(lineGeo, lineMat);
lines.frustumCulled = false;
lines.visible = false;
scene.add(lines);

// Wireframe surface: the real mesh drawn in the background colour with crosshatching on top.
// The hatch is laid out in the model's rest pose, so it stays fixed to each armour panel as the suit moves.
// One set of diagonals covers all but the faces turned furthest from the light; a second set crosses it on the brighter ones.
// Details that exist only in the model's paint (the shield's cross, the chest vents, panel markings) are traced
// as lines wherever the texture's colour changes, since there is no geometry edge there to draw.
const hatchMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uWhite,
    uMap: { value: fullMaterial.map },
    uGround: { value: new THREE.Color().setHex(SPACE, THREE.LinearSRGBColorSpace) },   // raw value: this shader writes colours as-is
    uLight: { value: new THREE.Vector3(0.45, 0.75, 0.5).normalize() },
    uPitch: { value: 46 },   // hatch lines per model unit
  },
  vertexShader: /* glsl */`
    #include <skinning_pars_vertex>
    varying vec3 vRest, vWorld;
    varying vec2 vPaint;
    void main() {
      vRest = position;
      vPaint = uv;
      #include <skinbase_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      vec4 world = modelMatrix * vec4(transformed, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uMap;
    uniform float uWhite, uPitch;
    uniform vec3 uGround, uLight;
    varying vec3 vRest, vWorld;
    varying vec2 vPaint;

    // A set of parallel lines about a pixel wide, fading out where they would crowd closer than the pixels.
    float strokes(float c) {
      float v = c * uPitch;
      float px = fwidth(v);
      float d = abs(fract(v) - 0.5);
      return (1.0 - smoothstep(0.2 * px, 1.1 * px, d)) * smoothstep(0.6, 0.25, px);
    }

    // The painted colour at a UV, as displayed (the sampler hands back linear light).
    vec3 paint(vec2 at) { return pow(texture2D(uMap, at).rgb, vec3(1.0 / 2.2)); }
    // Same treatment the particles and outline get: dark parts lifted to a steel blue so they show on the dark ground.
    vec3 glow(vec3 c) {
      float peak = max(max(c.r, c.g), max(c.b, 0.001));
      if (peak < 0.45) c *= (0.45 / peak) * vec3(0.72, 0.86, 1.15);
      return min(pow(c, vec3(0.8)), 1.0);
    }

    void main() {
      // Flat normals from screen-space derivatives: one for lighting, one (rest pose) to pick the hatch plane.
      vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      if (dot(n, cameraPosition - vWorld) < 0.0) n = -n;
      vec3 r = abs(normalize(cross(dFdx(vRest), dFdy(vRest))));
      vec2 st = r.z >= r.x && r.z >= r.y ? vRest.xy : (r.x >= r.y ? vRest.zy : vRest.xz);

      float tone = clamp(dot(n, uLight) * 0.6 + 0.4, 0.0, 1.0);
      float ink = max(strokes(st.x + st.y) * smoothstep(0.12, 0.3, tone),
                      strokes(st.x - st.y) * smoothstep(0.52, 0.72, tone));

      // Compare the paint here with the paint a pixel or two away in each direction.
      vec2 dx = dFdx(vPaint) * 1.6, dy = dFdy(vPaint) * 1.6;
      vec3 here = paint(vPaint);
      vec3 a = paint(vPaint + dx), b = paint(vPaint - dx), c = paint(vPaint + dy), d = paint(vPaint - dy);
      float change = max(max(distance(here, a), distance(here, b)), max(distance(here, c), distance(here, d)));
      float seam = smoothstep(0.07, 0.18, change);
      vec3 brightest = max(max(here, max(a, b)), max(c, d));

      vec3 color = mix(uGround, mix(glow(here), vec3(0.95), uWhite), ink * 0.5);
      gl_FragColor = vec4(mix(color, mix(glow(brightest), vec3(0.95), uWhite), seam * 0.9), 1.0);
    }`,
  side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
});

// ---------- loose particles: beam, exhaust, dust, floor, stars ----------
const looseMat = new THREE.ShaderMaterial({
  uniforms: { uScale, uWhite },
  vertexShader: /* glsl */`
    uniform float uScale, uWhite;
    attribute vec3 aColor;
    attribute float aAlpha, aSize;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = max(1.0, aSize * uScale / -mv.z);
      vColor = mix(aColor, vec3(1.0), uWhite);
      vAlpha = aAlpha;
    }`,
  fragmentShader: SPRITE,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

function staticPoints(list) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(list.flatMap((p) => p.pos), 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(list.flatMap((p) => p.color), 3));
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(list.map((p) => p.alpha), 1));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(list.map((p) => p.size), 1));
  const pts = new THREE.Points(g, looseMat);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
}
{
  // Floor: a field of dots that thins out with distance, plus a ring marking where the suit stands.
  const dots = [];
  const REACH = 46, STEP = 1.6;
  for (let x = -REACH; x <= REACH; x += STEP) {
    for (let z = -REACH; z <= REACH; z += STEP) {
      const d = Math.hypot(x, z);
      if (d > REACH) continue;
      dots.push({ pos: [x, 0, z], color: [0.45, 0.6, 0.95], alpha: 0.55 * Math.pow(1 - d / REACH, 1.6), size: 0.1 });
    }
  }
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    dots.push({ pos: [Math.sin(a) * 5, 0, Math.cos(a) * 5], color: [0.75, 0.85, 1], alpha: i % 10 === 0 ? 0.9 : 0.4, size: i % 10 === 0 ? 0.16 : 0.09 });
  }
  staticPoints(dots);

  const stars = [];
  for (let i = 0; i < 1400; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(220 + Math.random() * 260);
    const warm = Math.random();
    stars.push({ pos: v.toArray(), color: [0.7 + 0.3 * warm, 0.8, 1 - 0.25 * warm], alpha: 0.15 + 0.6 * Math.random() ** 2, size: 0.5 + 1.3 * Math.random() });
  }
  staticPoints(stars);
}

const MAX_LOOSE = 26000;
const loose = {
  n: 0,
  pos: new Float32Array(MAX_LOOSE * 3), vel: new Float32Array(MAX_LOOSE * 3), col: new Float32Array(MAX_LOOSE * 3),
  alpha: new Float32Array(MAX_LOOSE), size: new Float32Array(MAX_LOOSE),
  age: new Float32Array(MAX_LOOSE), life: new Float32Array(MAX_LOOSE), size0: new Float32Array(MAX_LOOSE),
  drag: new Float32Array(MAX_LOOSE), fall: new Float32Array(MAX_LOOSE),
};
const looseGeo = new THREE.BufferGeometry();
looseGeo.setAttribute('position', new THREE.BufferAttribute(loose.pos, 3).setUsage(THREE.DynamicDrawUsage));
looseGeo.setAttribute('aColor', new THREE.BufferAttribute(loose.col, 3).setUsage(THREE.DynamicDrawUsage));
looseGeo.setAttribute('aAlpha', new THREE.BufferAttribute(loose.alpha, 1).setUsage(THREE.DynamicDrawUsage));
looseGeo.setAttribute('aSize', new THREE.BufferAttribute(loose.size, 1).setUsage(THREE.DynamicDrawUsage));
const loosePoints = new THREE.Points(looseGeo, looseMat);
loosePoints.frustumCulled = false;
scene.add(loosePoints);

function emit(x, y, z, vx, vy, vz, life, r, g, b, size, drag = 0, fall = 0) {
  if (loose.n >= MAX_LOOSE) return;
  const i = loose.n++;
  loose.pos[i * 3] = x; loose.pos[i * 3 + 1] = y; loose.pos[i * 3 + 2] = z;
  loose.vel[i * 3] = vx; loose.vel[i * 3 + 1] = vy; loose.vel[i * 3 + 2] = vz;
  loose.col[i * 3] = r; loose.col[i * 3 + 1] = g; loose.col[i * 3 + 2] = b;
  loose.age[i] = 0; loose.life[i] = life; loose.size0[i] = size; loose.drag[i] = drag; loose.fall[i] = fall;
}
function stepLoose(dt) {
  const L = loose;
  for (let i = 0; i < L.n; i++) {
    L.age[i] += dt;
    if (L.age[i] >= L.life[i]) {
      // Fill the gap with the last live particle.
      const j = --L.n;
      for (let k = 0; k < 3; k++) { L.pos[i * 3 + k] = L.pos[j * 3 + k]; L.vel[i * 3 + k] = L.vel[j * 3 + k]; L.col[i * 3 + k] = L.col[j * 3 + k]; }
      L.age[i] = L.age[j]; L.life[i] = L.life[j]; L.size0[i] = L.size0[j]; L.drag[i] = L.drag[j]; L.fall[i] = L.fall[j];
      i--;
      continue;
    }
    const slow = Math.exp(-L.drag[i] * dt);
    L.vel[i * 3] *= slow; L.vel[i * 3 + 1] = L.vel[i * 3 + 1] * slow - L.fall[i] * dt; L.vel[i * 3 + 2] *= slow;
    L.pos[i * 3] += L.vel[i * 3] * dt; L.pos[i * 3 + 1] += L.vel[i * 3 + 1] * dt; L.pos[i * 3 + 2] += L.vel[i * 3 + 2] * dt;
    const k = 1 - L.age[i] / L.life[i];
    L.alpha[i] = Math.min(1, k * 1.6);
    L.size[i] = L.size0[i] * (0.45 + 0.55 * k);
  }
  looseGeo.setDrawRange(0, L.n);
  for (const name of ['position', 'aColor', 'aAlpha', 'aSize']) looseGeo.attributes[name].needsUpdate = true;
}

const rnd = (a, b) => a + Math.random() * (b - a);

// Orthonormal pair across the barrel, for effects that spread sideways from the shot.
const _side = new THREE.Vector3(), _lift = new THREE.Vector3();
function fireBeam() {
  const m = rifle.matrixWorld;
  _v.copy(muzzleLocal).applyMatrix4(m);
  _dir.set(0, 0, 1).transformDirection(m);
  _side.set(0, 1, 0).cross(_dir).normalize();
  _lift.crossVectors(_dir, _side);
  const at = (along, a, b, out) => out.copy(_v).addScaledVector(_dir, along).addScaledVector(_side, a).addScaledVector(_lift, b);

  // The bolt: a tight bundle that leaves the barrel together.
  for (let i = 0; i < 300; i++) {
    const along = Math.random() * 5, core = Math.random() < 0.4;
    const spread = core ? 0.05 : 0.22, speed = 70 + rnd(-1.2, 1.2);
    emit(_v.x + _dir.x * along + rnd(-spread, spread), _v.y + _dir.y * along + rnd(-spread, spread), _v.z + _dir.z * along + rnd(-spread, spread),
      _dir.x * speed, _dir.y * speed, _dir.z * speed, rnd(0.9, 1.5),
      1, core ? 0.85 : 0.2, core ? 0.95 : 0.6, core ? 0.22 : 0.15);
  }
  // Afterglow along the path the bolt is about to take, so the shot reads as one streak.
  for (let i = 0; i < 220; i++) {
    const along = Math.pow(Math.random(), 1.6) * 60;
    at(along, rnd(-0.07, 0.07), rnd(-0.07, 0.07), _w);
    emit(_w.x, _w.y, _w.z, _dir.x * 3, _dir.y * 3, _dir.z * 3, 0.1 + along / 70 + rnd(0, 0.25), 1, 0.45, 0.75, 0.13);
  }
  // Flash: a few big, brief particles right at the muzzle.
  for (let i = 0; i < 46; i++) {
    at(rnd(0, 0.9), rnd(-0.25, 0.25), rnd(-0.25, 0.25), _w);
    emit(_w.x, _w.y, _w.z, _dir.x * 6, _dir.y * 6, _dir.z * 6, rnd(0.06, 0.16), 1, rnd(0.8, 1), rnd(0.85, 1), rnd(0.5, 1.2));
  }
  // Blast cone: hot gas thrown forward and outward, slowing fast.
  for (let i = 0; i < 320; i++) {
    const a = Math.random() * Math.PI * 2, wide = Math.pow(Math.random(), 0.7) * 0.55, speed = rnd(10, 48);
    const sx = Math.cos(a) * wide, sy = Math.sin(a) * wide, heat = Math.random();
    emit(_v.x, _v.y, _v.z,
      (_dir.x + _side.x * sx + _lift.x * sy) * speed, (_dir.y + _side.y * sx + _lift.y * sy) * speed, (_dir.z + _side.z * sx + _lift.z * sy) * speed,
      rnd(0.18, 0.55), 1, 0.3 + 0.6 * heat, 0.35 + 0.5 * heat * heat, rnd(0.12, 0.3), 5.5);
  }
  // Two shock rings that open around the barrel line and drift forward.
  for (let ring = 0; ring < 2; ring++) {
    const forward = ring ? 20 : 7, out = ring ? 7 : 13;
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2 + rnd(-0.03, 0.03), cx = Math.cos(a), cy = Math.sin(a);
      at(0.4 + ring * 0.9, cx * 0.3, cy * 0.3, _w);
      emit(_w.x, _w.y, _w.z,
        _dir.x * forward + (_side.x * cx + _lift.x * cy) * out, _dir.y * forward + (_side.y * cx + _lift.y * cy) * out, _dir.z * forward + (_side.z * cx + _lift.z * cy) * out,
        rnd(0.28, 0.42), 1, 0.7, 0.95, 0.16, 3.5);
    }
  }
}

const NOZZLES = [new THREE.Vector3(0.055, 0.024, -0.24), new THREE.Vector3(-0.055, 0.024, -0.24)];
function exhaust(power, dt) {
  const m = bones['上半身2'].matrixWorld;
  _dir.set(0, -0.78, -0.62).transformDirection(m);
  const n = Math.round(900 * power * dt);
  for (const nozzle of NOZZLES) {
    _v.copy(nozzle).applyMatrix4(m);
    for (let i = 0; i < n; i++) {
      const speed = rnd(12, 26), hot = Math.random();
      emit(_v.x + rnd(-0.12, 0.12), _v.y, _v.z + rnd(-0.12, 0.12),
        _dir.x * speed + rnd(-2.5, 2.5), _dir.y * speed + rnd(-2.5, 2.5), _dir.z * speed + rnd(-2.5, 2.5),
        rnd(0.18, 0.5), 1, 0.45 + 0.5 * hot, 0.12 + 0.6 * hot * hot, rnd(0.12, 0.26), 2.5);
    }
  }
}

function dustRing(x, z, count, speed, size) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = rnd(0.2, 1.4), v = rnd(0.35, 1) * speed;
    emit(x + Math.sin(a) * r, 0.05, z + Math.cos(a) * r, Math.sin(a) * v, rnd(0, 0.18) * speed, Math.cos(a) * v,
      rnd(0.4, 1.0), 0.6, 0.72, 1, rnd(0.6, 1.3) * size, 3.2, 1.5);
  }
}

// The sabre blade is nothing but particles: each frame fills the space the blade swept since the last one.
const BLADE_BASE = 0.15, BLADE_LEN = 0.78;   // along the hilt's +Y, in model units
const bladeA = new THREE.Vector3(), bladeB = new THREE.Vector3(), prevA = new THREE.Vector3(), prevB = new THREE.Vector3();
let bladeWasOn = false;
function emitBlade(power, dt) {
  const m = sabre.matrixWorld;
  bladeA.set(0, BLADE_BASE, 0).applyMatrix4(m);
  bladeB.set(0, BLADE_BASE + BLADE_LEN * power, 0).applyMatrix4(m);
  if (!bladeWasOn) { prevA.copy(bladeA); prevB.copy(bladeB); }
  const n = Math.round(clamp(16000 * dt, 120, 640) * power);
  for (let i = 0; i < n; i++) {
    // Weighted towards where the blade is now, so the blade stays dense and the wake behind it thins out.
    const s = Math.pow(Math.random(), 0.35), along = Math.random(), core = Math.random() < 0.45;
    _v.lerpVectors(prevA, bladeA, s);
    _w.lerpVectors(prevB, bladeB, s);
    _u.lerpVectors(_v, _w, along);
    const j = core ? 0.03 : 0.1;
    emit(_u.x + rnd(-j, j), _u.y + rnd(-j, j), _u.z + rnd(-j, j), rnd(-0.6, 0.6), rnd(-0.6, 0.6), rnd(-0.6, 0.6),
      rnd(0.06, core ? 0.14 : 0.3), 1, core ? 0.8 : 0.22, core ? 0.92 : 0.62, core ? 0.2 : 0.15);
  }
  prevA.copy(bladeA); prevB.copy(bladeB);
}

// ---------- look: particles / wireframe / full materials, and particle colour ----------
const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let mode = 'wireframe', white = false, seeThrough = false;
let assemble = calm ? 1 : 0;
const lookButtons = [...document.querySelectorAll('#look button')];
const tintGroup = document.getElementById('tint');
const tintButtons = [...tintGroup.querySelectorAll('button')];
const keyButtons = {};

function setMode(next) {
  if (next === mode) return;
  // Coming back to particles, let them swirl in again briefly.
  if (next === 'particles' && !calm) assemble = Math.min(assemble, 0.42);
  mode = next;
  for (const b of lookButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  // Colour and see-through only mean something for particles and lines.
  tintGroup.hidden = mode === 'full';
  keyButtons.xray.hidden = mode === 'full';
  relayout();
}
function setWhite(on) {
  white = on;
  for (const b of tintButtons) b.setAttribute('aria-checked', String((b.dataset.tint === 'white') === white));
}
for (const b of lookButtons) b.addEventListener('click', () => setMode(b.dataset.mode));
for (const b of tintButtons) b.addEventListener('click', () => setWhite(b.dataset.tint === 'white'));

// ---------- input ----------
const KEYMAP = {
  KeyW: 'walk', Space: 'jump', KeyC: 'crouch', KeyF: 'fire', KeyE: 'slash', KeyX: 'xray',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
};
const held = { walk: false, crouch: false, fire: false, left: false, right: false, up: false, down: false };
let jumpQueued = false, fireQueued = false, slashQueued = false;

function press(act) {
  if (act in held) held[act] = true;
  if (act === 'fire') fireQueued = true;
  if (act === 'jump') jumpQueued = true;
  if (act === 'slash') slashQueued = true;
  if (act === 'xray') seeThrough = !seeThrough;
}
function release(act) {
  if (act in held) held[act] = false;
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!e.repeat) {
    if (e.code === 'Digit1') setMode('full');
    if (e.code === 'Digit2') setMode('wireframe');
    if (e.code === 'Digit3') setMode('particles');
    if (e.code === 'KeyV') setWhite(!white);
  }
  const act = KEYMAP[e.code];
  if (!act) return;
  e.preventDefault();
  if (!e.repeat) press(act);
});
window.addEventListener('keyup', (e) => {
  const act = KEYMAP[e.code];
  if (act) release(act);
});
window.addEventListener('blur', () => {
  for (const k in held) held[k] = false;
});

for (const btn of document.querySelectorAll('.key')) {
  const act = btn.dataset.act;
  keyButtons[act] = btn;
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); press(act); });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(type, () => release(act));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Enter or Space on a focused button arrives as a click with no pointer behind it.
  btn.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    press(act);
    setTimeout(() => release(act), 350);
  });
}

// One finger or the mouse turns the view; two fingers or the wheel zoom.
let yaw = 0.6, pitch = 0.14, yawVel = 0, pitchVel = 0, zoom = 1;
const PITCH_MIN = -0.45, PITCH_MAX = 1.45, ZOOM_MIN = 0.5, ZOOM_MAX = 1.7;
const touches = new Map();
let pinchGap = 0;
const gap = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
canvas.addEventListener('pointerdown', (e) => {
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  if (touches.size === 2) pinchGap = gap();
});
canvas.addEventListener('pointermove', (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  const dx = e.clientX - t.x, dy = e.clientY - t.y;
  t.x = e.clientX; t.y = e.clientY;
  if (touches.size === 1) {
    yaw += dx * 0.008;
    pitch = clamp(pitch + dy * 0.006, PITCH_MIN, PITCH_MAX);
  } else if (touches.size === 2) {
    const g = gap();
    if (pinchGap > 0 && g > 0) zoom = clamp(zoom * pinchGap / g, ZOOM_MIN, ZOOM_MAX);
    pinchGap = g;
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, (e) => {
    touches.delete(e.pointerId);
    if (!touches.size) canvas.classList.remove('dragging');
  });
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom = clamp(zoom * Math.exp(e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
}, { passive: false });

// ---------- layout ----------
// The suit is framed in whatever space the title and the dock leave free, so it never hides behind them.
const topEl = document.querySelector('.top'), dockEl = document.getElementById('dock');
const FOV_K = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
let camDist = 31, camDistGoal = 31, shift = 0, shiftGoal = 0, framed = false;
function relayout() {
  const w = window.innerWidth, h = window.innerHeight;
  const narrow = w <= 720;
  const topInset = narrow ? topEl.getBoundingClientRect().bottom : 0;
  // On wide screens the panel sits in the corner, clear of the suit, and takes no room from it.
  const dock = dockEl.getBoundingClientRect();
  const bottomInset = dock.right < w / 2 - 0.24 * h ? h * 0.06 : h - dock.top;
  const free = Math.max(h * 0.3, h - topInset - bottomInset);
  camDistGoal = Math.max(24, (13.2 * h) / (FOV_K * free), 20 / (w / h));
  shiftGoal = (bottomInset - topInset) / 2;
  if (!framed) { camDist = camDistGoal; shift = shiftGoal; framed = true; }
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  uScale.value = renderer.domElement.height / FOV_K;
  relayout();
}

// The panel minimizes to a single button; the choice is remembered where storage is available.
const toggle = document.getElementById('toggle'), panel = document.getElementById('panel');
let controlsOpen = true, dockRun = 0;
function setControlsOpen(open, animate = true) {
  controlsOpen = open;
  const show = (o) => { panel.hidden = !o; dockEl.classList.toggle('min', !o); };
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Minimize panel' : 'Show controls');
  toggle.title = open ? 'Minimize' : 'Show controls';
  for (const k in held) held[k] = false;
  try { localStorage.setItem('gundam-controls', open ? 'open' : 'closed'); } catch { /* private mode */ }

  const run = ++dockRun;
  const settle = () => {
    if (run !== dockRun) return;
    show(open);
    dockEl.classList.remove('moving', 'closing', 'opening');
    dockEl.style.width = dockEl.style.height = '';
    relayout();
  };
  if (!animate || calm) { settle(); return; }

  // Measure where the panel is and where it will end up, then ease its box between the two.
  const from = dockEl.getBoundingClientRect();
  dockEl.classList.remove('moving', 'closing', 'opening');
  dockEl.style.width = dockEl.style.height = '';
  show(open);
  const to = dockEl.getBoundingClientRect();
  if (!open) show(true);   // closing: keep the contents in place and fade them while the box shrinks
  dockEl.style.width = from.width + 'px';
  dockEl.style.height = from.height + 'px';
  dockEl.getBoundingClientRect();   // commit the starting size before the transition begins
  dockEl.classList.add('moving', open ? 'opening' : 'closing');
  dockEl.style.width = to.width + 'px';
  dockEl.style.height = to.height + 'px';
  setTimeout(settle, 320);
}
toggle.addEventListener('click', () => setControlsOpen(!controlsOpen));

const creditToggle = document.getElementById('credit-toggle'), creditFold = document.getElementById('credit-fold');
creditToggle.addEventListener('click', () => {
  creditToggle.setAttribute('aria-expanded', String(creditFold.classList.toggle('open')));
});
try { if (localStorage.getItem('gundam-controls') === 'closed') setControlsOpen(false, false); } catch { /* private mode */ }

window.addEventListener('resize', resize);
new ResizeObserver(relayout).observe(dockEl);
new ResizeObserver(relayout).observe(topEl);
document.fonts?.ready.then(relayout);
resize();

// ---------- animation state ----------
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

let time = 0;
let walk = 0, walkPhase = 0, lastStep = 0;
let crouch = 0;
let jumpState = 'ground', jumpT = 0, jumpY = 0, jumpVy = 0, squat = 0, tuck = 0, thrust = 0;
let fireState = 'idle', clipT = FIRE_FROM, shotDone = false, holdT = 0, fireW = 0, cooldown = 0, recoil = 0;
let hover = 0, hovering = false, kneelShot = 0, lungeDust = true;
let slashT = -1, bladeOn = 0, shake = 0;
const SLASH_LEN = 1.05;
const JUMP_SPEED = 15, GRAVITY = 24, HOVER = 2.6;   // world units

const statusEl = document.getElementById('status');
let statusText = '';
const buttonOn = {};
function setButton(act, on) {
  if (buttonOn[act] === on) return;
  buttonOn[act] = on;
  keyButtons[act]?.classList.toggle('on', on);
}

function update(dt) {
  time += dt;
  assemble = Math.min(1, assemble + dt / 2.4);

  // --- view ---
  yawVel = damp(yawVel, ((held.right ? 1 : 0) - (held.left ? 1 : 0)) * 2.6, 9, dt);
  pitchVel = damp(pitchVel, ((held.up ? 1 : 0) - (held.down ? 1 : 0)) * 1.5, 9, dt);
  yaw += yawVel * dt;
  pitch = clamp(pitch + pitchVel * dt, PITCH_MIN, PITCH_MAX);

  // --- sabre: reach back for the hilt, draw, cut down across the body, put it away ---
  if (slashQueued && slashT < 0 && fireState === 'idle') { slashT = 0; lungeDust = false; }
  slashQueued = false;
  let reach = 0, wind = 0, strike = 0;
  if (slashT >= 0) {
    slashT += dt;
    const t = slashT;
    if (t < 0.24) reach = ease(t / 0.24);
    else if (t < 0.38) { reach = 1; wind = ease((t - 0.24) / 0.14); }
    else if (t < 0.5) { reach = 1; wind = 1; strike = ease((t - 0.38) / 0.12); }
    else if (t < 0.68) { reach = 1; wind = 1; strike = 1; }
    else if (t < SLASH_LEN) strike = 1 - ease((t - 0.68) / (SLASH_LEN - 0.68));
    else slashT = -1;
  }
  const slashing = slashT >= 0;
  const sabreInHand = slashing && slashT > 0.22 && slashT < 0.86;
  mount(sabre, sabreInHand ? bones['手ダミーR'] : bones['サーベル背中ダミー']);
  mount(rifle, slashing && slashT > 0.16 && slashT < 0.9 ? bones['バズーカ腰ダミー'] : bones['手ダミーR']);
  bladeOn = damp(bladeOn, sabreInHand && slashT > 0.27 && slashT < 0.8 ? 1 : 0, 22, dt);
  const cut = (base, a, b, d) => lerp(lerp(lerp(base, a, reach), b, wind), d, strike);

  // --- rifle: the model's own clip, a leap that snaps into an aimed shot and hovers while the key is held ---
  if (held.fire) fireQueued = true;
  cooldown -= dt;
  let shoot = false;
  if (fireState === 'idle' && fireQueued && !slashing) {
    // Kneeling already has the rifle levelled, so it shoots from there; standing, it plays the leaping clip.
    if (held.crouch && crouch > 0.85) { if (cooldown <= 0) { shoot = true; kneelShot = 0.4; } }
    else if (!held.crouch && crouch < 0.15) { fireState = 'play'; clipT = FIRE_FROM; shotDone = false; }
    else if (!held.fire) fireQueued = false;   // mid-way between standing and kneeling: drop a stale tap
  }
  kneelShot -= dt;
  if (fireState === 'play') {
    clipT += dt * FIRE_RATE;
    if (!shotDone && clipT >= FIRE_AT) { shoot = true; shotDone = true; }
    if (clipT >= FIRE_END) { clipT = FIRE_END; fireState = 'hold'; holdT = 0.5; }
  } else if (fireState === 'hold') {
    if (fireQueued && cooldown <= 0) { shoot = true; holdT = 0.5; }
    holdT -= dt;
    if (holdT <= 0) fireState = 'idle';
  }
  if (shoot) { fireQueued = false; cooldown = 0.3; }
  const firingNow = fireState !== 'idle';
  fireW = damp(fireW, firingNow ? 1 : 0, firingNow ? 10 : 6, dt);
  recoil = damp(recoil, 0, 9, dt);
  hover = damp(hover, firingNow ? HOVER : 0, firingNow ? 5 : 6.5, dt);
  if (hover > 0.8) hovering = true;

  // --- jump ---
  if (jumpQueued && jumpState === 'ground' && !firingNow && hover < 0.2) { jumpState = 'windup'; jumpT = 0; }
  jumpQueued = false;
  jumpT += dt;
  if (jumpState === 'windup') {
    squat = damp(squat, 0.8, 22, dt);
    if (jumpT > 0.17) { jumpState = 'air'; jumpVy = JUMP_SPEED; }
  } else if (jumpState === 'air') {
    jumpVy -= GRAVITY * dt;
    jumpY += jumpVy * dt;
    squat = damp(squat, 0, 14, dt);
    tuck = damp(tuck, jumpVy > -7 ? 1 : 0.15, 8, dt);
    if (jumpY <= 0 && jumpVy < 0) {
      jumpY = 0; jumpState = 'land'; jumpT = 0;
      squat = 0.85; shake = calm ? 0 : 0.22;
      dustRing(0, 0, 420, 16, 0.14);
    }
  } else if (jumpState === 'land') {
    squat = damp(squat, 0, 7, dt);
    if (jumpT > 0.4) jumpState = 'ground';
  } else {
    squat = damp(squat, 0, 10, dt);
  }
  if (jumpState !== 'air') tuck = damp(tuck, 0, 16, dt);
  // Coming down from the firing hover counts as a landing too.
  if (hovering && !firingNow && hover < 0.25 && jumpState !== 'air') {
    hovering = false;
    squat = Math.max(squat, 0.6); shake = calm ? 0 : 0.14;
    dustRing(0, 0, 260, 12, 0.13);
  }
  const airborne = jumpState === 'air' || hover > 0.5;
  thrust = damp(thrust, jumpState === 'air' ? (jumpVy > 0 ? 1 : 0.3) : (firingNow ? 0.8 : 0), 14, dt);

  // --- walk / kneel ---
  walk = damp(walk, held.walk && !airborne ? 1 : 0, 8, dt);
  if (walk > 0.01) walkPhase += dt * 5.4 * (0.45 + 0.55 * walk);
  crouch = damp(crouch, held.crouch && !airborne && !firingNow ? 1 : 0, 8, dt);
  const kneel = ease(crouch);
  const c = squat;   // even knee bend, used for take-off and landing

  // --- start from rest, then lay the computed pose on top ---
  for (const [bone, q] of clipRest) bone.quaternion.copy(q);

  // legs: standing, walking and jumping first
  const bend = c * 0.95;
  const p = walkPhase;
  const stride = (ph) => -0.42 * Math.sin(ph);
  const lift = (ph) => 0.95 * Math.max(0, Math.cos(ph));
  let hipL = -bend + walk * stride(p) - 0.75 * tuck;
  let kneeL = 2 * bend + walk * lift(p) + 1.3 * tuck;
  let hipR = -bend + walk * stride(p + Math.PI) - 0.2 * tuck;
  let kneeR = 2 * bend + walk * lift(p + Math.PI) + 0.6 * tuck;
  // Kneel: left foot planted ahead with its knee up, right knee on the floor with the shin laid back.
  hipL = lerp(hipL, -1.83, kneel); kneeL = lerp(kneeL, 2.13, kneel);
  hipR = lerp(hipR, 0.25, kneel); kneeR = lerp(kneeR, 1.5, kneel);
  // Slash: sink while winding up, then lunge onto the left leg with the right leg driving straight behind.
  hipL = cut(hipL, -0.25, -0.35, -0.9); kneeL = cut(kneeL, 0.5, 0.7, 1.1);
  hipR = cut(hipR, -0.2, -0.1, 0.55); kneeR = cut(kneeR, 0.45, 0.5, 0.15);
  const spread = 0.09 + 0.1 * c + 0.05 * tuck + 0.05 * kneel + 0.07 * strike;
  const reachDown = (h, k) => (THIGH * Math.cos(h) + SHIN * Math.cos(h + k)) * Math.cos(spread);
  // Whichever leg reaches lower carries the weight, so the hips ride on it.
  center.position.copy(centerRest);
  center.position.y += Math.max(reachDown(hipL, kneeL), reachDown(hipR, kneeR)) - (THIGH + SHIN);
  center.position.z += cut(0, -0.02, -0.07, 0.17);
  const toe = 0.45 * tuck;

  setRot('足L', hipL, 0, spread);
  setRot('ひざL', kneeL, 0, 0);
  setRot('足首L', -(hipL + kneeL) + toe, 0, -spread);
  setRot('足R', hipR, 0, -spread);
  setRot('ひざR', kneeR, 0, 0);
  // The trailing foot comes up onto its toes when kneeling or lunging.
  setRot('足首R', -(hipR + kneeR) + toe + 0.9 * kneel + 0.45 * strike, 0, spread);
  setRot('前スカートL', Math.max(-1.25, Math.min(0, hipL) * 0.8), 0, 0);
  setRot('前スカートR', Math.max(-1.25, Math.min(0, hipR) * 0.8), 0, 0);
  setRot('横スカートL', 0, 0, spread * 1.6);
  setRot('横スカートR', 0, 0, -spread * 1.6);

  // torso / head: coil back and away on the wind-up, then throw the shoulders through the cut
  const breath = Math.sin(time * 1.5);
  const lean = 0.012 * breath + 0.22 * c - 0.12 * tuck + (0.1 - 0.05 * recoil) * kneel;
  const torsoX = cut(lean, -0.05, -0.18, 0.38);
  const torsoY = cut(0.07 * walk * Math.sin(p), -0.25, -0.65, 0.75);
  setRot('上半身', torsoX * 0.6, torsoY * 0.5, 0);
  setRot('上半身2', torsoX * 0.4, torsoY * 0.5, 0);
  setRot('頭', cut(-0.18 * c + 0.1 * tuck, 0, 0.1, -0.25), -torsoY * 0.6, 0);

  // right arm: rifle at the ready, levelled when kneeling, or the sabre during a slash
  const swing = walk * Math.sin(p);
  const rShX = lerp(0.1 - 0.16 * swing + 0.3 * tuck, -1.3 - lean - 0.12 * recoil, kneel);
  const rShZ = lerp(-0.2 - 0.3 * tuck, -0.05, kneel);
  const rEl = lerp(-0.6 - 0.5 * c - 0.012 * breath, -0.27 - 0.25 * recoil, kneel);
  setArm('R', cut(rShX, -2.75, -2.5, -0.7), cut(rShZ, -0.25, -0.6, 0.55), cut(rEl, -2.0, -1.1, -0.2), cut(0, 0, -0.5, 0.8));

  // left arm: shield, held up in front when kneeling, thrown back as a counterweight on the cut
  const lShX = lerp(0.02 + 0.3 * swing + 0.25 * tuck, -0.75, kneel);
  const lShZ = lerp(0.24 + 0.35 * tuck, 0.3, kneel);
  const lEl = lerp(-0.55 - 0.3 * c, -1.0, kneel);
  setArm('L', cut(lShX, lShX - 0.2, -0.5, 0.8), cut(lShZ, 0.3, 0.4, 0.6), cut(lEl, -0.7, -0.9, -0.35), 0);

  // --- the firing clip takes over the whole body while it plays ---
  if (fireW > 0.002) blendClip(clipT, ease(fireW));
  center.position.y += (jumpY + hover) / S;
  center.position.z -= 0.04 * recoil;

  // --- skeleton -> particle textures ---
  root.updateMatrixWorld(true);
  skeleton.update();
  const cur = skeleton.boneMatrices;
  if (!lagPrimed) { lagMatrices.set(cur); lagPrimed = true; }
  const follow = 1 - Math.exp(-11 * dt);
  for (let i = 0; i < cur.length; i++) lagMatrices[i] += (cur[i] - lagMatrices[i]) * follow;
  lagTexture.needsUpdate = true;

  // --- loose particles ---
  if (shoot) { fireBeam(); recoil = 1; if (!calm) shake = Math.max(shake, 0.1); }
  if (thrust > 0.05) exhaust(thrust, dt);
  if (bladeOn > 0.05) emitBlade(bladeOn, dt);
  if (!lungeDust && strike > 0.85) {
    // The front foot lands as the cut comes through.
    lungeDust = true;
    bones['足首L'].getWorldPosition(_v);
    dustRing(_v.x, _v.z + 0.6, 110, 9, 0.13);
  }
  bladeWasOn = bladeOn > 0.05;
  const step = Math.floor(walkPhase / Math.PI - 0.5);
  if (step !== lastStep) {
    lastStep = step;
    if (walk > 0.5 && !airborne && fireW < 0.3) {
      // Even steps set the left foot down, odd the right.
      bones[step % 2 === 0 ? '足首L' : '足首R'].getWorldPosition(_v);
      dustRing(_v.x, _v.z + 0.4, 46, 4.5, 0.13);
    }
  }
  stepLoose(dt);

  // --- look ---
  bodyMat.uniforms.uTime.value = time;
  bodyMat.uniforms.uAssemble.value = assemble;
  bodyMat.uniforms.uThrough.value = damp(bodyMat.uniforms.uThrough.value, seeThrough ? 1 : 0, 10, dt);
  uWhite.value = damp(uWhite.value, white ? 1 : 0, 9, dt);
  body.visible = mode === 'particles';
  lines.visible = mode === 'wireframe';
  skinned.material = mode === 'full' ? fullMaterial : mode === 'wireframe' ? hatchMaterial : hideMaterial;
  skinned.visible = mode === 'full' || (!seeThrough && (mode === 'wireframe' || assemble > 0.9));

  // --- camera ---
  shake = damp(shake, 0, 9, dt);
  camDist = damp(camDist, camDistGoal, 7, dt);
  shift = damp(shift, shiftGoal, 7, dt);
  const w = window.innerWidth, h = window.innerHeight;
  camera.setViewOffset(w, h, 0, shift, w, h);
  const dist = camDist * zoom;
  const lookY = 5.1 + (jumpY + hover) * 0.45;
  camera.position.set(-Math.sin(yaw) * Math.cos(pitch) * dist, lookY + Math.sin(pitch) * dist + Math.sin(time * 55) * shake, Math.cos(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(0, lookY, 0);

  // --- readout (for screen readers) and key highlights ---
  const doing = [];
  if (jumpState !== 'ground') doing.push(jumpState === 'land' ? 'Landing' : 'Jumping');
  if (held.walk && !airborne) doing.push('Walking in place');
  if (held.crouch && !airborne) doing.push('Crouching');
  if (firingNow || kneelShot > 0) doing.push('Firing rifle');
  if (slashing) doing.push('Slashing');
  const text = doing.length ? doing[0] + doing.slice(1).map((d) => ', ' + d.toLowerCase()).join('') : 'Standing still';
  if (text !== statusText) statusEl.textContent = statusText = text;

  for (const act in held) if (act !== 'fire') setButton(act, held[act]);
  setButton('fire', held.fire || firingNow || kneelShot > 0);
  setButton('jump', jumpState !== 'ground');
  setButton('slash', slashing);
  setButton('xray', seeThrough);
}

const clock = new THREE.Clock();
function frame() {
  update(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
window.__running = true;
document.getElementById('loading').hidden = true;
frame();
