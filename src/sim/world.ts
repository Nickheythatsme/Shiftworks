// The map. Tiles live in chunks of 32 by 32 that each own their arrays; a chunk
// is created when the town's growth opens it. A tile's height is a function of
// the seed and its position, so it is never saved. Whether a tile is land or
// water is its height compared with the water level, which the tide moves.

import { DEPOSIT_MIN_HEIGHT, TIDE_LOW } from '../content/content';
import { hash3 } from './hash';

export const CHUNK_SHIFT = 5;
export const CHUNK = 1 << CHUNK_SHIFT;
export const CHUNK_TILES = CHUNK * CHUNK;
export const MAX_CHUNKS = 64;
export const WORLD_TILES = MAX_CHUNKS * CHUNK;
/** The town hub's centre tile, in the middle of the largest possible map. */
export const HUB_X = WORLD_TILES / 2;
export const HUB_Y = WORLD_TILES / 2;
/** The map starts as 8 by 8 chunks: 4 chunks out from the centre each way. */
export const START_RADIUS = 4;
export const MAX_RADIUS = MAX_CHUNKS / 2;

export const TERRAIN_LAND = 0;
export const TERRAIN_WATER = 1;

/** 'test' is all dry land. 'slope' is a test map whose ground east of the hub rises out of the tide a step every two tiles. */
export type WorldType = 'normal' | 'test' | 'slope';

/** Height of ground that the water can never reach. */
export const HIGH_GROUND = 255;

export interface Chunk {
  cx: number;
  cy: number;
  /** How high each tile stands, 0 to 255. Fixed for the life of the map. */
  height: Uint8Array;
  /** Item id of the raw resource on the tile, or 0. */
  deposit: Uint8Array;
  /** Small per-tile variation used only for drawing. */
  shade: Uint8Array;
  /** Building slot + 1 occupying the tile, or 0. Rebuilt from buildings on load. */
  building: Int32Array;
}

// Deposits the first goals depend on, as offsets from the hub centre.
const STARTER_PATCHES = [
  { dx: -10, dy: -5, r: 3, res: 1 },
  { dx: 9, dy: -7, r: 3, res: 2 },
  { dx: -6, dy: 10, r: 3, res: 3 },
  { dx: 17, dy: 11, r: 3, res: 4 },
  { dx: -19, dy: -13, r: 3, res: 5 },
  { dx: 12, dy: 4, r: 2, res: 1 },
];

const BLOB_CELL = 16;
const BLOB_RESOURCES = [1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5];

function lattice(seed: number, x: number, y: number, size: number): number {
  const gx = Math.floor(x / size);
  const gy = Math.floor(y / size);
  const fx = x - gx * size;
  const fy = y - gy * size;
  const a = hash3(seed, gx, gy) & 255;
  const b = hash3(seed, gx + 1, gy) & 255;
  const c = hash3(seed, gx, gy + 1) & 255;
  const d = hash3(seed, gx + 1, gy + 1) & 255;
  const top = a * (size - fx) + b * fx;
  const bottom = c * (size - fx) + d * fx;
  return Math.floor((top * (size - fy) + bottom * fy) / (size * size));
}

export class World {
  readonly seed: number;
  readonly type: WorldType;
  readonly chunks: Chunk[] = [];
  /** Chunk number for each chunk position, or -1 where no chunk exists yet. */
  private readonly chunkIndex = new Int16Array(MAX_CHUNKS * MAX_CHUNKS).fill(-1);
  /** How many chunks out from the centre the map currently reaches. */
  radius = 0;
  /** Goes up whenever chunks are added, so the renderer knows to draw them. */
  version = 0;
  /** The water level. Tiles lower than this are under water. The simulation sets it from the tick. */
  level = TIDE_LOW;

  constructor(seed: number, type: WorldType = 'normal', radius = START_RADIUS) {
    this.seed = seed | 0;
    this.type = type;
    this.growTo(radius);
  }

  /** Opens every chunk within `radius` chunks of the centre. */
  growTo(radius: number): void {
    const target = Math.min(radius, MAX_RADIUS);
    const mid = MAX_CHUNKS / 2;
    for (let r = this.radius + 1; r <= target; r++) {
      for (let cy = mid - r; cy < mid + r; cy++) {
        for (let cx = mid - r; cx < mid + r; cx++) {
          if (this.chunkIndex[cy * MAX_CHUNKS + cx] < 0) this.addChunk(cx, cy);
        }
      }
    }
    if (target > this.radius) {
      this.radius = target;
      this.version++;
    }
  }

  private addChunk(cx: number, cy: number): void {
    const chunk: Chunk = {
      cx,
      cy,
      height: new Uint8Array(CHUNK_TILES),
      deposit: new Uint8Array(CHUNK_TILES),
      shade: new Uint8Array(CHUNK_TILES),
      building: new Int32Array(CHUNK_TILES),
    };
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const x = (cx << CHUNK_SHIFT) + tx;
        const y = (cy << CHUNK_SHIFT) + ty;
        const i = (ty << CHUNK_SHIFT) + tx;
        const height = this.naturalHeight(x, y);
        chunk.height[i] = height;
        chunk.deposit[i] = height >= DEPOSIT_MIN_HEIGHT ? this.naturalDeposit(x, y) : 0;
        chunk.shade[i] = hash3(this.seed ^ 0x51ed, x, y) & 15;
      }
    }
    this.chunkIndex[cy * MAX_CHUNKS + cx] = this.chunks.length;
    this.chunks.push(chunk);
  }

  private naturalHeight(x: number, y: number): number {
    if (this.type === 'test') return HIGH_GROUND;
    if (this.type === 'slope') {
      const east = x - HUB_X - 16;
      return east < 0 ? HIGH_GROUND : Math.min(HIGH_GROUND, TIDE_LOW + (east >> 1));
    }
    const dx = x - HUB_X;
    const dy = y - HUB_Y;
    // The ground round the hub is always dry, whatever the tide does.
    if (dx * dx + dy * dy < 26 * 26) return HIGH_GROUND;
    return (lattice(this.seed, x, y, 24) * 3 + lattice(this.seed ^ 0x77, x, y, 7)) >> 2;
  }

  private naturalDeposit(x: number, y: number): number {
    if (this.type !== 'normal') {
      return y % 8 === 0 ? ((x >> 4) % 5) + 1 : 0;
    }
    const hx = x - HUB_X;
    const hy = y - HUB_Y;
    if (hx * hx + hy * hy < 5 * 5) return 0;
    const ragged = (hash3(this.seed ^ 0x1234, x, y) & 3) - 1;
    for (const p of STARTER_PATCHES) {
      const dx = hx - p.dx;
      const dy = hy - p.dy;
      if (dx * dx + dy * dy <= p.r * p.r + ragged) return p.res;
    }
    const gx = Math.floor(x / BLOB_CELL);
    const gy = Math.floor(y / BLOB_CELL);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const h = hash3(this.seed ^ 0xb10b, gx + ox, gy + oy);
        if ((h & 7) >= 3) continue;
        const bx = (gx + ox) * BLOB_CELL + ((h >>> 3) & 15);
        const by = (gy + oy) * BLOB_CELL + ((h >>> 7) & 15);
        const r = 2 + ((h >>> 11) % 3);
        const dx = x - bx;
        const dy = y - by;
        if (dx * dx + dy * dy <= r * r + ragged) return BLOB_RESOURCES[(h >>> 13) % BLOB_RESOURCES.length];
      }
    }
    return 0;
  }

  /** The chunk holding a tile, or undefined outside the map. */
  chunkAt(x: number, y: number): Chunk | undefined {
    if (x < 0 || y < 0 || x >= WORLD_TILES || y >= WORLD_TILES) return undefined;
    const n = this.chunkIndex[(y >> CHUNK_SHIFT) * MAX_CHUNKS + (x >> CHUNK_SHIFT)];
    return n < 0 ? undefined : this.chunks[n];
  }

  hasTile(x: number, y: number): boolean {
    return this.chunkAt(x, y) !== undefined;
  }

  /** A tile's height, or 0 outside the map. */
  heightAt(x: number, y: number): number {
    const c = this.chunkAt(x, y);
    return c ? c.height[((y & (CHUNK - 1)) << CHUNK_SHIFT) + (x & (CHUNK - 1))] : 0;
  }

  /** Land or water right now, at the current water level. Outside the map is water. */
  terrainAt(x: number, y: number): number {
    return this.heightAt(x, y) < this.level ? TERRAIN_WATER : TERRAIN_LAND;
  }

  depositAt(x: number, y: number): number {
    const c = this.chunkAt(x, y);
    return c ? c.deposit[((y & (CHUNK - 1)) << CHUNK_SHIFT) + (x & (CHUNK - 1))] : 0;
  }

  /** Building slot on the tile, or -1. */
  buildingAt(x: number, y: number): number {
    const c = this.chunkAt(x, y);
    return c ? c.building[((y & (CHUNK - 1)) << CHUNK_SHIFT) + (x & (CHUNK - 1))] - 1 : -1;
  }

  setBuilding(x: number, y: number, slot: number): void {
    const c = this.chunkAt(x, y);
    if (c) c.building[((y & (CHUNK - 1)) << CHUNK_SHIFT) + (x & (CHUNK - 1))] = slot + 1;
  }

  /** First and last tile coordinate of the current map, the same on both axes. */
  get minTile(): number {
    return (MAX_CHUNKS / 2 - this.radius) << CHUNK_SHIFT;
  }
  get maxTile(): number {
    return ((MAX_CHUNKS / 2 + this.radius) << CHUNK_SHIFT) - 1;
  }
}
