// The renderer only reads the simulation. It keeps one instanced mesh per kind
// of building and one for all belt items, and redraws them when the simulation's
// version counters say something changed.

import * as THREE from 'three';
import { BELT_SLOTS, BUILDINGS, ITEM_BY_ID, ITEM_COUNT, type BuildingDef } from '../content/content';
import {
  CHUNK, CHUNK_SHIFT, DX, DY, MOVED_ENTERED, MOVED_SLOT, ROLE_BELT, ROLE_MACHINE, ROLE_MINER, ROLE_SPLITTER,
  STATUS_BLOCKED, STATUS_IDLE, STATUS_STARVED, TERRAIN_WATER, type Chunk, type Sim,
} from '../sim';
import { CameraRig } from './camera';
import { buildItemGeometry, buildModel, buildRockGeometry, buildTreeGeometry } from './models';

const ITEM_Y = 0.2;
const SKY = 0x1b2a38;

interface Batch {
  def: BuildingDef;
  mesh: THREE.InstancedMesh;
  capacity: number;
  /** Building slot drawn by each instance. */
  slots: Int32Array;
  count: number;
}

export interface Ghost {
  building: number;
  x: number;
  y: number;
  dir: number;
  ok: boolean;
}

const ITEM_VERTEX = /* glsl */ `
  attribute vec3 aPrev;
  attribute vec3 aCur;
  attribute vec3 aColor;
  uniform float uAlpha;
  varying vec3 vColor;
  varying vec3 vNormal;
  void main() {
    vColor = aColor;
    vNormal = normal;
    vec3 offset = mix(aPrev, aCur, uAlpha);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + offset, 1.0);
  }
`;

const ITEM_FRAGMENT = /* glsl */ `
  uniform vec3 uLight;
  varying vec3 vColor;
  varying vec3 vNormal;
  void main() {
    float lit = 0.55 + 0.6 * max(dot(normalize(vNormal), uLight), 0.0);
    gl_FragColor = vec4(vColor * lit, 1.0);
    #include <colorspace_fragment>
  }
`;

export class GameRenderer {
  readonly rig = new CameraRig();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private sim: Sim;

  private readonly buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly models = new Map<number, THREE.BufferGeometry>();
  private readonly batches = new Map<number, Batch>();
  private readonly chunkMeshes = new Map<Chunk, THREE.Mesh>();
  private readonly terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private trees: THREE.InstancedMesh | null = null;
  private rocks: THREE.InstancedMesh | null = null;
  private readonly treeGeometry = buildTreeGeometry();
  private readonly rockGeometry = buildRockGeometry();

  private itemMesh: THREE.Mesh | null = null;
  private itemCapacity = 0;
  private itemPrev = new Float32Array(0);
  private itemCur = new Float32Array(0);
  private itemColor = new Float32Array(0);
  private readonly itemMaterial: THREE.ShaderMaterial;
  private readonly itemColors: THREE.Color[] = [];
  itemCount = 0;

  /** For each belt: the side its curve comes in from, or -1 when it runs straight. */
  private beltEntry = new Int8Array(0);

  private seenTopology = -1;
  private seenBeltStep = -1;
  private seenWorld = -1;
  private statusTimer = 0;

  private readonly ghostMeshes = new Map<number, THREE.Mesh>();
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x7dffa0, transparent: true, opacity: 0.55, depthWrite: false });
  private readonly cursor: THREE.LineLoop;
  private readonly selection: THREE.LineLoop;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private readonly matrix = new THREE.Matrix4();
  private readonly quaternions = [0, 1, 2, 3].map((d) =>
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (-d * Math.PI) / 2),
  );
  private readonly position = new THREE.Vector3();
  private readonly unit = new THREE.Vector3(1, 1, 1);
  private readonly tint = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, sim: Sim) {
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Pixels have a budget too: never draw at more than 1.5x the layout size.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 140, 420);

    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a5142, 1.5));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    for (let id = 0; id < ITEM_COUNT; id++) {
      this.itemColors[id] = new THREE.Color(ITEM_BY_ID[id]?.color ?? 0xffffff);
    }
    this.itemMaterial = new THREE.ShaderMaterial({
      vertexShader: ITEM_VERTEX,
      fragmentShader: ITEM_FRAGMENT,
      uniforms: { uAlpha: { value: 1 }, uLight: { value: new THREE.Vector3(0.35, 0.85, 0.4).normalize() } },
    });

    for (const def of BUILDINGS) {
      const geometry = buildModel(def.key);
      this.models.set(def.id, geometry);
      const ghost = new THREE.Mesh(geometry, this.ghostMaterial);
      ghost.visible = false;
      ghost.renderOrder = 2;
      this.ghostMeshes.set(def.id, ghost);
      this.scene.add(ghost);
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
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.seenTopology = -1;
    this.seenBeltStep = -1;
    this.seenWorld = -1;
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

  /**
   * Draws one frame. `alpha` is how far the simulation is into the next tick,
   * from 0 to 1, so belt items glide between ticks.
   */
  render(alpha: number, dt: number): void {
    const sim = this.sim;
    if (this.seenWorld !== sim.world.version) {
      this.seenWorld = sim.world.version;
      this.syncTerrain();
      this.seenTopology = -1;
    }
    if (this.seenTopology !== sim.topologyVersion) {
      this.seenTopology = sim.topologyVersion;
      this.syncBuildings();
      this.syncDecor();
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
    this.sun.position.set(this.rig.target.x + 60, 110, this.rig.target.z + 45);

    this.renderer.render(this.scene, this.rig.camera);
  }

  // ---- terrain ---------------------------------------------------------------

  private syncTerrain(): void {
    for (const chunk of this.sim.world.chunks) {
      if (this.chunkMeshes.has(chunk)) continue;
      const mesh = new THREE.Mesh(this.buildChunkGeometry(chunk), this.terrainMaterial);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.chunkMeshes.set(chunk, mesh);
      this.scene.add(mesh);
    }
  }

  private buildChunkGeometry(chunk: Chunk): THREE.BufferGeometry {
    const positions = new Float32Array(CHUNK * CHUNK * 18);
    const colors = new Float32Array(CHUNK * CHUNK * 18);
    const normals = new Float32Array(CHUNK * CHUNK * 18);
    const color = new THREE.Color();
    const deposit = new THREE.Color();
    const x0 = chunk.cx << CHUNK_SHIFT;
    const z0 = chunk.cy << CHUNK_SHIFT;
    let p = 0;
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const i = (ty << CHUNK_SHIFT) + tx;
        const shade = chunk.shade[i] / 15;
        let y = 0;
        if (chunk.terrain[i] === TERRAIN_WATER) {
          color.setHex(0x2f6f9f).multiplyScalar(0.85 + shade * 0.2);
          y = -0.18;
        } else {
          color.setHex(0x6c9a52).multiplyScalar(0.86 + shade * 0.22);
          if (chunk.deposit[i]) {
            deposit.setHex(ITEM_BY_ID[chunk.deposit[i]]?.color ?? 0xffffff);
            color.lerp(deposit, 0.55);
          }
        }
        const xa = x0 + tx;
        const za = z0 + ty;
        const quad = [xa, za, xa, za + 1, xa + 1, za, xa + 1, za, xa, za + 1, xa + 1, za + 1];
        for (let v = 0; v < 6; v++) {
          positions[p] = quad[v * 2];
          positions[p + 1] = y;
          positions[p + 2] = quad[v * 2 + 1];
          normals[p + 1] = 1;
          colors[p] = color.r;
          colors[p + 1] = color.g;
          colors[p + 2] = color.b;
          p += 3;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Trees and rocks on deposit tiles that have nothing built on them. */
  private syncDecor(): void {
    const world = this.sim.world;
    let treeCount = 0;
    let rockCount = 0;
    for (const chunk of world.chunks) {
      for (let i = 0; i < chunk.deposit.length; i++) {
        if (!chunk.deposit[i] || chunk.building[i]) continue;
        if (chunk.deposit[i] === 1) treeCount++;
        else rockCount++;
      }
    }
    this.trees = this.resizeDecor(this.trees, this.treeGeometry, treeCount);
    this.rocks = this.resizeDecor(this.rocks, this.rockGeometry, rockCount);
    let t = 0;
    let r = 0;
    for (const chunk of world.chunks) {
      for (let i = 0; i < chunk.deposit.length; i++) {
        const res = chunk.deposit[i];
        if (!res || chunk.building[i]) continue;
        const x = (chunk.cx << CHUNK_SHIFT) + (i & (CHUNK - 1));
        const z = (chunk.cy << CHUNK_SHIFT) + (i >> CHUNK_SHIFT);
        const jitter = chunk.shade[i];
        this.position.set(x + 0.35 + (jitter & 3) * 0.1, 0, z + 0.35 + ((jitter >> 2) & 3) * 0.1);
        const scale = 0.85 + (jitter & 7) * 0.05;
        this.matrix.compose(this.position, this.quaternions[jitter & 3], this.unit.set(scale, scale, scale));
        if (res === 1) {
          this.trees.setMatrixAt(t++, this.matrix);
        } else {
          this.rocks.setMatrixAt(r, this.matrix);
          this.rocks.setColorAt(r++, this.itemColors[res]);
        }
      }
    }
    this.unit.set(1, 1, 1);
    this.trees.count = treeCount;
    this.rocks.count = rockCount;
    this.trees.instanceMatrix.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
    if (this.rocks.instanceColor) this.rocks.instanceColor.needsUpdate = true;
  }

  private resizeDecor(mesh: THREE.InstancedMesh | null, geometry: THREE.BufferGeometry, needed: number): THREE.InstancedMesh {
    if (mesh && mesh.instanceMatrix.count >= needed) return mesh;
    if (mesh) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    const next = new THREE.InstancedMesh(geometry, this.buildingMaterial, Math.max(256, needed * 2));
    next.castShadow = true;
    next.frustumCulled = false;
    this.scene.add(next);
    return next;
  }

  // ---- buildings -------------------------------------------------------------

  private syncBuildings(): void {
    const sim = this.sim;
    const counts = new Int32Array(BUILDINGS.length + 1);
    for (let s = 0; s < sim.count; s++) counts[sim.kind[s]]++;

    for (const def of BUILDINGS) {
      let batch = this.batches.get(def.id);
      const needed = counts[def.id];
      if (!batch || batch.capacity < needed) {
        if (batch) {
          this.scene.remove(batch.mesh);
          batch.mesh.dispose();
        }
        const capacity = Math.max(64, needed * 2);
        const mesh = new THREE.InstancedMesh(this.models.get(def.id)!, this.buildingMaterial, capacity);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        batch = { def, mesh, capacity, slots: new Int32Array(capacity), count: 0 };
        this.batches.set(def.id, batch);
        this.scene.add(mesh);
      }
      batch.count = 0;
    }

    if (this.beltEntry.length < sim.capacity) this.beltEntry = new Int8Array(sim.capacity);

    for (let s = 0; s < sim.count; s++) {
      const kind = sim.kind[s];
      if (!kind) continue;
      const batch = this.batches.get(kind)!;
      const i = batch.count++;
      batch.slots[i] = s;
      this.position.set(sim.bx[s] + 0.5, 0, sim.by[s] + 0.5);
      this.matrix.compose(this.position, this.quaternions[sim.dir[s]], this.unit);
      batch.mesh.setMatrixAt(i, this.matrix);
      batch.mesh.setColorAt(i, this.tint.setRGB(1, 1, 1));
      if (sim.role(s) === ROLE_BELT) this.beltEntry[s] = this.findBeltEntry(s);
    }
    for (const batch of this.batches.values()) {
      batch.mesh.count = batch.count;
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
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

  /** Tints machines by state: amber when starved, red when blocked, grey when idle. */
  private syncStatus(): void {
    const sim = this.sim;
    for (const batch of this.batches.values()) {
      if (batch.def.role !== 'machine' && batch.def.role !== 'miner') continue;
      for (let i = 0; i < batch.count; i++) {
        const status = sim.status[batch.slots[i]];
        if (status === STATUS_BLOCKED) this.tint.setRGB(1.25, 0.5, 0.45);
        else if (status === STATUS_STARVED) this.tint.setRGB(1.2, 0.95, 0.45);
        else if (status === STATUS_IDLE) this.tint.setRGB(0.6, 0.6, 0.65);
        else this.tint.setRGB(1, 1, 1);
        batch.mesh.setColorAt(i, this.tint);
      }
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- belt items ------------------------------------------------------------

  /**
   * Uploads where every belt item was and is. The shader slides each one between
   * the two, so this runs once per belt beat and not once per frame.
   */
  private syncItems(): void {
    const sim = this.sim;
    const needed = sim.countBeltItems();
    if (needed > this.itemCapacity) this.resizeItems(Math.max(1024, needed * 2));
    const prev = this.itemPrev;
    const cur = this.itemCur;
    const colors = this.itemColor;
    let n = 0;
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
        const o = n * 3;
        const at = role === ROLE_BELT ? (k + 0.5) / BELT_SLOTS : 0.5;
        this.pathPoint(cur, o, cx, cz, d, entry, at);
        const moved = sim.moved[base + k];
        if (moved === MOVED_SLOT) {
          this.pathPoint(prev, o, cx, cz, d, entry, (k - 0.5) / BELT_SLOTS);
        } else if (moved >= MOVED_ENTERED) {
          const side = moved - MOVED_ENTERED;
          prev[o] = cx + DX[side] * 0.625;
          prev[o + 1] = ITEM_Y;
          prev[o + 2] = cz + DY[side] * 0.625;
        } else {
          prev[o] = cur[o];
          prev[o + 1] = cur[o + 1];
          prev[o + 2] = cur[o + 2];
        }
        const c = this.itemColors[item];
        colors[o] = c.r;
        colors[o + 1] = c.g;
        colors[o + 2] = c.b;
        n++;
      }
    }
    this.itemCount = n;
    if (!this.itemMesh) return;
    const geometry = this.itemMesh.geometry as THREE.InstancedBufferGeometry;
    geometry.instanceCount = n;
    for (const name of ['aPrev', 'aCur', 'aColor']) {
      (geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /** A point along a belt tile's path: 0 is where items enter, 1 where they leave. */
  private pathPoint(out: Float32Array, o: number, cx: number, cz: number, d: number, entry: number, at: number): void {
    if (entry >= 0 && at < 0.5) {
      const f = 0.5 - at;
      out[o] = cx + DX[entry] * f;
      out[o + 2] = cz + DY[entry] * f;
    } else {
      out[o] = cx + DX[d] * (at - 0.5);
      out[o + 2] = cz + DY[d] * (at - 0.5);
    }
    out[o + 1] = ITEM_Y;
  }

  private resizeItems(capacity: number): void {
    if (this.itemMesh) {
      this.scene.remove(this.itemMesh);
      this.itemMesh.geometry.dispose();
    }
    this.itemCapacity = capacity;
    this.itemPrev = new Float32Array(capacity * 3);
    this.itemCur = new Float32Array(capacity * 3);
    this.itemColor = new Float32Array(capacity * 3);
    const base = buildItemGeometry();
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('normal', base.getAttribute('normal'));
    geometry.setAttribute('aPrev', new THREE.InstancedBufferAttribute(this.itemPrev, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aCur', new THREE.InstancedBufferAttribute(this.itemCur, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.itemColor, 3).setUsage(THREE.DynamicDrawUsage));
    this.itemMesh = new THREE.Mesh(geometry, this.itemMaterial);
    this.itemMesh.frustumCulled = false;
    this.scene.add(this.itemMesh);
  }
}
