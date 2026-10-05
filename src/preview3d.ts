import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { DOOM_SKY, SKY_DEFAULTS, dirToUV, faceRects, type SkyKind, type SkyParams } from './sky';

// Sky: a sphere around the camera, each fragment coloured by view direction with the DoomNet engine's
// own skyColour (client/src/render/sky.js), except that the cube reads the 2D cross being edited.
// Must match dirToUV() in sky.ts.
const SKY_VERT = `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `
uniform sampler2D map; uniform int kind; uniform vec2 size; uniform vec4 faces[6];
uniform float repeatTimes; uniform float yaw; uniform float height; uniform vec3 capTop; uniform vec3 capBottom;
varying vec3 vDir;
const float TAU = 6.28318530718;
void main() {
  vec3 d = normalize(vDir);
  float a = yaw * TAU;
  vec3 r = vec3(d.x * cos(a) - d.z * sin(a), d.y, d.x * sin(a) + d.z * cos(a));
  float turn = atan(r.x, -r.z) / TAU;
  vec3 col;
  if (kind == 0) {        // strip, exactly the engine's
    float t = r.y / max(length(r.xz), 1e-4);
    float bottom = -height * ${DOOM_SKY.below.toFixed(4)};
    float v = clamp((t - bottom) / (height - bottom), 0.0, 1.0);
    vec4 p = texture2D(map, vec2(fract(turn * repeatTimes), v));
    col = mix(t > 0.0 ? capTop : capBottom, p.rgb, step(0.5, p.a));
    col = mix(col, capTop, smoothstep(height, height + 0.3, t));
    col = mix(col, capBottom, smoothstep(bottom, bottom - 0.12, t));
  } else if (kind == 1) { // panorama, the engine's continuous-gradient lookup (no seam where the edges meet)
    float v = asin(clamp(r.y, -1.0, 1.0)) / 3.14159265359 + 0.5;
    float u = turn + 0.5, w = fract(turn + 1.0);
    vec2 gx = vec2(dFdx(u), dFdx(v)), gy = vec2(dFdy(u), dFdy(v));
    vec2 hx = vec2(dFdx(w), dFdx(v)), hy = vec2(dFdy(w), dFdy(v));
    if (abs(hx.x) + abs(hy.x) < abs(gx.x) + abs(gy.x)) { gx = hx; gy = hy; }
    col = textureGrad(map, vec2(u, v), gx, gy).rgb;
  } else {                // cube: the engine samples textureCube(vec3(-r.x, r.y, r.z)); here, the same face of the cross
    vec3 c = vec3(-r.x, r.y, r.z), b = abs(c);
    vec4 q; vec2 st; float m;
    if (b.x >= b.y && b.x >= b.z) { m = b.x; if (c.x > 0.0) { q = faces[0]; st = vec2(-c.z, -c.y); } else { q = faces[1]; st = vec2(c.z, -c.y); } }
    else if (b.y >= b.z) { m = b.y; if (c.y > 0.0) { q = faces[2]; st = vec2(c.x, c.z); } else { q = faces[3]; st = vec2(c.x, -c.z); } }
    else { m = b.z; if (c.z > 0.0) { q = faces[4]; st = vec2(c.x, -c.y); } else { q = faces[5]; st = vec2(-c.x, -c.y); } }
    vec2 half_ = 0.5 / (q.zw * size); // stay half a texel inside the face: no bleeding from the next one
    vec2 uv = q.xy + clamp((st / m + 1.0) * 0.5, half_, 1.0 - half_) * q.zw;
    col = textureLod(map, vec2(uv.x, 1.0 - uv.y), 0.0).rgb;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/** Square pyramid with the full texture on every face (ConeGeometry would stretch it around). */
function pyramid() {
  const t = [0, 0.5, 0], b = [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]];
  const pos: number[] = [], uv: number[] = [];
  for (let i = 0; i < 4; i++) { pos.push(...b[i], ...b[(i + 1) % 4], ...t); uv.push(0, 0, 1, 0, 0.5, 1); }
  pos.push(...b[0], ...b[3], ...b[2], ...b[0], ...b[2], ...b[1]);
  uv.push(0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

const GEOMS: Record<string, () => THREE.BufferGeometry> = {
  cube: () => new THREE.BoxGeometry(1, 1, 1),
  pyramid,
  sphere: () => new THREE.SphereGeometry(0.7, 48, 24),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 48),
  torus: () => new THREE.TorusGeometry(0.5, 0.22, 24, 64),
  plane: () => new THREE.PlaneGeometry(1.2, 1.2),
  wall: () => new THREE.PlaneGeometry(2.4, 2.4),
};
export const MESHES = Object.keys(GEOMS);

export const previewOpts = { mesh: 'cube', repeat: 1, nearest: true, lit: true, rotate: true, paint: false, bg: '#20242c' };

export type PaintEvent = 'down' | 'move' | 'up' | 'cancel';
/** `uv` is in image space: (0,0) top-left, (1,1) bottom-right, repeat already folded in. */
type OnPaint = (kind: PaintEvent, uv: THREE.Vector2 | null, e: PointerEvent) => void;

export function createPreview(host: HTMLElement, source: HTMLCanvasElement, onPaint: OnPaint) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(devicePixelRatio);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.set(1.6, 1.2, 2.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(2, 3, 2);
  scene.add(sun);

  // three can't resize a texture in place, so track the size it was created at
  let tex: THREE.CanvasTexture | null = null, tw = 0, th = 0;
  const lit = new THREE.MeshStandardMaterial({ transparent: true, alphaTest: 0.01, side: THREE.DoubleSide, roughness: 0.9 });
  const flat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.01, side: THREE.DoubleSide });
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, transparent: true, depthWrite: false,
    uniforms: {
      map: { value: null }, kind: { value: 0 }, size: { value: new THREE.Vector2(1, 1) }, faces: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
      repeatTimes: { value: DOOM_SKY.repeat }, yaw: { value: 0 }, height: { value: DOOM_SKY.height },
      capTop: { value: new THREE.Color() }, capBottom: { value: new THREE.Color() },
    },
  });
  // a strip fades into the average colour of its top and bottom 8 rows (the engine's caps)
  const caps = () => {
    const w = source.width, h = source.height, g = source.getContext('2d');
    if (!w || !h || !g) return;
    const avg = (y0: number, c: THREE.Color) => {
      const d = g.getImageData(0, y0, w, Math.min(8, h)).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      c.setRGB(n ? r / n / 255 : 0, n ? gg / n / 255 : 0, n ? b / n / 255 : 0, THREE.SRGBColorSpace);
    };
    avg(0, skyMat.uniforms.capTop.value);
    avg(Math.max(0, h - 8), skyMat.uniforms.capBottom.value);
  };
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), skyMat);
  let sky: SkyKind | null = null, params: SkyParams = { ...SKY_DEFAULTS }, objectView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let model: THREE.Object3D = new THREE.Mesh(GEOMS.cube(), lit);
  let custom: THREE.Object3D | null = null;
  scene.add(model);
  let dirty = true;

  const apply = () => {
    if (!tex || tw !== source.width || th !== source.height) {
      tex?.dispose();
      [tw, th] = [source.width, source.height];
      tex = new THREE.CanvasTexture(source);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    }
    const o = previewOpts;
    // inside a sky, filter as the engine does: a strip is pixel art, panoramas and cubes are smoothed
    const nearest = sky ? sky === 'strip' : o.nearest;
    const f = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    if (tex.magFilter !== f) { tex.magFilter = f; tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter; }
    const rep = o.mesh === 'wall' ? 3 * o.repeat : o.repeat;
    tex.repeat.set(o.mesh === 'sphere' ? rep * 2 : rep, rep); // sphere UVs span 2:1
    tex.needsUpdate = true;
    lit.map = flat.map = tex;
    lit.needsUpdate = flat.needsUpdate = true;
    model.traverse((m) => { if (m instanceof THREE.Mesh) m.material = o.lit ? lit : flat; });
    if (sky) {
      const w = source.width, h = source.height;
      const u = skyMat.uniforms;
      u.map.value = tex;
      u.kind.value = sky === 'strip' ? 0 : sky === 'panorama' ? 1 : 2;
      u.size.value.set(w, h);
      u.repeatTimes.value = params.repeat;
      u.yaw.value = params.yaw;
      u.height.value = params.height;
      faceRects(sky, w).forEach((r, i) => u.faces.value[i].set(r.x / w, r.y / h, r.w / w, r.h / h));
      if (sky === 'strip') caps();
    }
    scene.background = new THREE.Color(o.bg);
    controls.autoRotate = o.rotate && !painting;
    // paint mode: left/one finger paints, right/two fingers orbit
    controls.mouseButtons.LEFT = o.paint ? null : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = o.paint ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    controls.touches.ONE = o.paint ? null : THREE.TOUCH.ROTATE;
    dirty = true;
  };

  // ---- painting on the model ----
  const el = renderer.domElement, ray = new THREE.Raycaster(), ptrs = new Set<number>();
  let painting = false;
  const hitUV = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    if (sky) { const d = ray.ray.direction, uv = dirToUV(sky, [d.x, d.y, d.z], source.width, source.height, params); return uv && new THREE.Vector2(...uv); }
    const uv = ray.intersectObject(model, true)[0]?.uv?.clone();
    return uv && tex ? tex.transformUv(uv) : null; // applies repeat, wrapping and flipY
  };
  el.addEventListener('pointerdown', (e) => {
    if (!previewOpts.paint || e.button !== 0) return;
    ptrs.add(e.pointerId);
    if (ptrs.size > 1) { if (painting) { painting = false; onPaint('cancel', null, e); } return; }
    const uv = hitUV(e);
    if (!uv) return;
    painting = true;
    controls.autoRotate = false;
    onPaint('down', uv, e);
  });
  el.addEventListener('pointermove', (e) => {
    const uv = painting && hitUV(e);
    if (uv) onPaint('move', uv, e);
  });
  const up = (e: PointerEvent) => {
    ptrs.delete(e.pointerId);
    if (!painting) return;
    painting = false;
    controls.autoRotate = previewOpts.rotate;
    onPaint('up', null, e);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);

  let meshName = 'cube';
  controls.addEventListener('change', () => (dirty = true));
  // inside a sky the wheel zooms by narrowing the field of view
  el.addEventListener('wheel', (e) => {
    if (!sky) return;
    e.preventDefault();
    camera.fov = Math.min(110, Math.max(15, camera.fov * Math.exp(e.deltaY * 0.001)));
    camera.updateProjectionMatrix();
    dirty = true;
  }, { passive: false });
  new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    dirty = true;
  }).observe(host);
  renderer.setAnimationLoop(() => {
    controls.update();
    if (!dirty) return;
    dirty = false;
    renderer.render(scene, camera);
  });

  return {
    /** Texture pixels changed. */
    update() {
      if (!tex || tw !== source.width || th !== source.height) return apply();
      tex.needsUpdate = true;
      if (sky === 'strip') caps();
      dirty = true;
    },
    /** Options changed. */
    set() {
      if (meshName !== previewOpts.mesh) {
        meshName = previewOpts.mesh;
        scene.remove(model);
        if (model !== custom && model instanceof THREE.Mesh) model.geometry.dispose();
        model = meshName === 'custom' && custom ? custom : new THREE.Mesh(GEOMS[meshName](), lit);
        if (!sky) scene.add(model);
      }
      apply();
    },
    /** Switch between showing an object and standing inside a sky of the given kind. */
    setSky(t: SkyKind | null, p: SkyParams) {
      params = { ...p };
      if (t !== sky) {
        if (t && !sky) {
          objectView = { pos: camera.position.clone(), target: controls.target.clone() };
          scene.remove(model);
          scene.add(skyMesh);
          Object.assign(controls, { enableZoom: false, enablePan: false, rotateSpeed: -0.35 });
        } else if (!t && sky) {
          scene.remove(skyMesh);
          scene.add(model);
          camera.position.copy(objectView!.pos);
          controls.target.copy(objectView!.target);
          camera.fov = 40;
          Object.assign(controls, { enableZoom: true, enablePan: true, rotateSpeed: 1 });
        }
        if (t) {
          // stand at the centre facing the middle of the picture: south for a cube (the cross's centre), north otherwise
          controls.target.set(0, 0, 0);
          camera.position.set(0, 0, t === 'cube' ? -0.01 : 0.01);
          camera.fov = 75;
        }
        camera.updateProjectionMatrix();
        sky = t;
      }
      apply();
    },
    /** Load a .glb/.gltf (embedded) or .obj model; its UVs map the texture. */
    async load(file: File) {
      const obj = /\.obj$/i.test(file.name)
        ? new OBJLoader().parse(await file.text())
        : (await new GLTFLoader().parseAsync(await file.arrayBuffer(), '')).scene;
      let uvs = false;
      obj.traverse((m) => { if (m instanceof THREE.Mesh && m.geometry.attributes.uv) uvs = true; });
      if (!uvs) throw new Error('Model has no UV coordinates, so a texture cannot be mapped onto it.');
      // center and scale to ~the size of the built-in shapes
      const box = new THREE.Box3().setFromObject(obj), g = new THREE.Group();
      obj.position.sub(box.getCenter(new THREE.Vector3()));
      g.add(obj);
      g.scale.setScalar(1.6 / (box.getSize(new THREE.Vector3()).length() || 1));
      custom = g;
      meshName = '';
      previewOpts.mesh = 'custom';
      this.set();
    },
  };
}
