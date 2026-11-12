// The simulation. It imports nothing from rendering, interface or audio, uses
// integer math only, and changes state only through commands and ticks, so the
// same seed and the same commands always give the same factory.
//
// This is the plain version the design calls for first: every machine updates
// every tick and belts are stored as item slots per tile.

import {
  BELT_SLOTS,
  BELT_SLOT_SECONDS,
  BUILDINGS,
  BUILDING_BY_ID,
  GOALS,
  ITEM_BY_ID,
  ITEM_COUNT,
  MINER_SECONDS,
  RATE_WINDOW_SECONDS,
  RECIPES,
  STARTING_STOCK,
  STARTING_UNLOCKS,
  TICKS_PER_SECOND,
  buildingId,
  itemId,
  recipeId,
} from '../content/content';
import { FNV_OFFSET, fnv1a } from './hash';
import { HUB_X, HUB_Y, START_RADIUS, TERRAIN_LAND, World, type WorldType } from './world';

export const DX = [1, 0, -1, 0];
export const DY = [0, 1, 0, -1];

export const STATUS_IDLE = 0;
export const STATUS_WORKING = 1;
export const STATUS_STARVED = 2;
export const STATUS_BLOCKED = 3;

/** Belt `moved` codes: 0 still, 1 advanced one slot, 2 + side it entered from. */
export const MOVED_NONE = 0;
export const MOVED_SLOT = 1;
export const MOVED_ENTERED = 2;

const ROLE_NONE = 0;
const ROLE_BELT = 1;
const ROLE_SPLITTER = 2;
const ROLE_MINER = 3;
const ROLE_MACHINE = 4;
const ROLE_HUB = 5;
const ROLE_CODE = { belt: ROLE_BELT, splitter: ROLE_SPLITTER, miner: ROLE_MINER, machine: ROLE_MACHINE, hub: ROLE_HUB };

const INPUT_CAP = 4;
const OUTPUT_CAP = 4;
const MINER_OUTPUT_CAP = 2;

export type Command =
  | { type: 'place'; building: number; x: number; y: number; dir: number }
  | { type: 'remove'; x: number; y: number }
  | { type: 'rotate'; x: number; y: number }
  | { type: 'setRecipe'; x: number; y: number; recipe: number };

export type SimEvent =
  | { type: 'goal'; index: number }
  | { type: 'won' };

export interface SimOptions {
  seed: number;
  worldType?: WorldType;
  /** Start with every building, recipe and resource unlocked. For tests and benchmarks. */
  unlockAll?: boolean;
  /** Buildings cost nothing. For tests and benchmarks. */
  freeBuild?: boolean;
  /** Internal: build an empty shell for a save to be loaded into. */
  blank?: boolean;
}

interface RecipeRuntime {
  building: number;
  inA: number;
  needA: number;
  inB: number;
  needB: number;
  out: number;
  outCount: number;
  ticks: number;
}

function toTicks(seconds: number): number {
  return Math.max(1, Math.round(seconds * TICKS_PER_SECOND));
}

export class Sim {
  readonly world: World;
  readonly options: SimOptions;
  tick = 0;

  // ---- buildings: one typed array per property, indexed by slot number ----
  capacity = 1024;
  /** One past the highest slot ever used. */
  count = 0;
  kind = new Uint8Array(this.capacity);
  bx = new Int16Array(this.capacity);
  by = new Int16Array(this.capacity);
  dir = new Uint8Array(this.capacity);
  /** Goes up each time a slot is reused, so stale references can be caught. */
  gen = new Uint16Array(this.capacity);
  recipe = new Uint8Array(this.capacity);
  /** Miners: the item id being extracted. Splitters: next output to try. */
  aux = new Uint8Array(this.capacity);
  /** Work done on the current item, in ticks of full-speed work. */
  progress = new Int32Array(this.capacity);
  working = new Uint8Array(this.capacity);
  status = new Uint8Array(this.capacity);
  inA = new Uint8Array(this.capacity);
  inB = new Uint8Array(this.capacity);
  out = new Uint8Array(this.capacity);
  /** Belt item slots, four per building. Slot 0 is the entry end. */
  slots = new Uint8Array(this.capacity * BELT_SLOTS);
  /** How each slot's item moved in the last belt step. Drawing only. */
  moved = new Uint8Array(this.capacity * BELT_SLOTS);
  freeList = new Int32Array(this.capacity);
  freeCount = 0;

  // ---- town ----
  stock = new Uint32Array(ITEM_COUNT);
  delivered = new Uint32Array(ITEM_COUNT);
  /** Deliveries counted toward the current list, per item. Reset when a list completes. */
  goalProgress = new Uint32Array(ITEM_COUNT);
  goalIndex = 0;
  unlockedBuildings = new Uint8Array(BUILDINGS.length + 1);
  unlockedRecipes = new Uint8Array(RECIPES.length + 1);
  unlockedResources = new Uint8Array(ITEM_COUNT);
  totalMined = 0;
  /** Deliveries per item in each of the last 60 seconds. `rateCursor` is the second being filled. */
  rateBuckets = new Uint16Array(ITEM_COUNT * RATE_WINDOW_SECONDS);
  rateCursor = 0;
  /** Deliveries per item over the last 60 full seconds: the rate per minute. Updated once a second. */
  rate = new Uint32Array(ITEM_COUNT);
  /** Seconds for which every rate of the current gate has been met. */
  gateHeld = 0;

  // ---- derived, never saved ----
  private order = new Int32Array(this.capacity);
  private orderCount = 0;
  private orderState = new Uint8Array(this.capacity);
  private topologyDirty = true;
  /** Goes up whenever buildings change, so the renderer knows to redraw them. */
  topologyVersion = 0;
  /** Goes up on every belt step, so the renderer knows items moved. */
  beltStepVersion = 0;
  lastBeltStepTick = 0;
  /** Work counters for benchmarks: they measure cost without a clock. */
  work = { machineUpdates: 0, transportUpdates: 0 };

  readonly beltPeriod = toTicks(BELT_SLOT_SECONDS);
  readonly minerTicks = toTicks(MINER_SECONDS);
  private readonly recipes: (RecipeRuntime | undefined)[] = [];
  private readonly roleOf = new Uint8Array(BUILDINGS.length + 1);
  /** Build cost per building id, as [item id, count] pairs. */
  private readonly costs: [number, number][][] = [];
  /** How many of each item the current delivery list asks for. */
  private goalNeed = new Uint32Array(ITEM_COUNT);

  private queue: Command[] = [];
  /** Every command applied, with the tick it ran on. Enough to replay a game. */
  readonly log: { tick: number; command: Command }[] = [];
  /** Things the interface may want to announce. Drained by the caller. */
  events: SimEvent[] = [];

  constructor(options: SimOptions) {
    this.options = options;
    this.world = new World(options.seed, options.worldType ?? 'normal', START_RADIUS);
    for (const b of BUILDINGS) {
      this.roleOf[b.id] = ROLE_CODE[b.role];
      this.costs[b.id] = options.freeBuild ? [] : b.cost.map((c) => [itemId(c.item), c.count]);
    }
    for (const r of RECIPES) {
      const a = r.inputs[0];
      const b = r.inputs[1];
      this.recipes[r.id] = {
        building: buildingId(r.building),
        inA: itemId(a.item),
        needA: a.count,
        inB: b ? itemId(b.item) : 0,
        needB: b ? b.count : 0,
        out: itemId(r.output.item),
        outCount: r.output.count,
        ticks: toTicks(r.seconds),
      };
    }
    if (options.blank) return;
    this.loadGoalNeed();
    for (const s of STARTING_STOCK) this.stock[itemId(s.item)] = s.count;

    if (options.unlockAll) {
      this.unlockedBuildings.fill(1);
      this.unlockedRecipes.fill(1);
      this.unlockedResources.fill(1);
    } else {
      for (const key of STARTING_UNLOCKS.buildings) this.unlockedBuildings[buildingId(key)] = 1;
      for (const key of STARTING_UNLOCKS.recipes) this.unlockedRecipes[recipeId(key)] = 1;
      for (const key of STARTING_UNLOCKS.resources) this.unlockedResources[itemId(key)] = 1;
    }
    const hub = this.allocate();
    this.kind[hub] = buildingId('hub');
    this.bx[hub] = HUB_X;
    this.by[hub] = HUB_Y;
    this.occupy(hub, hub);
  }

  // ---- reading ---------------------------------------------------------------

  role(slot: number): number {
    return this.roleOf[this.kind[slot]];
  }

  isBelt(slot: number): boolean {
    return this.roleOf[this.kind[slot]] === ROLE_BELT;
  }

  /** Recipe ids the player may currently choose for a building type. */
  recipesFor(building: number): number[] {
    const list: number[] = [];
    for (const r of RECIPES) {
      if (buildingId(r.building) === building && this.unlockedRecipes[r.id]) list.push(r.id);
    }
    return list;
  }

  /** The item a building pushes out of its front, or 0. */
  outputItem(slot: number): number {
    const role = this.role(slot);
    if (role === ROLE_MINER) return this.aux[slot];
    if (role === ROLE_MACHINE) return this.recipes[this.recipe[slot]]?.out ?? 0;
    return 0;
  }

  /** Why a building cannot go here, or null if it can. Reads only. */
  placeError(building: number, x: number, y: number): string | null {
    const def = BUILDING_BY_ID[building];
    if (!def || def.fixed) return 'That cannot be built.';
    if (!this.unlockedBuildings[building]) return `${def.name} is not unlocked yet.`;
    const half = def.size >> 1;
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const tx = x + ox;
        const ty = y + oy;
        if (!this.world.hasTile(tx, ty)) return 'Outside the map.';
        if (this.world.terrainAt(tx, ty) !== TERRAIN_LAND) return 'Cannot build on water.';
        const there = this.world.buildingAt(tx, ty);
        if (there >= 0) {
          // A belt may be laid over a belt: it just turns the one that is there.
          if (def.role === 'belt' && this.isBelt(there)) continue;
          return 'Something is already there.';
        }
      }
    }
    if (def.role === 'miner') {
      const deposit = this.world.depositAt(x, y);
      if (!deposit) return 'A miner needs a deposit under it.';
      if (!this.unlockedResources[deposit]) return 'The town cannot use this resource yet.';
    }
    // Turning a belt that is already there is free.
    if (this.world.buildingAt(x, y) >= 0) return null;
    for (const [item, count] of this.costs[building]) {
      if (this.stock[item] < count) {
        return `Not enough ${ITEM_BY_ID[item]?.name.toLowerCase() ?? 'materials'} in the hub: ${def.name} needs ${count}.`;
      }
    }
    return null;
  }

  /** Whether the hub holds the materials for one of this building. */
  canAfford(building: number): boolean {
    for (const [item, count] of this.costs[building] ?? []) {
      if (this.stock[item] < count) return false;
    }
    return true;
  }

  /** A number that is equal for two simulations exactly when their states match. */
  hash(): number {
    let h = FNV_OFFSET;
    h = fnv1a(h, new Int32Array([this.tick, this.count, this.freeCount, this.goalIndex, this.world.radius, this.totalMined, this.rateCursor, this.gateHeld]));
    for (const a of this.buildingArrays()) {
      if (a.name === 'moved' || a.name === 'gen') continue;
      h = fnv1a(h, a.array, this.count * a.per * a.array.BYTES_PER_ELEMENT);
    }
    h = fnv1a(h, this.freeList, this.freeCount * 4);
    h = fnv1a(h, this.stock);
    h = fnv1a(h, this.delivered);
    h = fnv1a(h, this.goalProgress);
    h = fnv1a(h, this.rateBuckets);
    h = fnv1a(h, this.rate);
    h = fnv1a(h, this.unlockedBuildings);
    h = fnv1a(h, this.unlockedRecipes);
    h = fnv1a(h, this.unlockedResources);
    return h;
  }

  /** Items currently riding on belts and splitters. */
  countBeltItems(): number {
    let n = 0;
    const end = this.count * BELT_SLOTS;
    for (let i = 0; i < end; i++) if (this.slots[i]) n++;
    return n;
  }

  buildingArrays(): { name: string; array: Uint8Array | Int16Array | Uint16Array | Int32Array; per: number }[] {
    return [
      { name: 'kind', array: this.kind, per: 1 },
      { name: 'bx', array: this.bx, per: 1 },
      { name: 'by', array: this.by, per: 1 },
      { name: 'dir', array: this.dir, per: 1 },
      { name: 'gen', array: this.gen, per: 1 },
      { name: 'recipe', array: this.recipe, per: 1 },
      { name: 'aux', array: this.aux, per: 1 },
      { name: 'progress', array: this.progress, per: 1 },
      { name: 'working', array: this.working, per: 1 },
      { name: 'status', array: this.status, per: 1 },
      { name: 'inA', array: this.inA, per: 1 },
      { name: 'inB', array: this.inB, per: 1 },
      { name: 'out', array: this.out, per: 1 },
      { name: 'slots', array: this.slots, per: BELT_SLOTS },
      { name: 'moved', array: this.moved, per: BELT_SLOTS },
    ];
  }

  // ---- commands ----------------------------------------------------------------

  /** Queues a command. It is applied at the start of the next tick. */
  enqueue(command: Command): void {
    this.queue.push(command);
  }

  /**
   * Applies queued commands now, stamped with the current tick. `step` does this
   * first thing, so calling it early (to build while paused) changes nothing
   * about the result.
   */
  applyQueued(): void {
    if (this.queue.length === 0) return;
    const queue = this.queue;
    this.queue = [];
    for (const command of queue) {
      if (this.apply(command)) this.log.push({ tick: this.tick, command });
    }
  }

  private apply(command: Command): boolean {
    switch (command.type) {
      case 'place':
        return this.place(command.building, command.x, command.y, command.dir & 3);
      case 'remove':
        return this.remove(command.x, command.y);
      case 'rotate': {
        const slot = this.world.buildingAt(command.x, command.y);
        if (slot < 0 || BUILDING_BY_ID[this.kind[slot]]?.fixed) return false;
        this.dir[slot] = (this.dir[slot] + 1) & 3;
        this.changed();
        return true;
      }
      case 'setRecipe': {
        const slot = this.world.buildingAt(command.x, command.y);
        if (slot < 0 || this.role(slot) !== ROLE_MACHINE) return false;
        const r = command.recipe;
        if (r !== 0) {
          const def = this.recipes[r];
          if (!def || def.building !== this.kind[slot] || !this.unlockedRecipes[r]) return false;
        }
        if (this.recipe[slot] === r) return true;
        this.recipe[slot] = r;
        this.progress[slot] = 0;
        this.working[slot] = 0;
        this.inA[slot] = 0;
        this.inB[slot] = 0;
        this.out[slot] = 0;
        this.changed();
        return true;
      }
    }
  }

  private place(building: number, x: number, y: number, dir: number): boolean {
    if (this.placeError(building, x, y) !== null) return false;
    const def = BUILDING_BY_ID[building]!;
    const there = this.world.buildingAt(x, y);
    if (there >= 0) {
      // placeError only lets a belt through here.
      if (this.dir[there] === dir) return false;
      this.dir[there] = dir;
      this.changed();
      return true;
    }
    for (const [item, count] of this.costs[building]) this.stock[item] -= count;
    const slot = this.allocate();
    this.kind[slot] = building;
    this.bx[slot] = x;
    this.by[slot] = y;
    this.dir[slot] = dir;
    if (def.role === 'miner') this.aux[slot] = this.world.depositAt(x, y);
    if (def.role === 'machine') this.recipe[slot] = this.recipesFor(building)[0] ?? 0;
    this.occupy(slot, slot);
    this.changed();
    return true;
  }

  private remove(x: number, y: number): boolean {
    const slot = this.world.buildingAt(x, y);
    if (slot < 0 || BUILDING_BY_ID[this.kind[slot]]?.fixed) return false;
    // Materials go back to the hub in full. What the building was holding is lost.
    for (const [item, count] of this.costs[this.kind[slot]]) this.stock[item] += count;
    this.occupy(slot, -1);
    this.clearSlot(slot);
    this.freeList[this.freeCount++] = slot;
    this.changed();
    return true;
  }

  private changed(): void {
    this.topologyDirty = true;
    this.topologyVersion++;
  }

  /** Writes `value` into the map for every tile the building in `slot` covers. */
  private occupy(slot: number, value: number): void {
    const half = (BUILDING_BY_ID[this.kind[slot]]?.size ?? 1) >> 1;
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        this.world.setBuilding(this.bx[slot] + ox, this.by[slot] + oy, value);
      }
    }
  }

  private clearSlot(slot: number): void {
    this.kind[slot] = 0;
    this.dir[slot] = 0;
    this.recipe[slot] = 0;
    this.aux[slot] = 0;
    this.progress[slot] = 0;
    this.working[slot] = 0;
    this.status[slot] = 0;
    this.inA[slot] = 0;
    this.inB[slot] = 0;
    this.out[slot] = 0;
    const base = slot * BELT_SLOTS;
    for (let i = 0; i < BELT_SLOTS; i++) {
      this.slots[base + i] = 0;
      this.moved[base + i] = 0;
    }
  }

  /** Takes the most recently freed slot, or a new one. Deterministic. */
  private allocate(): number {
    let slot: number;
    if (this.freeCount > 0) {
      slot = this.freeList[--this.freeCount];
    } else {
      if (this.count === this.capacity) this.grow(this.capacity * 2);
      slot = this.count++;
    }
    this.gen[slot]++;
    return slot;
  }

  private grow(capacity: number): void {
    const widen = <T extends Uint8Array | Int16Array | Uint16Array | Int32Array>(old: T, per = 1): T => {
      const next = new (old.constructor as new (n: number) => T)(capacity * per);
      next.set(old);
      return next;
    };
    this.kind = widen(this.kind);
    this.bx = widen(this.bx);
    this.by = widen(this.by);
    this.dir = widen(this.dir);
    this.gen = widen(this.gen);
    this.recipe = widen(this.recipe);
    this.aux = widen(this.aux);
    this.progress = widen(this.progress);
    this.working = widen(this.working);
    this.status = widen(this.status);
    this.inA = widen(this.inA);
    this.inB = widen(this.inB);
    this.out = widen(this.out);
    this.slots = widen(this.slots, BELT_SLOTS);
    this.moved = widen(this.moved, BELT_SLOTS);
    this.freeList = widen(this.freeList);
    this.order = new Int32Array(capacity);
    this.orderState = new Uint8Array(capacity);
    this.capacity = capacity;
    this.topologyDirty = true;
  }

  /** Makes room for a save with `count` buildings. Used when loading. */
  reserve(count: number): void {
    let capacity = this.capacity;
    while (capacity < count) capacity *= 2;
    if (capacity !== this.capacity) this.grow(capacity);
  }

  /** Rebuilds everything that is derived from the saved arrays. Used when loading. */
  rebuildDerived(): void {
    for (let s = 0; s < this.count; s++) {
      if (this.kind[s]) this.occupy(s, s);
    }
    this.lastBeltStepTick = this.tick;
    this.loadGoalNeed();
    this.changed();
  }

  // ---- the tick ------------------------------------------------------------------

  /** Advances the simulation by one tick. The steps always run in this order. */
  step(): void {
    // 1. Commands stamped for this tick, in the order they were issued.
    this.applyQueued();

    // 2. Machines and miners do their work, in slot order.
    const count = this.count;
    for (let s = 0; s < count; s++) {
      const role = this.roleOf[this.kind[s]];
      if (role === ROLE_MINER) this.updateMiner(s);
      else if (role === ROLE_MACHINE) this.updateMachine(s);
    }

    // 3. Belts advance from the downstream end backwards, then machines put
    //    finished items out. Both happen on the belt beat so items move together.
    if (this.tick % this.beltPeriod === 0) {
      this.transportStep();
      for (let s = 0; s < count; s++) {
        if (this.out[s] === 0) continue;
        const item = this.outputItem(s);
        const d = this.dir[s];
        if (item && this.tryInsert(this.bx[s] + DX[d], this.by[s] + DY[d], item, this.bx[s], this.by[s])) {
          this.out[s]--;
        }
      }
      this.beltStepVersion++;
      this.lastBeltStepTick = this.tick + 1;
    }

    // 4. Once a second: the town.
    if (this.tick % TICKS_PER_SECOND === 0) this.updateTown();

    this.tick++;
  }

  private updateMiner(s: number): void {
    this.work.machineUpdates++;
    if (this.out[s] >= MINER_OUTPUT_CAP) {
      this.status[s] = STATUS_BLOCKED;
      return;
    }
    this.status[s] = STATUS_WORKING;
    if (++this.progress[s] >= this.minerTicks) {
      this.progress[s] = 0;
      this.out[s]++;
      this.totalMined++;
    }
  }

  private updateMachine(s: number): void {
    this.work.machineUpdates++;
    const r = this.recipes[this.recipe[s]];
    if (!r) {
      this.status[s] = STATUS_IDLE;
      return;
    }
    if (this.working[s]) {
      this.status[s] = STATUS_WORKING;
      if (++this.progress[s] < r.ticks) return;
      this.progress[s] = 0;
      this.working[s] = 0;
      this.out[s] += r.outCount;
    }
    if (this.out[s] + r.outCount > OUTPUT_CAP) {
      this.status[s] = STATUS_BLOCKED;
    } else if (this.inA[s] >= r.needA && this.inB[s] >= r.needB) {
      this.inA[s] -= r.needA;
      this.inB[s] -= r.needB;
      this.working[s] = 1;
      this.status[s] = STATUS_WORKING;
    } else {
      this.status[s] = STATUS_STARVED;
    }
  }

  /** Offers an item to whatever is on a tile. Returns whether it was taken. */
  private tryInsert(x: number, y: number, item: number, fromX: number, fromY: number): boolean {
    const t = this.world.buildingAt(x, y);
    if (t < 0) return false;
    switch (this.roleOf[this.kind[t]]) {
      case ROLE_BELT: {
        const d = this.dir[t];
        // Two belts facing each other pass nothing.
        if (this.bx[t] + DX[d] === fromX && this.by[t] + DY[d] === fromY) return false;
        const base = t * BELT_SLOTS;
        if (this.slots[base] !== 0) return false;
        this.slots[base] = item;
        this.moved[base] = MOVED_ENTERED + sideToward(x, y, fromX, fromY);
        return true;
      }
      case ROLE_SPLITTER: {
        const d = this.dir[t];
        // A splitter only takes items from behind.
        if (this.bx[t] - DX[d] !== fromX || this.by[t] - DY[d] !== fromY) return false;
        const base = t * BELT_SLOTS;
        if (this.slots[base] !== 0) return false;
        this.slots[base] = item;
        this.moved[base] = MOVED_ENTERED + ((d + 2) & 3);
        return true;
      }
      case ROLE_MACHINE: {
        const r = this.recipes[this.recipe[t]];
        if (!r) return false;
        if (item === r.inA && this.inA[t] < INPUT_CAP) {
          this.inA[t]++;
          return true;
        }
        if (item === r.inB && this.inB[t] < INPUT_CAP) {
          this.inB[t]++;
          return true;
        }
        return false;
      }
      case ROLE_HUB:
        // Everything delivered becomes building material, and also counts
        // toward the current list if the list asks for it.
        this.stock[item]++;
        this.delivered[item]++;
        this.rateBuckets[item * RATE_WINDOW_SECONDS + this.rateCursor]++;
        if (this.goalNeed[item] !== 0) this.goalProgress[item]++;
        return true;
      default:
        return false;
    }
  }

  private transportStep(): void {
    if (this.topologyDirty) this.rebuildOrder();
    this.moved.fill(0, 0, this.count * BELT_SLOTS);
    const order = this.order;
    for (let i = 0; i < this.orderCount; i++) {
      const t = order[i];
      const base = t * BELT_SLOTS;
      const d = this.dir[t];
      const x = this.bx[t];
      const y = this.by[t];
      this.work.transportUpdates++;
      if (this.roleOf[this.kind[t]] === ROLE_BELT) {
        const last = base + BELT_SLOTS - 1;
        const lead = this.slots[last];
        if (lead !== 0 && this.moved[last] === 0 && this.tryInsert(x + DX[d], y + DY[d], lead, x, y)) {
          this.slots[last] = 0;
        }
        for (let s = last - 1; s >= base; s--) {
          const item = this.slots[s];
          if (item !== 0 && this.moved[s] === 0 && this.slots[s + 1] === 0) {
            this.slots[s + 1] = item;
            this.moved[s + 1] = MOVED_SLOT;
            this.slots[s] = 0;
          }
        }
      } else {
        const item = this.slots[base];
        if (item === 0 || this.moved[base] !== 0) continue;
        // Front, right, left, starting from the one after the last used.
        for (let k = 0; k < 3; k++) {
          const choice = (this.aux[t] + k) % 3;
          const od = choice === 0 ? d : choice === 1 ? (d + 1) & 3 : (d + 3) & 3;
          if (this.tryInsert(x + DX[od], y + DY[od], item, x, y)) {
            this.slots[base] = 0;
            this.aux[t] = (choice + 1) % 3;
            break;
          }
        }
      }
    }
  }

  /**
   * Orders belts and splitters so that each comes after everything it feeds.
   * Starting points are taken in slot order, which decides where a loop is cut.
   */
  private rebuildOrder(): void {
    this.topologyDirty = false;
    const state = this.orderState;
    state.fill(0, 0, this.count);
    this.orderCount = 0;
    const stack: number[] = [];
    for (let start = 0; start < this.count; start++) {
      const startRole = this.roleOf[this.kind[start]];
      if ((startRole !== ROLE_BELT && startRole !== ROLE_SPLITTER) || state[start] !== 0) continue;
      stack.push(start);
      while (stack.length > 0) {
        const t = stack[stack.length - 1];
        if (state[t] === 0) {
          state[t] = 1;
          const d = this.dir[t];
          this.pushTransport(stack, state, this.bx[t] + DX[d], this.by[t] + DY[d]);
          if (this.roleOf[this.kind[t]] === ROLE_SPLITTER) {
            const r = (d + 1) & 3;
            const l = (d + 3) & 3;
            this.pushTransport(stack, state, this.bx[t] + DX[r], this.by[t] + DY[r]);
            this.pushTransport(stack, state, this.bx[t] + DX[l], this.by[t] + DY[l]);
          }
        } else {
          stack.pop();
          if (state[t] === 1) {
            state[t] = 2;
            this.order[this.orderCount++] = t;
          }
        }
      }
    }
  }

  private pushTransport(stack: number[], state: Uint8Array, x: number, y: number): void {
    const t = this.world.buildingAt(x, y);
    if (t < 0 || state[t] !== 0) return;
    const role = this.roleOf[this.kind[t]];
    if (role === ROLE_BELT || role === ROLE_SPLITTER) stack.push(t);
  }

  private loadGoalNeed(): void {
    this.goalNeed.fill(0);
    for (const need of GOALS[this.goalIndex]?.needs ?? []) this.goalNeed[itemId(need.item)] = need.count;
  }

  /** Whether the hub is receiving every good of the current gate at the rate it asks. */
  gateRatesMet(): boolean {
    for (const r of GOALS[this.goalIndex]?.rates ?? []) {
      if (this.rate[itemId(r.item)] < r.perMinute) return false;
    }
    return true;
  }

  /** Closes the second just ended: totals the last 60 and starts a fresh one. */
  private updateRates(): void {
    const buckets = this.rateBuckets;
    for (let item = 1; item < ITEM_COUNT; item++) {
      let sum = 0;
      const base = item * RATE_WINDOW_SECONDS;
      for (let i = 0; i < RATE_WINDOW_SECONDS; i++) sum += buckets[base + i];
      this.rate[item] = sum;
    }
    this.rateCursor = (this.rateCursor + 1) % RATE_WINDOW_SECONDS;
    for (let item = 1; item < ITEM_COUNT; item++) buckets[item * RATE_WINDOW_SECONDS + this.rateCursor] = 0;
  }

  private updateTown(): void {
    this.updateRates();
    const goal = GOALS[this.goalIndex];
    if (!goal) return;
    for (const need of goal.needs) {
      if (this.goalProgress[itemId(need.item)] < need.count) return;
    }
    if (goal.rates) {
      // The count only moves while every rate is met. It never goes back.
      if (this.gateRatesMet()) this.gateHeld++;
      if (this.gateHeld < (goal.holdSeconds ?? 0)) return;
    }
    for (const key of goal.unlocks.buildings ?? []) this.unlockedBuildings[buildingId(key)] = 1;
    for (const key of goal.unlocks.recipes ?? []) this.unlockedRecipes[recipeId(key)] = 1;
    for (const key of goal.unlocks.resources ?? []) this.unlockedResources[itemId(key)] = 1;
    if (goal.unlocks.growMap) this.world.growTo(this.world.radius + 1);
    this.events.push({ type: 'goal', index: this.goalIndex });
    this.goalIndex++;
    this.gateHeld = 0;
    this.goalProgress.fill(0);
    this.loadGoalNeed();
    if (this.goalIndex === GOALS.length) this.events.push({ type: 'won' });
  }
}

/** Which side of tile (x, y) the neighbouring tile (nx, ny) is on, as a direction. */
function sideToward(x: number, y: number, nx: number, ny: number): number {
  if (nx > x) return 0;
  if (ny > y) return 1;
  if (nx < x) return 2;
  return 3;
}

export { ROLE_NONE, ROLE_BELT, ROLE_SPLITTER, ROLE_MINER, ROLE_MACHINE, ROLE_HUB };
