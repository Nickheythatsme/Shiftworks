// Game content as plain data. Balancing and adding content happens here and
// never needs a change to the simulation code. Durations are in seconds and
// are converted to ticks when the simulation loads them.

export const TICKS_PER_SECOND = 30;

/** Seconds an item takes to move one belt slot. Four slots per tile. */
export const BELT_SLOT_SECONDS = 1 / 6;
export const BELT_SLOTS = 4;

export interface ItemDef {
  id: number;
  key: string;
  name: string;
  color: number;
  /** Raw resources sit on deposits and are extracted by miners. */
  raw?: boolean;
  /** How the item is drawn on a belt. */
  shape: 'chunk' | 'log' | 'plank' | 'plate' | 'brick' | 'crate' | 'coil';
}

// Item id 0 means "nothing". Ids are stable: they are written into saves.
export const ITEMS: ItemDef[] = [
  { id: 1, key: 'timber', name: 'Timber', color: 0x8a5a2b, shape: 'log', raw: true },
  { id: 2, key: 'stone', name: 'Stone', color: 0x9aa0a6, shape: 'chunk', raw: true },
  { id: 3, key: 'iron_ore', name: 'Iron ore', color: 0x7b5c52, shape: 'chunk', raw: true },
  { id: 4, key: 'copper_ore', name: 'Copper ore', color: 0xc8703a, shape: 'chunk', raw: true },
  { id: 5, key: 'coal', name: 'Coal', color: 0x2c2c33, shape: 'chunk', raw: true },
  { id: 6, key: 'planks', name: 'Planks', color: 0xd9a55b, shape: 'plank' },
  { id: 7, key: 'bricks', name: 'Bricks', color: 0xb5543c, shape: 'brick' },
  { id: 8, key: 'iron_plate', name: 'Iron plate', color: 0xc9d1d9, shape: 'plate' },
  { id: 9, key: 'charcoal', name: 'Charcoal', color: 0x4a4038, shape: 'chunk' },
  { id: 10, key: 'tools', name: 'Tools', color: 0x4f8fd6, shape: 'crate' },
  { id: 11, key: 'fasteners', name: 'Fasteners', color: 0xe8d36b, shape: 'crate' },
  { id: 12, key: 'copper_wire', name: 'Copper wire', color: 0xf09a4a, shape: 'coil' },
];

export const ITEM_COUNT = ITEMS.length + 1;

export type BuildingKey =
  | 'belt'
  | 'splitter'
  | 'miner'
  | 'sawmill'
  | 'kiln'
  | 'assembler'
  | 'hub';

export interface BuildingDef {
  id: number;
  key: BuildingKey;
  name: string;
  /** Footprint is size by size tiles. */
  size: number;
  role: 'belt' | 'splitter' | 'miner' | 'machine' | 'hub';
  color: number;
  hint: string;
  /** Materials taken from the hub to build it, and returned when it is removed. */
  cost: { item: string; count: number }[];
  /** The player cannot place or remove it. */
  fixed?: boolean;
}

// Building id 0 means "empty slot". Ids are stable: they are written into saves.
// Costs rise with complexity: simple buildings take raw materials, later ones
// take the parts the factory has learned to make. Removing a building returns
// its full cost, so redesigning is never punished.
// The order here is the order of the build bar, which follows the unlock order
// so number keys never shift under the player's fingers.
export const BUILDINGS: BuildingDef[] = [
  { id: 1, key: 'belt', name: 'Belt', size: 1, role: 'belt', color: 0x3b4252, hint: 'Carries items forward. Point a belt into the side of another to merge.', cost: [{ item: 'timber', count: 1 }] },
  { id: 3, key: 'miner', name: 'Miner', size: 1, role: 'miner', color: 0xd08770, hint: 'Place on a deposit. Pushes the resource out of its front.', cost: [{ item: 'timber', count: 4 }, { item: 'stone', count: 4 }] },
  { id: 4, key: 'sawmill', name: 'Sawmill', size: 1, role: 'machine', color: 0xa3be8c, hint: 'Cuts timber into planks.', cost: [{ item: 'timber', count: 10 }, { item: 'stone', count: 6 }] },
  { id: 5, key: 'kiln', name: 'Kiln', size: 1, role: 'machine', color: 0xbf616a, hint: 'Fires one input into one output. Pick the recipe.', cost: [{ item: 'stone', count: 10 }, { item: 'planks', count: 8 }] },
  { id: 2, key: 'splitter', name: 'Splitter', size: 1, role: 'splitter', color: 0x5e81ac, hint: 'Takes items from behind and shares them between front, left and right.', cost: [{ item: 'planks', count: 4 }, { item: 'iron_plate', count: 2 }] },
  { id: 6, key: 'assembler', name: 'Assembler', size: 1, role: 'machine', color: 0xb48ead, hint: 'Combines two inputs into one part. Pick the recipe.', cost: [{ item: 'bricks', count: 12 }, { item: 'iron_plate', count: 12 }, { item: 'planks', count: 8 }] },
  { id: 7, key: 'hub', name: 'Town hub', size: 3, role: 'hub', color: 0xebcb8b, hint: 'Deliver goods here to grow the town.', cost: [], fixed: true },
];

export interface RecipeDef {
  id: number;
  key: string;
  name: string;
  building: BuildingKey;
  inputs: { item: string; count: number }[];
  output: { item: string; count: number };
  seconds: number;
}

// Recipe id 0 means "no recipe". Ids are stable: they are written into saves.
export const RECIPES: RecipeDef[] = [
  { id: 1, key: 'planks', name: 'Planks', building: 'sawmill', inputs: [{ item: 'timber', count: 1 }], output: { item: 'planks', count: 1 }, seconds: 1.5 },
  { id: 2, key: 'bricks', name: 'Bricks', building: 'kiln', inputs: [{ item: 'stone', count: 1 }], output: { item: 'bricks', count: 1 }, seconds: 2 },
  { id: 3, key: 'iron_plate', name: 'Iron plate', building: 'kiln', inputs: [{ item: 'iron_ore', count: 1 }], output: { item: 'iron_plate', count: 1 }, seconds: 2 },
  { id: 4, key: 'charcoal', name: 'Charcoal', building: 'kiln', inputs: [{ item: 'timber', count: 1 }], output: { item: 'charcoal', count: 1 }, seconds: 2 },
  { id: 5, key: 'tools', name: 'Tools', building: 'assembler', inputs: [{ item: 'iron_plate', count: 1 }, { item: 'planks', count: 1 }], output: { item: 'tools', count: 1 }, seconds: 3 },
  { id: 6, key: 'fasteners', name: 'Fasteners', building: 'assembler', inputs: [{ item: 'iron_plate', count: 1 }, { item: 'coal', count: 1 }], output: { item: 'fasteners', count: 2 }, seconds: 3 },
  { id: 7, key: 'copper_wire', name: 'Copper wire', building: 'assembler', inputs: [{ item: 'copper_ore', count: 1 }, { item: 'charcoal', count: 1 }], output: { item: 'copper_wire', count: 2 }, seconds: 3 },
];

/** Seconds a miner takes to extract one item. */
export const MINER_SECONDS = 1.5;

export interface GoalDef {
  key: string;
  title: string;
  /** Town stage shown while this goal is current. */
  stage: string;
  text: string;
  needs: { item: string; count: number }[];
  /**
   * A gate: every one of these goods has to arrive at the hub at this rate, all
   * at once, for `holdSeconds`. A gate cannot be passed by waiting.
   */
  rates?: { item: string; perMinute: number }[];
  /** Seconds the rates must be held. The count pauses when a rate drops; it does not reset. */
  holdSeconds?: number;
  /** What the town takes out of the hub's stock while this goal is current. */
  consumes?: { item: string; perMinute: number }[];
  unlocks: {
    buildings?: BuildingKey[];
    recipes?: string[];
    resources?: string[];
    /** Open one more ring of map chunks around the current map. */
    growMap?: boolean;
  };
}

/**
 * Materials in the hub when a game starts: enough for a couple of miners and
 * the first belts. Everything after that has to be delivered.
 */
export const STARTING_STOCK: { item: string; count: number }[] = [
  { item: 'timber', count: 60 },
  { item: 'stone', count: 20 },
];

/** What the player has before the first delivery. */
export const STARTING_UNLOCKS = {
  buildings: ['belt', 'miner', 'hub'] as BuildingKey[],
  recipes: [] as string[],
  resources: ['timber', 'stone', 'iron_ore'],
};

/** Deliveries are counted over this many seconds to give a rate per minute. */
export const RATE_WINDOW_SECONDS = 60;

// The town's stages. Each entry is the gate out of that stage: the town moves
// up once the factory is big enough to keep the gate's goods arriving. Gate
// rates sit a little under a whole number of machines (100 a minute is three
// sawmills' 120, or four kilns' 120) so that the right number of machines
// holds the rate without flickering.
//
// From the hamlet on, the town also uses goods: it takes them out of the hub's
// stock, the same stock buildings are paid from, and a gate's count pauses
// while the town is short of anything.
export const GOALS: GoalDef[] = [
  {
    key: 'hamlet', stage: 'Camp', title: 'Become a hamlet',
    text: 'The camp becomes a hamlet once all three goods keep arriving at this rate, together, for three minutes. Start with a miner on timber and a belt to the hub, then buy the sawmill below.',
    needs: [],
    rates: [{ item: 'planks', perMinute: 100 }, { item: 'bricks', perMinute: 100 }, { item: 'iron_plate', perMinute: 100 }],
    holdSeconds: 180,
    unlocks: { resources: ['copper_ore', 'coal'], growMap: true },
  },
  {
    key: 'village', stage: 'Hamlet', title: 'Become a village',
    text: 'The hamlet now uses what the camp learned to make, so those lines have to keep running. Keep the three new goods arriving at this rate, together, for five minutes.',
    needs: [],
    rates: [{ item: 'tools', perMinute: 100 }, { item: 'fasteners', perMinute: 100 }, { item: 'copper_wire', perMinute: 100 }],
    holdSeconds: 300,
    consumes: [{ item: 'planks', perMinute: 30 }, { item: 'bricks', perMinute: 30 }, { item: 'iron_plate', perMinute: 30 }],
    unlocks: {},
  },
];

export const FINAL_STAGE = 'Village';

/** What the town uses once the last gate is passed. */
export const FINAL_CONSUMES: { item: string; perMinute: number }[] = [
  { item: 'planks', perMinute: 30 }, { item: 'bricks', perMinute: 30 }, { item: 'iron_plate', perMinute: 30 },
  { item: 'tools', perMinute: 30 }, { item: 'fasteners', perMinute: 30 }, { item: 'copper_wire', perMinute: 30 },
];

export interface TechDef {
  id: number;
  key: string;
  name: string;
  text: string;
  /** The town stage it becomes available in: an index into GOALS. */
  stage: number;
  /** Other techs that must be bought first. */
  requires: string[];
  /** Taken from the hub's stock, once. It is not refunded. */
  cost: { item: string; count: number }[];
  unlocks: { buildings?: BuildingKey[]; recipes?: string[] };
}

// Things the town learns, bought from the hub's stock in whatever order the
// player likes. Tech id 0 means "none". Ids are stable: they are written into
// saves. Every cost is more than the starting stock holds of that item, so a
// tech can only be bought by a factory that is already delivering it.
export const TECHS: TechDef[] = [
  {
    id: 1, key: 'sawmill', name: 'Sawmill', text: 'A machine that cuts timber into planks.',
    stage: 0, requires: [], cost: [{ item: 'timber', count: 80 }],
    unlocks: { buildings: ['sawmill'], recipes: ['planks'] },
  },
  {
    id: 2, key: 'kiln', name: 'Kiln', text: 'A machine that fires stone into bricks and iron ore into plate.',
    stage: 0, requires: ['sawmill'], cost: [{ item: 'planks', count: 40 }, { item: 'stone', count: 40 }],
    unlocks: { buildings: ['kiln'], recipes: ['bricks', 'iron_plate'] },
  },
  {
    id: 3, key: 'splitter', name: 'Splitter', text: 'Shares one line between up to three, so one belt can feed several machines.',
    stage: 0, requires: ['kiln'], cost: [{ item: 'bricks', count: 40 }, { item: 'iron_plate', count: 40 }],
    unlocks: { buildings: ['splitter'] },
  },
  {
    id: 4, key: 'assembler', name: 'Assembler', text: 'A machine that combines two inputs. It starts with tools, made from iron plate and planks.',
    stage: 1, requires: [], cost: [{ item: 'bricks', count: 100 }, { item: 'iron_plate', count: 100 }, { item: 'planks', count: 60 }],
    unlocks: { buildings: ['assembler'], recipes: ['tools'] },
  },
  {
    id: 5, key: 'charcoal', name: 'Charcoal burning', text: 'A kiln recipe that burns timber down to charcoal.',
    stage: 1, requires: [], cost: [{ item: 'planks', count: 80 }, { item: 'bricks', count: 40 }],
    unlocks: { recipes: ['charcoal'] },
  },
  {
    id: 6, key: 'fasteners', name: 'Fasteners', text: 'An assembler recipe: iron plate and coal make fasteners.',
    stage: 1, requires: ['assembler'], cost: [{ item: 'tools', count: 60 }],
    unlocks: { recipes: ['fasteners'] },
  },
  {
    id: 7, key: 'copper_wire', name: 'Wire drawing', text: 'An assembler recipe: copper ore and charcoal make copper wire.',
    stage: 1, requires: ['assembler', 'charcoal'], cost: [{ item: 'tools', count: 60 }, { item: 'charcoal', count: 60 }],
    unlocks: { recipes: ['copper_wire'] },
  },
];

// ---- lookups ---------------------------------------------------------------

export const ITEM_BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));
export const ITEM_BY_ID: (ItemDef | undefined)[] = [];
for (const i of ITEMS) ITEM_BY_ID[i.id] = i;

export const BUILDING_BY_KEY = new Map(BUILDINGS.map((b) => [b.key, b]));
export const BUILDING_BY_ID: (BuildingDef | undefined)[] = [];
for (const b of BUILDINGS) BUILDING_BY_ID[b.id] = b;

export const RECIPE_BY_KEY = new Map(RECIPES.map((r) => [r.key, r]));
export const RECIPE_BY_ID: (RecipeDef | undefined)[] = [];
for (const r of RECIPES) RECIPE_BY_ID[r.id] = r;

export const TECH_BY_KEY = new Map(TECHS.map((t) => [t.key, t]));
export const TECH_BY_ID: (TechDef | undefined)[] = [];
for (const t of TECHS) TECH_BY_ID[t.id] = t;

export function itemId(key: string): number {
  const def = ITEM_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown item: ${key}`);
  return def.id;
}

export function buildingId(key: BuildingKey): number {
  const def = BUILDING_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown building: ${key}`);
  return def.id;
}

export function recipeId(key: string): number {
  const def = RECIPE_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown recipe: ${key}`);
  return def.id;
}
