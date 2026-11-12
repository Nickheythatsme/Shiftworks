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
}

// Item id 0 means "nothing". Ids are stable: they are written into saves.
export const ITEMS: ItemDef[] = [
  { id: 1, key: 'timber', name: 'Timber', color: 0x8a5a2b, raw: true },
  { id: 2, key: 'stone', name: 'Stone', color: 0x9aa0a6, raw: true },
  { id: 3, key: 'iron_ore', name: 'Iron ore', color: 0x7b5c52, raw: true },
  { id: 4, key: 'copper_ore', name: 'Copper ore', color: 0xc8703a, raw: true },
  { id: 5, key: 'coal', name: 'Coal', color: 0x2c2c33, raw: true },
  { id: 6, key: 'planks', name: 'Planks', color: 0xd9a55b },
  { id: 7, key: 'bricks', name: 'Bricks', color: 0xb5543c },
  { id: 8, key: 'iron_plate', name: 'Iron plate', color: 0xc9d1d9 },
  { id: 9, key: 'charcoal', name: 'Charcoal', color: 0x4a4038 },
  { id: 10, key: 'tools', name: 'Tools', color: 0x4f8fd6 },
  { id: 11, key: 'fasteners', name: 'Fasteners', color: 0xe8d36b },
  { id: 12, key: 'copper_wire', name: 'Copper wire', color: 0xf09a4a },
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
  /** The player cannot place or remove it. */
  fixed?: boolean;
}

// Building id 0 means "empty slot". Ids are stable: they are written into saves.
// The order here is the order of the build bar, which follows the unlock order
// so number keys never shift under the player's fingers.
export const BUILDINGS: BuildingDef[] = [
  { id: 1, key: 'belt', name: 'Belt', size: 1, role: 'belt', color: 0x3b4252, hint: 'Carries items forward. Point a belt into the side of another to merge.' },
  { id: 3, key: 'miner', name: 'Miner', size: 1, role: 'miner', color: 0xd08770, hint: 'Place on a deposit. Pushes the resource out of its front.' },
  { id: 4, key: 'sawmill', name: 'Sawmill', size: 1, role: 'machine', color: 0xa3be8c, hint: 'Cuts timber into planks.' },
  { id: 5, key: 'kiln', name: 'Kiln', size: 1, role: 'machine', color: 0xbf616a, hint: 'Fires one input into one output. Pick the recipe.' },
  { id: 2, key: 'splitter', name: 'Splitter', size: 1, role: 'splitter', color: 0x5e81ac, hint: 'Takes items from behind and shares them between front, left and right.' },
  { id: 6, key: 'assembler', name: 'Assembler', size: 1, role: 'machine', color: 0xb48ead, hint: 'Combines two inputs into one part. Pick the recipe.' },
  { id: 7, key: 'hub', name: 'Town hub', size: 3, role: 'hub', color: 0xebcb8b, hint: 'Deliver goods here to grow the town.', fixed: true },
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
  unlocks: {
    buildings?: BuildingKey[];
    recipes?: string[];
    resources?: string[];
    /** Open one more ring of map chunks around the current map. */
    growMap?: boolean;
  };
}

/** What the player has before the first delivery. */
export const STARTING_UNLOCKS = {
  buildings: ['belt', 'miner', 'hub'] as BuildingKey[],
  recipes: [] as string[],
  resources: ['timber', 'stone', 'iron_ore'],
};

// The town's delivery lists, in order. Finishing one unlocks the next step.
// Tier 1 and the two-input half of tier 2 from the tech tree.
export const GOALS: GoalDef[] = [
  {
    key: 'first_timber', stage: 'Camp', title: 'Firewood for the camp',
    text: 'Put a miner on the timber stand and run a belt to the hub.',
    needs: [{ item: 'timber', count: 20 }],
    unlocks: { buildings: ['sawmill'], recipes: ['planks'] },
  },
  {
    key: 'planks', stage: 'Camp', title: 'Shelter',
    text: 'Saw timber into planks.',
    needs: [{ item: 'planks', count: 30 }],
    unlocks: { buildings: ['kiln'], recipes: ['bricks', 'iron_plate'] },
  },
  {
    key: 'kiln_goods', stage: 'Camp', title: 'Hearths and nails',
    text: 'Fire stone into bricks and iron ore into plate.',
    needs: [{ item: 'bricks', count: 40 }, { item: 'iron_plate', count: 40 }],
    unlocks: { buildings: ['splitter'] },
  },
  {
    key: 'hamlet', stage: 'Camp', title: 'Become a hamlet',
    text: 'Supply all three camp goods at once. Splitters let one line feed several machines.',
    needs: [{ item: 'planks', count: 60 }, { item: 'bricks', count: 60 }, { item: 'iron_plate', count: 60 }],
    unlocks: { buildings: ['assembler'], recipes: ['tools'], resources: ['copper_ore', 'coal'], growMap: true },
  },
  {
    key: 'tools', stage: 'Hamlet', title: 'Tools for every hand',
    text: 'An assembler needs two inputs: bring iron plate and planks together.',
    needs: [{ item: 'tools', count: 40 }],
    unlocks: { recipes: ['charcoal', 'fasteners'] },
  },
  {
    key: 'fasteners', stage: 'Hamlet', title: 'Workshops',
    text: 'Coal and iron plate make fasteners. Timber also burns down to charcoal.',
    needs: [{ item: 'fasteners', count: 60 }, { item: 'charcoal', count: 40 }],
    unlocks: { recipes: ['copper_wire'] },
  },
  {
    key: 'hamlet_done', stage: 'Hamlet', title: 'A thriving hamlet',
    text: 'Supply everything the hamlet builds with.',
    needs: [{ item: 'tools', count: 80 }, { item: 'fasteners', count: 80 }, { item: 'copper_wire', count: 60 }],
    unlocks: {},
  },
];

export const FINAL_STAGE = 'Village';

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
