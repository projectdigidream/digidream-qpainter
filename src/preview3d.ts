import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

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
    const f = o.nearest ? THREE.NearestFilter : THREE.LinearFilter;
    if (tex.magFilter !== f) { tex.magFilter = f; tex.minFilter = o.nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter; }
    const rep = o.mesh === 'wall' ? 3 * o.repeat : o.repeat;
    tex.repeat.set(o.mesh === 'sphere' ? rep * 2 : rep, rep); // sphere UVs span 2:1
    tex.needsUpdate = true;
    lit.map = flat.map = tex;
    lit.needsUpdate = flat.needsUpdate = true;
    model.traverse((m) => { if (m instanceof THREE.Mesh) m.material = o.lit ? lit : flat; });
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
      dirty = true;
    },
    /** Options changed. */
    set() {
      if (meshName !== previewOpts.mesh) {
        meshName = previewOpts.mesh;
        scene.remove(model);
        if (model !== custom && model instanceof THREE.Mesh) model.geometry.dispose();
        model = meshName === 'custom' && custom ? custom : new THREE.Mesh(GEOMS[meshName](), lit);
        scene.add(model);
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
