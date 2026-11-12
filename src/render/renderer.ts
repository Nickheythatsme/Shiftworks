// The renderer only reads the simulation. It keeps one instanced mesh per kind
// of thing and redraws them when the simulation's version counters say
// something changed. Motion (spinning drills, scrolling belts, smoke, swaying
// trees, sliding items) happens in shaders, driven by one time value.

import * as THREE from 'three';
import {
  BELT_SLOTS, BUILDINGS, GOALS, ITEMS, ITEM_BY_ID, ITEM_COUNT, TICKS_PER_SECOND, buildingId, type BuildingKey,
} from '../content/content';
import {
  CHUNK, CHUNK_SHIFT, DX, DY, HUB_X, HUB_Y, MAX_CHUNKS, MOVED_ENTERED, MOVED_SLOT, ROLE_BELT, ROLE_HUB, ROLE_MACHINE, ROLE_MINER,
  ROLE_SPLITTER, TERRAIN_WATER, type Chunk, type Sim,
} from '../sim';
import { hash3 } from '../sim/hash';
import { CameraRig } from './camera';
import {
  buildAssembler, buildBeltCurve, buildBeltStraight, buildBush, buildHub, buildItemShape, buildKiln, buildMiner,
  buildPine, buildRock, buildRoundTree, buildSawmill, buildSplitter, buildStump, buildTuft, PORT_IN, PORT_OUT,
  type ItemShape,
} from './models';

const ITEM_Y = 0.19;
const HAZE = 0x9fc0d2;
const WATER_LEVEL = -0.13;
const SEABED = -0.5;
/** Texels per tile in the painted ground texture. */
const TEXELS = 4;
const HUB_STAGES = 3;

interface Batch {
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Building slot drawn by each instance. */
  slots: Int32Array;
  state: THREE.InstancedBufferAttribute;
  count: number;
  /** Whether the state follows the building's work status. */
  live: boolean;
}

interface ItemBatch {
  shape: THREE.BufferGeometry;
  mesh: THREE.Mesh | null;
  capacity: number;
  prev: Float32Array;
  cur: Float32Array;
  color: Float32Array;
  count: number;
}

/** One kind of scenery in one chunk, so whole chunks can be skipped when out of view. */
interface SceneryPatch {
  chunk: Chunk;
  mesh: THREE.InstancedMesh;
  /** Where each piece could stand: its tile, transform and tint. */
  spots: { tile: number; matrix: THREE.Matrix4; color: THREE.Color | null }[];
}

/** A building whose inputs and outputs should be pointed out with arrows. */
export interface PortView {
  building: number;
  x: number;
  y: number;
  dir: number;
}

const MAX_PORT_ARROWS = 14;

/** A flat arrow lying in the ground plane, pointing along +X. */
function buildFlowArrow(): THREE.BufferGeometry {
  const v = [
    -0.26, -0.075, 0.02, -0.075, 0.02, 0.075,
    -0.26, -0.075, 0.02, 0.075, -0.26, 0.075,
    0.02, -0.2, 0.27, 0, 0.02, 0.2,
  ];
  const positions = new Float32Array((v.length / 2) * 3);
  for (let i = 0; i < v.length / 2; i++) {
    positions[i * 3] = v[i * 2];
    positions[i * 3 + 2] = v[i * 2 + 1];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export interface Ghost {
  building: number;
  x: number;
  y: number;
  dir: number;
  ok: boolean;
}

// ---- shaders -------------------------------------------------------------------

const BUILDING_VERTEX_PARS = /* glsl */ `
  attribute vec4 aAnim;
  attribute vec3 aPivot;
  attribute float aState;
  uniform float uTime;
  varying vec4 vAnim;
  varying float vState;
`;

const BUILDING_VERTEX = /* glsl */ `
  vAnim = aAnim;
  vState = aState;
  {
    float run = (aState > 0.5 && aState < 1.5) ? 1.0 : 0.0;
    int mode = int(aAnim.x + 0.5);
    vec3 rel = transformed - aPivot;
    if (mode == 2) {
      float a = uTime * aAnim.w * run;
      float c = cos(a), s = sin(a);
      transformed = aPivot + vec3(c * rel.x + s * rel.z, rel.y, c * rel.z - s * rel.x);
    } else if (mode == 3) {
      float a = uTime * aAnim.w * run;
      float c = cos(a), s = sin(a);
      transformed = aPivot + vec3(c * rel.x - s * rel.y, s * rel.x + c * rel.y, rel.z);
    } else if (mode == 4) {
      transformed.y += sin(uTime * aAnim.w + aAnim.y) * aAnim.z * run;
    } else if (mode == 7) {
      float f = fract(uTime * aAnim.w + aAnim.y);
      float size = run * (0.5 + 1.2 * f) * (1.0 - f * f);
      transformed = aPivot + rel * size + vec3(0.14 * sin(f * 5.0), f * aAnim.z, 0.0);
    } else if (mode == 8) {
      float a = sin(uTime * aAnim.w) * aAnim.y * run;
      float c = cos(a), s = sin(a);
      transformed = aPivot + vec3(c * rel.x + s * rel.z, rel.y, c * rel.z - s * rel.x);
    } else if (mode == 10) {
      float d = transformed.x - aPivot.x;
      transformed.z += sin(uTime * 5.0 - d * 9.0) * 0.1 * d;
    } else if (mode == 11) {
      float phase = 0.0;
      #ifdef USE_INSTANCING
        phase = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.9;
      #endif
      float bend = transformed.y * transformed.y * 0.22;
      transformed.x += sin(uTime * 1.6 + phase) * bend;
      transformed.z += cos(uTime * 1.3 + phase * 1.3) * bend;
    }
  }
`;

const BUILDING_FRAGMENT_PARS = /* glsl */ `
  varying vec4 vAnim;
  varying float vState;
  uniform float uTime;
  uniform float uBeltSpeed;
  vec3 statusColor(float s) {
    if (s < 0.5) return vec3(0.36, 0.38, 0.44);
    if (s < 1.5) return vec3(0.2, 0.95, 0.4);
    if (s < 2.5) return vec3(1.0, 0.7, 0.12);
    return vec3(1.0, 0.2, 0.16);
  }
`;

const BUILDING_FRAGMENT_COLOR = /* glsl */ `
  int fmode = int(vAnim.x + 0.5);
  float frun = (vState > 0.5 && vState < 1.5) ? 1.0 : 0.0;
  if (fmode == 1) {
    // Slats that travel along the belt at the speed the items move.
    float s = fract(vAnim.y * 4.0 - uTime * uBeltSpeed * 4.0);
    float slat = smoothstep(0.4, 0.5, s) * (1.0 - smoothstep(0.9, 1.0, s));
    diffuseColor.rgb *= mix(0.72, 1.3, slat);
  } else if (fmode == 6) {
    diffuseColor.rgb = statusColor(vState) * 0.3;
  } else if (fmode != 5 && fmode != 9 && vState > 1.5) {
    // A wash of amber or red over a machine that is starved or blocked.
    diffuseColor.rgb = mix(diffuseColor.rgb, statusColor(vState), 0.2);
  }
`;

const BUILDING_FRAGMENT_EMISSIVE = /* glsl */ `
  if (fmode == 5) {
    totalEmissiveRadiance += vColor.rgb * (0.1 + frun * (1.7 + 0.5 * sin(uTime * 11.0 + vAnim.y * 3.0)));
  } else if (fmode == 6) {
    totalEmissiveRadiance += statusColor(vState) * 1.6;
  } else if (fmode == 9) {
    totalEmissiveRadiance += vColor.rgb * 1.1;
  }
`;

const NOISE = /* glsl */ `
  float thash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float tnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(thash(i), thash(i + vec2(1.0, 0.0)), f.x), mix(thash(i + vec2(0.0, 1.0)), thash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

const TERRAIN_FRAGMENT = /* glsl */ `
  {
    // Fine grain so the ground is never a flat colour up close.
    vec2 wp = vWorld.xz - vec2(1000.0);
    float grain = tnoise(wp * 2.3) * 0.6 + tnoise(wp * 7.0) * 0.4;
    diffuseColor.rgb *= 0.86 + 0.26 * grain;
    if (vWorld.y > -0.03) {
      // A faint tile grid on land, fading out with distance.
      vec2 g = abs(fract(vWorld.xz) - 0.5);
      float line = smoothstep(0.46, 0.5, max(g.x, g.y));
      float near = 1.0 - smoothstep(30.0, 80.0, distance(vWorld, cameraPosition));
      diffuseColor.rgb *= 1.0 - 0.1 * line * near;
    } else {
      diffuseColor.rgb *= mix(1.0, 0.55, clamp(-vWorld.y * 2.4, 0.0, 1.0));
    }
  }
`;

const WATER_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uHaze;
  varying vec3 vWorld;
  ${NOISE}
  void main() {
    vec2 p = vWorld.xz - vec2(1000.0);
    float t = uTime;
    float w = tnoise(p * 0.55 + vec2(t * 0.22, t * 0.15)) + 0.5 * tnoise(p * 1.6 - vec2(t * 0.2, -t * 0.28));
    vec3 color = mix(vec3(0.07, 0.25, 0.42), vec3(0.16, 0.5, 0.66), smoothstep(0.35, 1.15, w));
    color += smoothstep(1.12, 1.3, w) * 0.22;
    float far = smoothstep(150.0, 480.0, distance(vWorld, cameraPosition));
    gl_FragColor = vec4(mix(color, uHaze, far), mix(0.74, 1.0, far));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const ITEM_VERTEX = /* glsl */ `
  attribute vec3 aPrev;
  attribute vec3 aCur;
  attribute vec3 aColor;
  uniform float uAlpha;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vHeight;
  void main() {
    vColor = aColor;
    vNormal = normal;
    vHeight = position.y;
    vec3 offset = mix(aPrev, aCur, uAlpha);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + offset, 1.0);
  }
`;

const ITEM_FRAGMENT = /* glsl */ `
  uniform vec3 uLight;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying float vHeight;
  void main() {
    vec3 n = normalize(vNormal);
    float sun = max(dot(n, uLight), 0.0);
    float sky = 0.5 + 0.5 * n.y;
    float lit = 0.38 + 0.36 * sky + 0.95 * sun;
    lit *= 0.82 + clamp(vHeight * 2.4 + 0.2, 0.0, 0.3);
    gl_FragColor = vec4(vColor * lit, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---- helpers -------------------------------------------------------------------

function rgb(color: number): [number, number, number] {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

function mix3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const GRASS_A = rgb(0x6f9f52);
const GRASS_B = rgb(0x8ab35c);
const GRASS_DRY = rgb(0xa3b565);
const SAND = rgb(0xdccb98);
const SHALLOW = rgb(0xc9bd8c);
const DEEP = rgb(0x5b7f86);
const DEPOSIT_GROUND: Record<string, [number, number, number]> = {
  timber: rgb(0x55783f),
  stone: rgb(0x9c9c94),
  iron_ore: rgb(0x8f6452),
  copper_ore: rgb(0xb97c4e),
  coal: rgb(0x45454b),
};

/** Smooth value noise from integer hashes, 0 to 1. Used to paint the ground. */
function valueNoise(seed: number, x: number, y: number, size: number): number {
  const gx = Math.floor(x / size);
  const gy = Math.floor(y / size);
  let fx = x / size - gx;
  let fy = y / size - gy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = (hash3(seed, gx, gy) & 1023) / 1023;
  const b = (hash3(seed, gx + 1, gy) & 1023) / 1023;
  const c = (hash3(seed, gx, gy + 1) & 1023) / 1023;
  const d = (hash3(seed, gx + 1, gy + 1) & 1023) / 1023;
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

export class GameRenderer {
  readonly rig = new CameraRig();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight(0xfff0d6, 3.1);
  private sim: Sim;

  private readonly time = { value: 0 };
  private readonly beltSpeed = { value: 1.5 };
  private readonly buildingMaterial: THREE.MeshLambertMaterial;
  private readonly models = new Map<string, THREE.BufferGeometry>();
  private readonly batches = new Map<string, Batch>();
  private readonly beltId = buildingId('belt');
  private readonly hubId = buildingId('hub');

  /** Ground mesh per chunk, with the map size it was built for. */
  private readonly chunkMeshes = new Map<Chunk, { mesh: THREE.Mesh; radius: number }>();
  /** Chunks whose ground still has to be built, nearest the camera first. */
  private chunkQueue: Chunk[] = [];
  private readonly water: THREE.Mesh;
  private readonly sceneryModels: THREE.BufferGeometry[];
  private readonly sceneryPatches: SceneryPatch[] = [];

  private readonly itemBatches = new Map<ItemShape, ItemBatch>();
  private readonly itemShapeOf: (ItemBatch | undefined)[] = [];
  private readonly itemMaterial: THREE.ShaderMaterial;
  private readonly itemColors: THREE.Color[] = [];
  itemCount = 0;

  /** For each belt: the side its curve comes in from, or -1 when it runs straight. */
  private beltEntry = new Int8Array(0);

  private seenTopology = -1;
  private seenBeltStep = -1;
  private seenWorld = -1;
  private seenStage = -1;
  private statusTimer = 0;

  private readonly ghostMeshes = new Map<number, THREE.Mesh>();
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x7dffa0, transparent: true, opacity: 0.55, depthWrite: false });
  private readonly cursor: THREE.LineLoop;
  private readonly selection: THREE.LineLoop;
  private readonly portArrows: { mesh: THREE.Mesh; x: number; z: number; dx: number; dz: number; into: boolean }[] = [];
  private readonly portOut = new THREE.MeshBasicMaterial({ color: PORT_OUT, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide });
  private readonly portIn = new THREE.MeshBasicMaterial({ color: PORT_IN, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide });
  private portCount = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternions = [0, 1, 2, 3].map((d) =>
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-d * Math.PI) / 2),
  );
  private readonly position = new THREE.Vector3();
  private readonly unit = new THREE.Vector3(1, 1, 1);

  constructor(canvas: HTMLCanvasElement, sim: Sim) {
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Pixels have a budget too: never draw at more than 1.5x the layout size.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(HAZE);
    this.scene.fog = new THREE.Fog(HAZE, 150, 480);

    this.scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x8a7a58, 1.25));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2.5;
    this.scene.add(this.sun, this.sun.target);

    this.buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.buildingMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.uniforms.uBeltSpeed = this.beltSpeed;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BUILDING_VERTEX_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BUILDING_VERTEX}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${BUILDING_FRAGMENT_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${BUILDING_FRAGMENT_COLOR}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${BUILDING_FRAGMENT_EMISSIVE}`);
    };
    this.buildingMaterial.customProgramCacheKey = () => 'shiftworks-building';

    this.models.set('belt', buildBeltStraight());
    this.models.set('belt_r', buildBeltCurve(false));
    this.models.set('belt_l', buildBeltCurve(true));
    this.models.set('splitter', buildSplitter());
    this.models.set('miner', buildMiner());
    this.models.set('sawmill', buildSawmill());
    this.models.set('kiln', buildKiln());
    this.models.set('assembler', buildAssembler());
    for (let stage = 0; stage < HUB_STAGES; stage++) this.models.set(`hub${stage}`, buildHub(stage));

    for (const def of BUILDINGS) {
      const geometry = this.models.get(def.key === 'hub' ? 'hub0' : def.key)!;
      const ghost = new THREE.Mesh(geometry, this.ghostMaterial);
      ghost.visible = false;
      ghost.renderOrder = 2;
      this.ghostMeshes.set(def.id, ghost);
      this.scene.add(ghost);
    }

    // Items: one batch per shape, all sharing one shader.
    for (let id = 0; id < ITEM_COUNT; id++) this.itemColors[id] = new THREE.Color(ITEM_BY_ID[id]?.color ?? 0xffffff);
    this.itemMaterial = new THREE.ShaderMaterial({
      vertexShader: ITEM_VERTEX,
      fragmentShader: ITEM_FRAGMENT,
      uniforms: { uAlpha: { value: 1 }, uLight: { value: new THREE.Vector3(0.5, 0.78, 0.38).normalize() } },
    });
    for (const item of ITEMS) {
      let batch = this.itemBatches.get(item.shape);
      if (!batch) {
        batch = {
          shape: buildItemShape(item.shape), mesh: null, capacity: 0,
          prev: new Float32Array(0), cur: new Float32Array(0), color: new Float32Array(0), count: 0,
        };
        this.itemBatches.set(item.shape, batch);
      }
      this.itemShapeOf[item.id] = batch;
    }

    // Scenery kinds, in the order `placeScenery` refers to them.
    this.sceneryModels = [buildPine(0), buildPine(1), buildRoundTree(), buildBush(), buildTuft(), buildRock(), buildStump()];

    // One sheet of water under the whole world. The land rises out of it.
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
        uniforms: { uTime: this.time, uHaze: { value: new THREE.Color(HAZE) } },
        transparent: true,
        depthWrite: false,
      }),
    );
    this.water.position.set(HUB_X, WATER_LEVEL, HUB_Y);
    this.water.renderOrder = 1;
    this.scene.add(this.water);

    const flowArrow = buildFlowArrow();
    for (let i = 0; i < MAX_PORT_ARROWS; i++) {
      const mesh = new THREE.Mesh(flowArrow, this.portOut);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      this.portArrows.push({ mesh, x: 0, z: 0, dx: 0, dz: 0, into: false });
      this.scene.add(mesh);
    }

    this.cursor = this.makeOutline(0xffffff, 0.5);
    this.selection = this.makeOutline(0xffe08a, 0.56);
    this.scene.add(this.cursor, this.selection);

    this.setSim(sim);
  }

  private makeOutline(color: number, half: number): THREE.LineLoop {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-half, 0.03, -half),
      new THREE.Vector3(half, 0.03, -half),
      new THREE.Vector3(half, 0.03, half),
      new THREE.Vector3(-half, 0.03, half),
    ]);
    const line = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.renderOrder = 3;
    line.visible = false;
    return line;
  }

  /** Points the renderer at a new simulation, for example after loading a save. */
  setSim(sim: Sim): void {
    this.sim = sim;
    this.beltSpeed.value = TICKS_PER_SECOND / (sim.beltPeriod * BELT_SLOTS);
    this.seenTopology = -1;
    this.seenBeltStep = -1;
    this.seenWorld = -1;
    this.seenStage = -1;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.rig.setAspect(width / Math.max(1, height));
  }

  /** The tile under a point on the canvas, or null if the ray misses the ground. */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    const { origin, direction } = this.raycaster.ray;
    if (direction.y >= -1e-6) return null;
    const t = -origin.y / direction.y;
    return { x: Math.floor(origin.x + direction.x * t), y: Math.floor(origin.z + direction.z * t) };
  }

  setGhost(ghost: Ghost | null): void {
    for (const mesh of this.ghostMeshes.values()) mesh.visible = false;
    if (!ghost) return;
    const mesh = this.ghostMeshes.get(ghost.building);
    if (!mesh) return;
    mesh.visible = true;
    mesh.position.set(ghost.x + 0.5, 0.02, ghost.y + 0.5);
    mesh.quaternion.copy(this.quaternions[ghost.dir & 3]);
    this.ghostMaterial.color.setHex(ghost.ok ? 0x7dffa0 : 0xff5a5a);
  }

  /**
   * Points out where a building takes items in (blue arrows) and where it
   * pushes them out (orange arrows). Pass null to hide them.
   */
  setPorts(view: PortView | null): void {
    this.portCount = 0;
    if (view) {
      const def = BUILDINGS.find((b) => b.id === view.building);
      const d = view.dir & 3;
      const back = (d + 2) & 3;
      const right = (d + 1) & 3;
      const left = (d + 3) & 3;
      const cx = view.x + 0.5;
      const cz = view.y + 0.5;
      const add = (side: number, into: boolean, reach = 0.8, slide = 0) => {
        const arrow = this.portArrows[this.portCount++];
        // `slide` moves the arrow along the edge, for buildings wider than a tile.
        arrow.x = cx + DX[side] * reach + DX[(side + 1) & 3] * slide;
        arrow.z = cz + DY[side] * reach + DY[(side + 1) & 3] * slide;
        const facing = into ? (side + 2) & 3 : side;
        arrow.dx = DX[facing];
        arrow.dz = DY[facing];
        arrow.into = into;
        arrow.mesh.material = into ? this.portIn : this.portOut;
        arrow.mesh.quaternion.copy(this.quaternions[facing]);
      };
      switch (def?.role) {
        case 'belt':
          add(d, false);
          add(back, true);
          break;
        case 'miner':
          add(d, false);
          break;
        case 'machine':
          add(d, false);
          add(back, true);
          add(right, true);
          add(left, true);
          break;
        case 'splitter':
          add(back, true);
          add(d, false);
          add(right, false);
          add(left, false);
          break;
        case 'hub':
          for (let side = 0; side < 4; side++) for (const slide of [-1, 0, 1]) add(side, true, 1.8, slide);
          break;
      }
    }
    for (let i = 0; i < this.portArrows.length; i++) this.portArrows[i].mesh.visible = i < this.portCount;
  }

  setCursor(tile: { x: number; y: number } | null, color = 0xffffff): void {
    this.cursor.visible = tile !== null;
    if (tile) {
      this.cursor.position.set(tile.x + 0.5, 0, tile.y + 0.5);
      (this.cursor.material as THREE.LineBasicMaterial).color.setHex(color);
    }
  }

  setSelection(tile: { x: number; y: number } | null): void {
    this.selection.visible = tile !== null;
    if (tile) this.selection.position.set(tile.x + 0.5, 0, tile.y + 0.5);
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }

  /** Which of the hub's looks the town has grown into. */
  private hubStage(): number {
    const stages: string[] = [];
    for (const goal of GOALS) if (!stages.includes(goal.stage)) stages.push(goal.stage);
    const goal = GOALS[this.sim.goalIndex];
    const stage = goal ? stages.indexOf(goal.stage) : stages.length;
    return Math.min(stage, HUB_STAGES - 1);
  }

  /**
   * Draws one frame. `alpha` is how far the simulation is into the next tick,
   * from 0 to 1, so belt items glide between ticks.
   */
  render(alpha: number, dt: number): void {
    const sim = this.sim;
    if (this.seenWorld !== sim.world.version) {
      this.seenWorld = sim.world.version;
      this.syncTerrain();
      this.placeScenery();
      this.seenTopology = -1;
    }
    if (this.chunkQueue.length > 0) this.buildQueuedTerrain();
    const stage = this.hubStage();
    if (this.seenStage !== stage) {
      this.seenStage = stage;
      this.seenTopology = -1;
    }
    if (this.seenTopology !== sim.topologyVersion) {
      this.seenTopology = sim.topologyVersion;
      this.syncBuildings();
      this.syncScenery();
      this.seenBeltStep = -1;
      this.statusTimer = 0;
    }
    if (this.seenBeltStep !== sim.beltStepVersion) {
      this.seenBeltStep = sim.beltStepVersion;
      this.syncItems();
    }
    this.statusTimer -= dt;
    if (this.statusTimer <= 0) {
      this.statusTimer = 0.2;
      this.syncStatus();
    }

    // Flow arrows slide the way items travel. They keep moving while the game is paused.
    const beat = (performance.now() / 700) % 1;
    for (let i = 0; i < this.portCount; i++) {
      const arrow = this.portArrows[i];
      const shift = (beat - 0.5) * 0.22;
      arrow.mesh.position.set(arrow.x + arrow.dx * shift, 0.62, arrow.z + arrow.dz * shift);
    }
    const pulse = 0.65 + 0.35 * Math.sin(beat * Math.PI);
    this.portOut.opacity = pulse;
    this.portIn.opacity = pulse;

    this.time.value = ((sim.tick + alpha) / TICKS_PER_SECOND) % 3600;
    const sinceStep = sim.tick - sim.lastBeltStepTick + alpha;
    this.itemMaterial.uniforms.uAlpha.value = THREE.MathUtils.clamp(sinceStep / sim.beltPeriod, 0, 1);

    this.rig.min = sim.world.minTile;
    this.rig.max = sim.world.maxTile + 1;
    this.rig.update(dt);

    // The sun follows the camera so its one shadow map always covers the view.
    const reach = Math.min(this.rig.distance * 0.9 + 8, 90);
    const shadowCamera = this.sun.shadow.camera;
    if (shadowCamera.right !== reach) {
      shadowCamera.left = -reach;
      shadowCamera.right = reach;
      shadowCamera.top = reach;
      shadowCamera.bottom = -reach;
      shadowCamera.near = 1;
      shadowCamera.far = 400;
      shadowCamera.updateProjectionMatrix();
    }
    this.sun.target.position.copy(this.rig.target);
    this.sun.position.set(this.rig.target.x + 70, 105, this.rig.target.z + 50);

    this.renderer.render(this.scene, this.rig.camera);
  }

  // ---- terrain ---------------------------------------------------------------

  /**
   * Queues the ground that needs building: every new chunk, and the chunks that
   * were on the old edge of the map, whose beaches are now inland.
   */
  private syncTerrain(): void {
    const world = this.sim.world;
    for (const [chunk, entry] of this.chunkMeshes) {
      if (world.chunks.includes(chunk)) continue;
      this.disposeChunk(entry.mesh);
      this.chunkMeshes.delete(chunk);
    }
    const mid = MAX_CHUNKS / 2;
    this.chunkQueue = world.chunks.filter((chunk) => {
      const entry = this.chunkMeshes.get(chunk);
      if (!entry) return true;
      if (entry.radius === world.radius) return false;
      const r = entry.radius;
      return chunk.cx === mid - r || chunk.cx === mid + r - 1 || chunk.cy === mid - r || chunk.cy === mid + r - 1;
    });
    const tx = this.rig.target.x / CHUNK - 0.5;
    const tz = this.rig.target.z / CHUNK - 0.5;
    const far = (c: Chunk) => (c.cx - tx) ** 2 + (c.cy - tz) ** 2;
    this.chunkQueue.sort((a, b) => far(b) - far(a));
  }

  /** Builds queued ground for a few milliseconds, so a growing map never stalls a frame for long. */
  private buildQueuedTerrain(): void {
    const start = performance.now();
    while (this.chunkQueue.length > 0 && performance.now() - start < 7) {
      const chunk = this.chunkQueue.pop()!;
      const old = this.chunkMeshes.get(chunk);
      if (old) this.disposeChunk(old.mesh);
      const material = new THREE.MeshLambertMaterial({ map: this.paintChunk(chunk) });
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\n${NOISE}`)
          .replace('#include <map_fragment>', `#include <map_fragment>\n${TERRAIN_FRAGMENT}`);
      };
      material.customProgramCacheKey = () => 'shiftworks-terrain';
      const mesh = new THREE.Mesh(this.shapeChunk(chunk), material);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.chunkMeshes.set(chunk, { mesh, radius: this.sim.world.radius });
      this.scene.add(mesh);
    }
  }

  private disposeChunk(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    const material = mesh.material as THREE.MeshLambertMaterial;
    material.map?.dispose();
    material.dispose();
  }

  /**
   * The ground. Land tiles are flat squares. Each water tile dips to a point in
   * its middle, so every shore slopes into the water within half a tile and even
   * a one-tile stream holds water. Corners and edges that touch land stay level.
   */
  private shapeChunk(chunk: Chunk): THREE.BufferGeometry {
    const world = this.sim.world;
    const x0 = chunk.cx << CHUNK_SHIFT;
    const y0 = chunk.cy << CHUNK_SHIFT;
    const wet = (x: number, y: number) => world.terrainAt(x, y) === TERRAIN_WATER;
    // Points sit on a half-tile grid, created only where a triangle uses them.
    const side = CHUNK * 2 + 1;
    const lookup = new Int32Array(side * side).fill(-1);
    const positions: number[] = [];
    const uvs: number[] = [];
    const index: number[] = [];
    const point = (hx: number, hy: number): number => {
      const key = hy * side + hx;
      if (lookup[key] >= 0) return lookup[key];
      // The tiles this point touches: one for a centre, two for an edge, four for a corner.
      const xa = x0 + ((hx - 1) >> 1);
      const xb = x0 + (hx >> 1);
      const ya = y0 + ((hy - 1) >> 1);
      const yb = y0 + (hy >> 1);
      const sunk = wet(xa, ya) && wet(xb, ya) && wet(xa, yb) && wet(xb, yb);
      const n = positions.length / 3;
      positions.push(x0 + hx / 2, sunk ? SEABED : 0, y0 + hy / 2);
      uvs.push(hx / (side - 1), hy / (side - 1));
      lookup[key] = n;
      return n;
    };
    const ring = [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [1, 0]];
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const hx = tx * 2;
        const hy = ty * 2;
        if (wet(x0 + tx, y0 + ty)) {
          const centre = point(hx + 1, hy + 1);
          for (let k = 0; k < 8; k++) {
            const p = ring[k];
            const q = ring[(k + 1) & 7];
            index.push(centre, point(hx + p[0], hy + p[1]), point(hx + q[0], hy + q[1]));
          }
        } else {
          const a = point(hx, hy);
          const b = point(hx + 2, hy);
          const c = point(hx, hy + 2);
          const d = point(hx + 2, hy + 2);
          index.push(a, c, b, b, c, d);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(index), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Paints a chunk's ground: two tones of grass, dry patches, sand along every
   * shore, and each deposit's own soil. Edges are jittered so nothing follows
   * the tile grid exactly.
   */
  private paintChunk(chunk: Chunk): THREE.DataTexture {
    const world = this.sim.world;
    const seed = world.seed;
    const size = CHUNK * TEXELS;
    const data = new Uint8Array(size * size * 4);
    const x0 = chunk.cx << CHUNK_SHIFT;
    const y0 = chunk.cy << CHUNK_SHIFT;
    const wet = (x: number, y: number) => world.terrainAt(x, y) === TERRAIN_WATER;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const h = hash3(seed ^ 0x7e11, x0 * TEXELS + px, y0 * TEXELS + py);
        const wx = x0 + (px + 0.5) / TEXELS;
        const wy = y0 + (py + 0.5) / TEXELS;
        const tx = Math.floor(wx + ((h & 255) / 255 - 0.5) * 0.55);
        const ty = Math.floor(wy + (((h >> 8) & 255) / 255 - 0.5) * 0.55);
        let color: [number, number, number];
        if (wet(tx, ty)) {
          const nearLand = !wet(tx - 1, ty) || !wet(tx + 1, ty) || !wet(tx, ty - 1) || !wet(tx, ty + 1);
          color = nearLand ? SHALLOW : DEEP;
        } else {
          const deposit = world.depositAt(tx, ty);
          const patch = valueNoise(seed ^ 0x9a55, wx, wy, 9);
          const dry = valueNoise(seed ^ 0x0d27, wx, wy, 23);
          color = mix3(GRASS_A, GRASS_B, patch);
          if (dry > 0.62) color = mix3(color, GRASS_DRY, Math.min(1, (dry - 0.62) * 4));
          if (deposit) {
            color = mix3(color, DEPOSIT_GROUND[ITEM_BY_ID[deposit]?.key ?? ''] ?? color, 0.82);
          } else if (wet(tx - 1, ty) || wet(tx + 1, ty) || wet(tx, ty - 1) || wet(tx, ty + 1)) {
            color = mix3(color, SAND, 0.8);
          }
        }
        const speckle = 0.94 + ((h >> 16) & 255) / 255 * 0.12;
        const o = (py * size + px) * 4;
        data[o] = Math.min(255, color[0] * speckle);
        data[o + 1] = Math.min(255, color[1] * speckle);
        data[o + 2] = Math.min(255, color[2] * speckle);
        data[o + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  // ---- scenery ---------------------------------------------------------------

  /** Decides where every tree, rock and tuft could stand. Runs when the map grows. */
  private placeScenery(): void {
    const world = this.sim.world;
    const seed = world.seed;
    for (const patch of this.sceneryPatches) {
      this.scene.remove(patch.mesh);
      patch.mesh.dispose();
    }
    this.sceneryPatches.length = 0;
    let spots: SceneryPatch['spots'][] = [];
    const [PINE_A, PINE_B, ROUND, BUSH, TUFT, ROCK, STUMP] = [0, 1, 2, 3, 4, 5, 6];
    const grey = new THREE.Color(0x9a9a94);
    const wet = (x: number, y: number) => world.terrainAt(x, y) === TERRAIN_WATER;
    const add = (kind: number, _chunk: Chunk, tile: number, x: number, z: number, scale: number, turn: number, color: THREE.Color | null) => {
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn),
        new THREE.Vector3(scale, scale, scale),
      );
      spots[kind].push({ tile, matrix, color });
    };
    for (const chunk of world.chunks) {
      spots = this.sceneryModels.map(() => []);
      for (let i = 0; i < chunk.terrain.length; i++) {
        if (chunk.terrain[i] === TERRAIN_WATER) continue;
        const tx = (chunk.cx << CHUNK_SHIFT) + (i & (CHUNK - 1));
        const ty = (chunk.cy << CHUNK_SHIFT) + (i >> CHUNK_SHIFT);
        const deposit = chunk.deposit[i];
        // Three independent random numbers per tile.
        const h1 = hash3(seed ^ 0x5ce1, tx, ty);
        const h2 = hash3(seed ^ 0x5ce2, tx, ty);
        const h3 = hash3(seed ^ 0x5ce3, tx, ty);
        const at = (h: number, shift: number) => 0.22 + (((h >>> shift) & 255) / 255) * 0.56;
        const turn = ((h1 >>> 20) & 255) / 255 * Math.PI * 2;
        if (deposit === 1) {
          // A stand of timber: two or three pines to a tile.
          add((h1 & 1) ? PINE_A : PINE_B, chunk, i, tx + at(h1, 0), ty + at(h1, 8), 1.0 + ((h1 >>> 16) & 7) * 0.05, turn, null);
          add((h2 & 1) ? PINE_A : PINE_B, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 0.8 + ((h2 >>> 16) & 7) * 0.05, turn + 1, null);
          if ((h3 & 3) === 0) add(STUMP, chunk, i, tx + at(h3, 0), ty + at(h3, 8), 1, turn, null);
          else if ((h3 & 3) === 1) add(PINE_B, chunk, i, tx + at(h3, 0), ty + at(h3, 8), 0.65, turn + 2, null);
        } else if (deposit) {
          const ore = new THREE.Color(ITEM_BY_ID[deposit]?.color ?? 0x9a9a94);
          const tint = grey.clone().lerp(ore, deposit === 2 ? 0.25 : 0.85);
          add(ROCK, chunk, i, tx + at(h1, 0), ty + at(h1, 8), 1.2 + ((h1 >>> 16) & 7) * 0.08, turn, tint);
          add(ROCK, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 0.75 + ((h2 >>> 16) & 7) * 0.06, turn + 2, tint);
        } else {
          const shore = wet(tx - 1, ty) || wet(tx + 1, ty) || wet(tx, ty - 1) || wet(tx, ty + 1);
          const roll = h1 % 1000;
          if (shore) {
            if (roll < 30) add(ROCK, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 0.8, turn, grey);
          } else if (roll < 90) {
            add(TUFT, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 1 + ((h2 >>> 16) & 7) * 0.1, turn, null);
            if (roll < 40) add(TUFT, chunk, i, tx + at(h3, 0), ty + at(h3, 8), 0.9, turn + 1, null);
          } else if (roll < 112) {
            add(BUSH, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 1 + ((h2 >>> 16) & 7) * 0.08, turn, null);
          } else if (roll < 126) {
            add(ROUND, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 1.1 + ((h2 >>> 16) & 7) * 0.08, turn, null);
          } else if (roll < 134) {
            add(ROCK, chunk, i, tx + at(h2, 0), ty + at(h2, 8), 0.7 + ((h2 >>> 16) & 7) * 0.06, turn, grey);
          }
        }
      }
      const centre = new THREE.Vector3((chunk.cx << CHUNK_SHIFT) + CHUNK / 2, 0, (chunk.cy << CHUNK_SHIFT) + CHUNK / 2);
      for (let kind = 0; kind < spots.length; kind++) {
        if (spots[kind].length === 0) continue;
        const mesh = new THREE.InstancedMesh(this.sceneryModels[kind], this.buildingMaterial, spots[kind].length);
        mesh.castShadow = true;
        mesh.boundingSphere = new THREE.Sphere(centre, CHUNK * 0.75);
        this.sceneryPatches.push({ chunk, mesh, spots: spots[kind] });
        this.scene.add(mesh);
      }
    }
  }

  /** Shows the scenery on every tile that has nothing built on it. */
  private syncScenery(): void {
    for (const patch of this.sceneryPatches) {
      const mesh = patch.mesh;
      const built = patch.chunk.building;
      let n = 0;
      for (const spot of patch.spots) {
        if (built[spot.tile]) continue;
        mesh.setMatrixAt(n, spot.matrix);
        if (spot.color) mesh.setColorAt(n, spot.color);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- buildings -------------------------------------------------------------

  /** Which model draws the building in a slot. */
  private modelFor(s: number): string {
    const sim = this.sim;
    const kind = sim.kind[s];
    if (kind === this.beltId) {
      const entry = this.beltEntry[s];
      if (entry < 0) return 'belt';
      return entry === ((sim.dir[s] + 1) & 3) ? 'belt_r' : 'belt_l';
    }
    if (kind === this.hubId) return `hub${this.seenStage}`;
    return (BUILDINGS.find((b) => b.id === kind)?.key ?? 'belt') as BuildingKey;
  }

  private syncBuildings(): void {
    const sim = this.sim;
    if (this.beltEntry.length < sim.capacity) this.beltEntry = new Int8Array(sim.capacity);
    const counts = new Map<string, number>();
    const modelOf: string[] = new Array(sim.count);
    for (let s = 0; s < sim.count; s++) {
      if (!sim.kind[s]) continue;
      if (sim.role(s) === ROLE_BELT) this.beltEntry[s] = this.findBeltEntry(s);
      const key = this.modelFor(s);
      modelOf[s] = key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const batch of this.batches.values()) batch.count = 0;
    for (const [key, needed] of counts) {
      let batch = this.batches.get(key);
      if (!batch || batch.capacity < needed) {
        if (batch) {
          this.scene.remove(batch.mesh);
          batch.mesh.geometry.dispose();
          batch.mesh.dispose();
        }
        const capacity = Math.max(32, needed * 2);
        const model = this.models.get(key)!;
        // Share the model's vertex data and add one state value per instance.
        const geometry = new THREE.BufferGeometry();
        for (const name of Object.keys(model.attributes)) geometry.setAttribute(name, model.getAttribute(name));
        geometry.boundingSphere = model.boundingSphere;
        const state = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
        state.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('aState', state);
        const mesh = new THREE.InstancedMesh(geometry, this.buildingMaterial, capacity);
        // Belts are the most numerous thing by far and lie flat: skip their shadows.
        mesh.castShadow = !key.startsWith('belt');
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        const live = key === 'miner' || key === 'sawmill' || key === 'kiln' || key === 'assembler';
        batch = { mesh, capacity, slots: new Int32Array(capacity), state, count: 0, live };
        this.batches.set(key, batch);
        this.scene.add(mesh);
      }
    }

    for (let s = 0; s < sim.count; s++) {
      const key = modelOf[s];
      if (!key) continue;
      const batch = this.batches.get(key)!;
      const i = batch.count++;
      batch.slots[i] = s;
      this.position.set(sim.bx[s] + 0.5, 0, sim.by[s] + 0.5);
      this.matrix.compose(this.position, this.quaternions[sim.role(s) === ROLE_HUB ? 0 : sim.dir[s]], this.unit);
      batch.mesh.setMatrixAt(i, this.matrix);
    }
    for (const batch of this.batches.values()) {
      batch.mesh.count = batch.count;
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Does the building on (x, y) push items onto the tile (tx, ty)? */
  private feeds(x: number, y: number, tx: number, ty: number): boolean {
    const sim = this.sim;
    const s = sim.world.buildingAt(x, y);
    if (s < 0) return false;
    const role = sim.role(s);
    const d = sim.dir[s];
    if (role === ROLE_BELT || role === ROLE_MINER || role === ROLE_MACHINE) {
      return sim.bx[s] + DX[d] === tx && sim.by[s] + DY[d] === ty;
    }
    if (role === ROLE_SPLITTER) {
      return !(sim.bx[s] - DX[d] === tx && sim.by[s] - DY[d] === ty);
    }
    return false;
  }

  private findBeltEntry(s: number): number {
    const sim = this.sim;
    const x = sim.bx[s];
    const y = sim.by[s];
    const d = sim.dir[s];
    const back = (d + 2) & 3;
    if (this.feeds(x + DX[back], y + DY[back], x, y)) return -1;
    const right = (d + 1) & 3;
    const left = (d + 3) & 3;
    const fromRight = this.feeds(x + DX[right], y + DY[right], x, y);
    const fromLeft = this.feeds(x + DX[left], y + DY[left], x, y);
    if (fromRight === fromLeft) return -1;
    return fromRight ? right : left;
  }

  /** Tells each machine's shader whether it is working, starved, blocked or idle. */
  private syncStatus(): void {
    const sim = this.sim;
    for (const batch of this.batches.values()) {
      if (!batch.live) continue;
      const state = batch.state.array as Float32Array;
      for (let i = 0; i < batch.count; i++) state[i] = sim.status[batch.slots[i]];
      batch.state.needsUpdate = true;
    }
  }

  // ---- belt items ------------------------------------------------------------

  /**
   * Uploads where every belt item was and is. The shader slides each one between
   * the two, so this runs once per belt beat and not once per frame.
   */
  private syncItems(): void {
    const sim = this.sim;
    for (const batch of this.itemBatches.values()) batch.count = 0;
    const end = sim.count * BELT_SLOTS;
    for (let i = 0; i < end; i++) {
      const item = sim.slots[i];
      if (item) this.itemShapeOf[item]!.count++;
    }
    for (const batch of this.itemBatches.values()) {
      if (batch.count > batch.capacity) this.resizeItems(batch, Math.max(256, batch.count * 2));
      batch.count = 0;
    }

    let total = 0;
    for (let s = 0; s < sim.count; s++) {
      const role = sim.role(s);
      if (role !== ROLE_BELT && role !== ROLE_SPLITTER) continue;
      const base = s * BELT_SLOTS;
      const cx = sim.bx[s] + 0.5;
      const cz = sim.by[s] + 0.5;
      const d = sim.dir[s];
      const entry = role === ROLE_BELT ? this.beltEntry[s] : -1;
      const slotCount = role === ROLE_BELT ? BELT_SLOTS : 1;
      for (let k = 0; k < slotCount; k++) {
        const item = sim.slots[base + k];
        if (!item) continue;
        const batch = this.itemShapeOf[item]!;
        const o = batch.count * 3;
        const y = role === ROLE_BELT ? ITEM_Y : ITEM_Y + 0.33;
        const at = role === ROLE_BELT ? (k + 0.5) / BELT_SLOTS : 0.5;
        this.pathPoint(batch.cur, o, cx, cz, d, entry, at, y);
        const moved = sim.moved[base + k];
        if (moved === MOVED_SLOT) {
          this.pathPoint(batch.prev, o, cx, cz, d, entry, (k - 0.5) / BELT_SLOTS, y);
        } else if (moved >= MOVED_ENTERED) {
          const side = moved - MOVED_ENTERED;
          batch.prev[o] = cx + DX[side] * 0.625;
          batch.prev[o + 1] = ITEM_Y;
          batch.prev[o + 2] = cz + DY[side] * 0.625;
        } else {
          batch.prev[o] = batch.cur[o];
          batch.prev[o + 1] = batch.cur[o + 1];
          batch.prev[o + 2] = batch.cur[o + 2];
        }
        const c = this.itemColors[item];
        batch.color[o] = c.r;
        batch.color[o + 1] = c.g;
        batch.color[o + 2] = c.b;
        batch.count++;
        total++;
      }
    }
    this.itemCount = total;
    for (const batch of this.itemBatches.values()) {
      if (!batch.mesh) continue;
      const geometry = batch.mesh.geometry as THREE.InstancedBufferGeometry;
      geometry.instanceCount = batch.count;
      for (const name of ['aPrev', 'aCur', 'aColor']) {
        (geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
      }
    }
  }

  /**
   * A point along a belt tile's path: 0 is where items enter, 1 where they leave.
   * A belt that turns carries items round a quarter circle.
   */
  private pathPoint(out: Float32Array, o: number, cx: number, cz: number, d: number, entry: number, at: number, y: number): void {
    if (entry >= 0) {
      const angle = at * (Math.PI / 2);
      const cos = Math.cos(angle) * 0.5;
      const sin = Math.sin(angle) * 0.5;
      // The circle's centre is the tile corner between the entry and exit sides.
      out[o] = cx + (DX[entry] + DX[d]) * 0.5 - DX[d] * cos - DX[entry] * sin;
      out[o + 2] = cz + (DY[entry] + DY[d]) * 0.5 - DY[d] * cos - DY[entry] * sin;
    } else {
      out[o] = cx + DX[d] * (at - 0.5);
      out[o + 2] = cz + DY[d] * (at - 0.5);
    }
    out[o + 1] = y;
  }

  private resizeItems(batch: ItemBatch, capacity: number): void {
    if (batch.mesh) {
      this.scene.remove(batch.mesh);
      batch.mesh.geometry.dispose();
    }
    batch.capacity = capacity;
    batch.prev = new Float32Array(capacity * 3);
    batch.cur = new Float32Array(capacity * 3);
    batch.color = new Float32Array(capacity * 3);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', batch.shape.getAttribute('position'));
    geometry.setAttribute('normal', batch.shape.getAttribute('normal'));
    geometry.setAttribute('aPrev', new THREE.InstancedBufferAttribute(batch.prev, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aCur', new THREE.InstancedBufferAttribute(batch.cur, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(batch.color, 3).setUsage(THREE.DynamicDrawUsage));
    batch.mesh = new THREE.Mesh(geometry, this.itemMaterial);
    batch.mesh.frustumCulled = false;
    this.scene.add(batch.mesh);
  }
}
