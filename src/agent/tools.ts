// What an AI player can see and do. Everything here reads the simulation and
// issues the same commands a human does through the interface: nothing reaches
// around the rules. Coordinates the agent uses are relative to the hub centre
// (x grows east, y grows south) so the numbers stay small.
//
// This file knows nothing about the model or the network. It is used by the
// agent loop, and directly by tests.

import {
  BUILDINGS, BUILDING_BY_ID, BUILDING_BY_KEY, GOALS, ITEMS, ITEM_BY_ID, ITEM_BY_KEY, MINER_SECONDS, RECIPES,
  RECIPE_BY_ID, RECIPE_BY_KEY, TICKS_PER_SECOND, BELT_SLOTS, buildingId, type BuildingDef, type BuildingKey,
} from '../content/content';
import {
  DX, DY, HUB_X, HUB_Y, ROLE_BELT, ROLE_HUB, ROLE_MACHINE, ROLE_MINER, ROLE_SPLITTER, STATUS_BLOCKED, STATUS_STARVED,
  STATUS_WORKING, Sim, TERRAIN_LAND,
} from '../sim';

/** Where the agent's actions land: a headless simulation or the live game. */
export interface AgentHost {
  sim(): Sim;
  /** Lets game time pass. Resolves after `ticks`, or earlier once `shouldStop` returns true. */
  advance(ticks: number, shouldStop: () => boolean): Promise<void>;
  /** Optional: point the camera at a tile (world coordinates). */
  focus?(x: number, y: number): void;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

export class ToolError extends Error {}

const DIRS = ['E', 'S', 'W', 'N'] as const;
const BELT = buildingId('belt');
const MAX_WAIT_SECONDS = 300;
const MAX_VIEW_RADIUS = 15;
const MAP_SYMBOL: Record<string, string> = { miner: 'M', sawmill: 'W', kiln: 'K', assembler: 'A', splitter: 'Y', hub: 'H' };
const DEPOSIT_SYMBOL: Record<string, string> = { timber: 't', stone: 's', iron_ore: 'i', copper_ore: 'c', coal: 'k' };
const BELT_SYMBOL = ['>', 'v', '<', '^'];

const point = { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[x, y] relative to the hub centre' };
const dirSchema = { type: 'string', enum: [...DIRS], description: 'E = +x, S = +y, W = -x, N = -y' };

export const TOOLS: ToolDef[] = [
  {
    name: 'get_state',
    description:
      'The whole situation in one read: game time, the current delivery list and progress, hub stock, what can be built and what it costs, unlocked recipes, every miner and machine with its status, and a list of detected problems. Call this when you need to re-orient; wait already reports progress and problems.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'view_map',
    description:
      `A character map of the tiles around a point, up to ${MAX_VIEW_RADIUS} tiles in each direction, followed by the buildings in view with exact positions and facings. Use it before building in an area to see deposits, water and what is already there.`,
    input_schema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, radius: { type: 'integer', minimum: 2, maximum: MAX_VIEW_RADIUS } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_deposits',
    description:
      'Lists deposit patches of one resource on the open map, nearest to the hub first, with their size, bounds and how many tiles are still free. Deposits never run out.',
    input_schema: {
      type: 'object',
      properties: { resource: { type: 'string', enum: ITEMS.filter((i) => i.raw).map((i) => i.key) }, limit: { type: 'integer', minimum: 1, maximum: 12 } },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect',
    description: 'Everything about one tile: terrain, deposit, and the building on it with what it holds and what its front points at.',
    input_schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'], additionalProperties: false },
  },
  {
    name: 'build',
    description:
      'Places one building. Miners must sit on a deposit tile. dir is the way the building faces, which is where its output goes. For machines, recipe picks what it makes (a machine starts with the first unlocked recipe for its type). Placing a belt on an existing belt turns it for free.',
    input_schema: {
      type: 'object',
      properties: {
        building: { type: 'string', enum: BUILDINGS.filter((b) => !b.fixed).map((b) => b.key) },
        x: { type: 'integer' },
        y: { type: 'integer' },
        dir: dirSchema,
        recipe: { type: 'string', enum: RECIPES.map((r) => r.key) },
      },
      required: ['building', 'x', 'y', 'dir'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_belt',
    description:
      'Lays belt along a path you choose. path is a list of corner points; consecutive points must share an x or a y. Each belt points at the next tile on the path. The last belt keeps the direction of the final segment unless end_dir says otherwise, so end the path on the tile next to the target. Nothing is placed unless the whole path is valid and affordable.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'array', items: point, minItems: 1 }, end_dir: dirSchema },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'connect',
    description:
      'Routes a belt automatically and builds it. from is a building whose output should be carried away (miner, machine, the end of a belt line, or a splitter with out_dir), or an empty tile to start a fresh line on. to is the building that should receive the items: a machine, the hub, a belt to merge into, or a splitter. The route avoids buildings, water and tiles where another building already pushes its output. Nothing is placed unless a full route exists and is affordable.',
    input_schema: {
      type: 'object',
      properties: { from: point, to: point, out_dir: { ...dirSchema, description: 'Only for a splitter source: which of its three outputs to extend' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_recipe',
    description: 'Changes what a machine makes. Anything it was holding is lost.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, recipe: { type: 'string', enum: RECIPES.map((r) => r.key) } },
      required: ['x', 'y', 'recipe'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove',
    description:
      'Removes buildings and returns their full cost to the hub. Give tiles as a list of points, or from and to as opposite corners of a rectangle. Items a building was holding are lost. The hub cannot be removed.',
    input_schema: {
      type: 'object',
      properties: { tiles: { type: 'array', items: point }, from: point, to: point },
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      `Lets the factory run. Game time only passes here: nothing is mined, moved or delivered between your other calls. Waits up to ${MAX_WAIT_SECONDS} seconds and returns early when the delivery list completes. Reports what reached the hub, progress on the list, and any problems.`,
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS } },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
];

// ---- small helpers ---------------------------------------------------------

function int(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolError(`${name} must be a whole number.`);
  return value;
}

function pt(value: unknown, name: string): { x: number; y: number } {
  if (!Array.isArray(value) || value.length !== 2) throw new ToolError(`${name} must be [x, y].`);
  return { x: int(value[0], `${name}[0]`) + HUB_X, y: int(value[1], `${name}[1]`) + HUB_Y };
}

function dirOf(value: unknown, name = 'dir'): number {
  const d = DIRS.indexOf(value as (typeof DIRS)[number]);
  if (d < 0) throw new ToolError(`${name} must be one of E, S, W, N.`);
  return d;
}

/** A world tile as the agent sees it. */
function at(x: number, y: number): string {
  return `(${x - HUB_X},${y - HUB_Y})`;
}

function itemKey(id: number): string {
  return ITEM_BY_ID[id]?.key ?? '?';
}

function clock(tick: number): string {
  const s = Math.floor(tick / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function costText(def: BuildingDef): string {
  return def.cost.length ? def.cost.map((c) => `${c.count} ${c.item}`).join(' + ') : 'free';
}

function recipeText(id: number): string {
  const r = RECIPE_BY_ID[id];
  if (!r) return 'none';
  return `${r.inputs.map((i) => `${i.count} ${i.item}`).join(' + ')} -> ${r.output.count} ${r.output.item} every ${r.seconds}s`;
}

function stockText(sim: Sim): string {
  const parts = ITEMS.filter((i) => sim.stock[i.id] > 0).map((i) => `${i.key} ${sim.stock[i.id]}`);
  return parts.length ? parts.join(', ') : 'empty';
}

function goalText(sim: Sim): string {
  const goal = GOALS[sim.goalIndex];
  if (!goal) return 'Every delivery list is complete. The game is won.';
  const needs = goal.needs.map((n) => {
    const have = Math.min(sim.goalProgress[ITEM_BY_KEY.get(n.item)!.id], n.count);
    return `${n.item} ${have}/${n.count}${have >= n.count ? ' done' : ''}`;
  });
  return `Delivery list ${sim.goalIndex + 1} of ${GOALS.length}, "${goal.title}": ${needs.join(', ')}. ${goal.text} Completing it unlocks: ${unlockText(sim.goalIndex)}.`;
}

function unlockText(goalIndex: number): string {
  const u = GOALS[goalIndex]?.unlocks;
  if (!u) return 'nothing';
  const parts: string[] = [];
  for (const b of u.buildings ?? []) parts.push(`${b} (building)`);
  for (const r of u.recipes ?? []) parts.push(`${r} (recipe: ${recipeText(RECIPE_BY_KEY.get(r)!.id)}, made in a ${RECIPE_BY_KEY.get(r)!.building})`);
  for (const r of u.resources ?? []) parts.push(`${r} (deposits become usable)`);
  if (u.growMap) parts.push('more land around the map');
  return parts.length ? parts.join('; ') : 'nothing new, it is the last list';
}

function nameOf(sim: Sim, slot: number): string {
  return BUILDING_BY_ID[sim.kind[slot]]?.key ?? '?';
}

function label(sim: Sim, slot: number): string {
  return `${nameOf(sim, slot)} ${at(sim.bx[slot], sim.by[slot])}`;
}

/**
 * Why the building on (tx, ty) would refuse `item` arriving from (fx, fy), or
 * null if it would take it when it has room. Mirrors the simulation's rules.
 */
function refusal(sim: Sim, tx: number, ty: number, item: number, fx: number, fy: number): string | null {
  const t = sim.world.buildingAt(tx, ty);
  if (t < 0) {
    if (!sim.world.hasTile(tx, ty)) return `points off the map at ${at(tx, ty)}`;
    return sim.world.terrainAt(tx, ty) === TERRAIN_LAND ? `points at empty ground ${at(tx, ty)}` : `points at water ${at(tx, ty)}`;
  }
  const d = sim.dir[t];
  switch (sim.role(t)) {
    case ROLE_BELT:
      return sim.bx[t] + DX[d] === fx && sim.by[t] + DY[d] === fy ? `faces the belt at ${at(tx, ty)} head-on, so nothing passes` : null;
    case ROLE_SPLITTER:
      return sim.bx[t] - DX[d] === fx && sim.by[t] - DY[d] === fy
        ? null
        : `points into the side of the splitter at ${at(tx, ty)}, which only takes items from behind (${at(sim.bx[t] - DX[d], sim.by[t] - DY[d])})`;
    case ROLE_MACHINE: {
      const r = RECIPE_BY_ID[sim.recipe[t]];
      if (!r) return `points at the ${label(sim, t)}, which has no recipe`;
      if (item && !r.inputs.some((i) => ITEM_BY_KEY.get(i.item)!.id === item)) {
        return `carries ${itemKey(item)} into the ${label(sim, t)}, whose recipe (${r.key}) does not use it, so the line is jammed`;
      }
      return null;
    }
    case ROLE_HUB:
      return null;
    default:
      return `points at the ${label(sim, t)}, which accepts nothing`;
  }
}

/** Whether any neighbour pushes items into the building in `slot`. */
function hasFeeder(sim: Sim, slot: number): boolean {
  const x = sim.bx[slot];
  const y = sim.by[slot];
  for (let side = 0; side < 4; side++) {
    const n = sim.world.buildingAt(x + DX[side], y + DY[side]);
    if (n < 0) continue;
    const role = sim.role(n);
    const d = sim.dir[n];
    const outs = role === ROLE_SPLITTER ? [d, (d + 1) & 3, (d + 3) & 3] : role === ROLE_BELT || role === ROLE_MINER || role === ROLE_MACHINE ? [d] : [];
    for (const o of outs) if (sim.bx[n] + DX[o] === x && sim.by[n] + DY[o] === y) return true;
  }
  return false;
}

/** Things that are wrong with the factory right now, worst first, in plain words. */
export function problems(sim: Sim, limit = 12): string[] {
  const found: string[] = [];
  const deadEnds: string[] = [];
  for (let s = 0; s < sim.count; s++) {
    const role = sim.role(s);
    if (!sim.kind[s] || role === ROLE_HUB) continue;
    const x = sim.bx[s];
    const y = sim.by[s];
    const d = sim.dir[s];
    if (role === ROLE_BELT) {
      const why = refusal(sim, x + DX[d], y + DY[d], sim.slots[s * BELT_SLOTS + BELT_SLOTS - 1], x, y);
      if (why) deadEnds.push(`belt ${at(x, y)} facing ${DIRS[d]} ${why}`);
      continue;
    }
    if (role === ROLE_SPLITTER) continue;
    if (role === ROLE_MACHINE && !sim.recipe[s]) {
      found.push(`${label(sim, s)} has no recipe`);
      continue;
    }
    const why = refusal(sim, x + DX[d], y + DY[d], sim.outputItem(s), x, y);
    if (why) found.push(`${label(sim, s)} facing ${DIRS[d]} ${why}${sim.status[s] === STATUS_BLOCKED ? ' and is blocked' : ''}`);
    if (role === ROLE_MACHINE) {
      const r = RECIPE_BY_ID[sim.recipe[s]]!;
      if (!hasFeeder(sim, s)) {
        found.push(`${label(sim, s)} (${r.key}) has nothing feeding it: no belt or building points into it`);
      } else if (sim.status[s] === STATUS_STARVED && r.inputs.length === 2 && sim.tick > 0) {
        const a = sim.inA[s];
        const b = sim.inB[s];
        if (a >= r.inputs[0].count && b < r.inputs[1].count && a >= 4) found.push(`${label(sim, s)} (${r.key}) is full of ${r.inputs[0].item} but has no ${r.inputs[1].item}`);
        if (b >= r.inputs[1].count && a < r.inputs[0].count && b >= 4) found.push(`${label(sim, s)} (${r.key}) is full of ${r.inputs[1].item} but has no ${r.inputs[0].item}`);
      }
    }
  }
  const all = [...found, ...deadEnds];
  if (all.length > limit) return [...all.slice(0, limit), `...and ${all.length - limit} more`];
  return all;
}

function statusText(sim: Sim, slot: number): string {
  switch (sim.status[slot]) {
    case STATUS_WORKING: return 'working';
    case STATUS_STARVED: return 'waiting for inputs';
    case STATUS_BLOCKED: return 'output full';
    default: return sim.role(slot) === ROLE_MACHINE && !sim.recipe[slot] ? 'no recipe' : 'not started';
  }
}

function describeBuilding(sim: Sim, slot: number): string {
  const role = sim.role(slot);
  const d = sim.dir[slot];
  const head = `${label(sim, slot)} facing ${DIRS[d]}`;
  if (role === ROLE_MINER) return `${head}, mining ${itemKey(sim.aux[slot])}, ${statusText(sim, slot)}`;
  if (role === ROLE_MACHINE) {
    const r = RECIPE_BY_ID[sim.recipe[slot]];
    if (!r) return `${head}, no recipe`;
    const held = [`${r.inputs[0].item} ${sim.inA[slot]}`];
    if (r.inputs[1]) held.push(`${r.inputs[1].item} ${sim.inB[slot]}`);
    return `${head}, recipe ${r.key}, ${statusText(sim, slot)}, holds ${held.join(' + ')}, ${sim.out[slot]} ${r.output.item} ready`;
  }
  if (role === ROLE_BELT || role === ROLE_SPLITTER) {
    const items: string[] = [];
    for (let i = 0; i < BELT_SLOTS; i++) if (sim.slots[slot * BELT_SLOTS + i]) items.push(itemKey(sim.slots[slot * BELT_SLOTS + i]));
    return `${head}, carrying ${items.length ? items.join(', ') : 'nothing'}`;
  }
  return 'town hub: any belt pointing into one of its 9 tiles delivers';
}

/** What the tile in front of a building holds, for feedback after building. */
function frontText(sim: Sim, slot: number): string {
  const d = sim.dir[slot];
  const fx = sim.bx[slot] + DX[d];
  const fy = sim.by[slot] + DY[d];
  const why = refusal(sim, fx, fy, sim.outputItem(slot), sim.bx[slot], sim.by[slot]);
  if (why) return `Warning: it ${why}.`;
  return `Its output goes to the ${label(sim, sim.world.buildingAt(fx, fy))}.`;
}

// ---- the tools --------------------------------------------------------------

function getState(sim: Sim): string {
  const lines: string[] = [];
  lines.push(`Game time ${clock(sim.tick)}.`);
  lines.push(goalText(sim));
  lines.push(`Hub stock (building materials): ${stockText(sim)}.`);
  const buildable = BUILDINGS.filter((b) => !b.fixed && sim.unlockedBuildings[b.id]);
  lines.push(`Buildable: ${buildable.map((b) => `${b.key} (${costText(b)})`).join(', ')}.`);
  const recipes = RECIPES.filter((r) => sim.unlockedRecipes[r.id]);
  lines.push(recipes.length ? `Recipes: ${recipes.map((r) => `${r.key} in a ${r.building}: ${recipeText(r.id)}`).join('; ')}.` : 'Recipes: none yet.');
  lines.push(`Usable resources: ${ITEMS.filter((i) => i.raw && sim.unlockedResources[i.id]).map((i) => i.key).join(', ')}.`);
  lines.push(`Map spans x and y from ${sim.world.minTile - HUB_X} to ${sim.world.maxTile - HUB_X}. The hub covers (-1,-1) to (1,1).`);

  const machines: string[] = [];
  let belts = 0;
  let splitters = 0;
  for (let s = 0; s < sim.count; s++) {
    const role = sim.role(s);
    if (role === ROLE_BELT) belts++;
    else if (role === ROLE_SPLITTER) splitters++;
    else if (role === ROLE_MINER || role === ROLE_MACHINE) machines.push(describeBuilding(sim, s));
  }
  lines.push(`Buildings: ${belts} belt tiles, ${splitters} splitters, ${machines.length} miners and machines${machines.length ? ':' : '.'}`);
  for (const m of machines) lines.push(`  ${m}`);
  const issues = problems(sim);
  lines.push(issues.length ? 'Problems:' : 'Problems: none detected.');
  for (const p of issues) lines.push(`  ${p}`);
  return lines.join('\n');
}

function viewMap(sim: Sim, input: Record<string, unknown>): string {
  const cx = int(input.x, 'x') + HUB_X;
  const cy = int(input.y, 'y') + HUB_Y;
  const radius = Math.max(2, Math.min(MAX_VIEW_RADIUS, input.radius === undefined ? 10 : int(input.radius, 'radius')));
  const pad = 4;
  const lines: string[] = [];
  let header = ' '.repeat(pad + 1);
  for (let x = cx - radius; x <= cx + radius; x++) {
    const rel = x - HUB_X;
    header += (rel % 5 === 0 ? String(Math.abs(rel) % 100).padStart(2, ' ') : '  ');
  }
  lines.push(`x:${header.slice(2)}   (column labels mark every 5th x, last two digits)`);
  const seen = new Set<number>();
  for (let y = cy - radius; y <= cy + radius; y++) {
    let row = String(y - HUB_Y).padStart(pad, ' ') + ' ';
    for (let x = cx - radius; x <= cx + radius; x++) {
      let ch: string;
      const slot = sim.world.buildingAt(x, y);
      if (!sim.world.hasTile(x, y)) ch = '#';
      else if (slot >= 0) {
        ch = sim.isBelt(slot) ? BELT_SYMBOL[sim.dir[slot]] : MAP_SYMBOL[nameOf(sim, slot)] ?? '?';
        seen.add(slot);
      } else if (sim.world.terrainAt(x, y) !== TERRAIN_LAND) ch = '~';
      else {
        const deposit = sim.world.depositAt(x, y);
        ch = deposit ? DEPOSIT_SYMBOL[itemKey(deposit)] ?? '?' : '.';
      }
      row += ' ' + ch;
    }
    lines.push(row);
  }
  lines.push(`Rows are y from ${cy - radius - HUB_Y} to ${cy + radius - HUB_Y}; columns are x from ${cx - radius - HUB_X} to ${cx + radius - HUB_X}.`);
  lines.push('Key: . ground, ~ water, # off the map, deposits t timber s stone i iron_ore c copper_ore k coal, belts > v < ^, M miner, W sawmill, K kiln, A assembler, Y splitter, H hub.');
  const listed = [...seen].filter((s) => !sim.isBelt(s) && sim.role(s) !== ROLE_HUB);
  if (listed.length) {
    lines.push('Buildings in view:');
    for (const s of listed) lines.push(`  ${describeBuilding(sim, s)}`);
  }
  return lines.join('\n');
}

function findDeposits(sim: Sim, input: Record<string, unknown>): string {
  const item = ITEM_BY_KEY.get(String(input.resource));
  if (!item?.raw) throw new ToolError('resource must be a raw resource.');
  const limit = input.limit === undefined ? 5 : int(input.limit, 'limit');
  const min = sim.world.minTile;
  const size = sim.world.maxTile - min + 1;
  const visited = new Uint8Array(size * size);
  const patches: { tiles: number; free: number; x0: number; y0: number; x1: number; y1: number; nx: number; ny: number; dist: number }[] = [];
  const stack: number[] = [];
  for (let sy = 0; sy < size; sy++) {
    for (let sx = 0; sx < size; sx++) {
      if (visited[sy * size + sx] || sim.world.depositAt(sx + min, sy + min) !== item.id) continue;
      const p = { tiles: 0, free: 0, x0: sx, y0: sy, x1: sx, y1: sy, nx: sx, ny: sy, dist: Infinity };
      visited[sy * size + sx] = 1;
      stack.push(sx, sy);
      while (stack.length) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        p.tiles++;
        if (sim.world.buildingAt(x + min, y + min) < 0) p.free++;
        p.x0 = Math.min(p.x0, x); p.x1 = Math.max(p.x1, x);
        p.y0 = Math.min(p.y0, y); p.y1 = Math.max(p.y1, y);
        const dist = Math.abs(x + min - HUB_X) + Math.abs(y + min - HUB_Y);
        if (dist < p.dist) { p.dist = dist; p.nx = x; p.ny = y; }
        for (let side = 0; side < 4; side++) {
          const ax = x + DX[side];
          const ay = y + DY[side];
          if (ax < 0 || ay < 0 || ax >= size || ay >= size || visited[ay * size + ax]) continue;
          if (sim.world.depositAt(ax + min, ay + min) !== item.id) continue;
          visited[ay * size + ax] = 1;
          stack.push(ax, ay);
        }
      }
      patches.push(p);
    }
  }
  if (!patches.length) return `No ${item.key} deposits on the open map.`;
  patches.sort((a, b) => a.dist - b.dist);
  const usable = sim.unlockedResources[item.id] ? '' : ` Note: the town cannot use ${item.key} yet, so miners cannot be placed on it.`;
  const lines = patches.slice(0, limit).map((p) =>
    `  ${p.tiles} tiles (${p.free} free), x ${p.x0 + min - HUB_X}..${p.x1 + min - HUB_X}, y ${p.y0 + min - HUB_Y}..${p.y1 + min - HUB_Y}, nearest tile to the hub ${at(p.nx + min, p.ny + min)}, ${p.dist} tiles away`);
  return `${item.key} deposits, nearest first (${patches.length} in total):${usable}\n${lines.join('\n')}\nPatches are ragged: use view_map to see exactly which tiles hold the deposit.`;
}

function inspect(sim: Sim, input: Record<string, unknown>): string {
  const x = int(input.x, 'x') + HUB_X;
  const y = int(input.y, 'y') + HUB_Y;
  if (!sim.world.hasTile(x, y)) return `${at(x, y)} is off the map.`;
  const slot = sim.world.buildingAt(x, y);
  const deposit = sim.world.depositAt(x, y);
  const ground = sim.world.terrainAt(x, y) !== TERRAIN_LAND ? 'water' : deposit ? `${itemKey(deposit)} deposit${sim.unlockedResources[deposit] ? '' : ' (not usable yet)'}` : 'open ground';
  if (slot < 0) return `${at(x, y)}: ${ground}, nothing built.`;
  const role = sim.role(slot);
  const extra = role === ROLE_HUB || role === ROLE_SPLITTER ? '' : ' ' + frontText(sim, slot);
  return `${at(x, y)}: ${ground}. ${describeBuilding(sim, slot)}.${extra}`;
}

function build(host: AgentHost, input: Record<string, unknown>): string {
  const sim = host.sim();
  const def = BUILDING_BY_KEY.get(String(input.building) as BuildingKey);
  if (!def || def.fixed) throw new ToolError(`Unknown building: ${String(input.building)}.`);
  const x = int(input.x, 'x') + HUB_X;
  const y = int(input.y, 'y') + HUB_Y;
  const dir = dirOf(input.dir);
  const error = sim.placeError(def.id, x, y);
  if (error) throw new ToolError(`Cannot build ${def.key} at ${at(x, y)}: ${error}`);
  let recipe = 0;
  if (input.recipe !== undefined) {
    const r = RECIPE_BY_KEY.get(String(input.recipe));
    if (!r) throw new ToolError(`Unknown recipe: ${String(input.recipe)}.`);
    if (r.building !== def.key) throw new ToolError(`${r.key} is made in a ${r.building}, not a ${def.key}.`);
    if (!sim.unlockedRecipes[r.id]) throw new ToolError(`The ${r.key} recipe is not unlocked yet.`);
    recipe = r.id;
  }
  const turned = sim.world.buildingAt(x, y) >= 0;
  sim.enqueue({ type: 'place', building: def.id, x, y, dir });
  if (recipe) sim.enqueue({ type: 'setRecipe', x, y, recipe });
  sim.applyQueued();
  host.focus?.(x, y);
  const slot = sim.world.buildingAt(x, y);
  const parts = [turned ? `Turned the belt at ${at(x, y)} to face ${DIRS[dir]}.` : `Built ${def.key} at ${at(x, y)} facing ${DIRS[dir]}.`];
  if (def.role === 'miner') parts.push(`It mines ${itemKey(sim.aux[slot])}, one every ${MINER_SECONDS}s.`);
  if (def.role === 'machine') parts.push(sim.recipe[slot] ? `Recipe ${RECIPE_BY_ID[sim.recipe[slot]]!.key}: ${recipeText(sim.recipe[slot])}.` : 'It has no recipe yet.');
  if (def.role !== 'splitter') parts.push(frontText(sim, slot));
  if (def.role === 'machine' && !hasFeeder(sim, slot)) parts.push('Nothing points into it yet.');
  parts.push(`Stock: ${stockText(sim)}.`);
  return parts.join(' ');
}

interface BeltTile { x: number; y: number; dir: number }

/** Places a run of belts, or nothing if any tile is invalid or the hub cannot pay for all of it. */
function layBelts(host: AgentHost, tiles: BeltTile[]): string {
  const sim = host.sim();
  const belt = BUILDING_BY_ID[BELT]!;
  let fresh = 0;
  for (const t of tiles) {
    const there = sim.world.buildingAt(t.x, t.y);
    if (there >= 0 && sim.isBelt(there)) continue;
    // Ask about the tile itself; affordability is checked for the whole run below.
    const error = sim.placeError(BELT, t.x, t.y);
    if (error && !error.startsWith('Not enough')) throw new ToolError(`Cannot lay belt at ${at(t.x, t.y)}: ${error} Nothing was placed.`);
    fresh++;
  }
  if (!sim.options.freeBuild) {
    for (const c of belt.cost) {
      const have = sim.stock[ITEM_BY_KEY.get(c.item)!.id];
      if (have < c.count * fresh) {
        throw new ToolError(`Not enough ${c.item} in the hub: ${fresh} belts need ${c.count * fresh}, the hub has ${have}. Nothing was placed.`);
      }
    }
  }
  for (const t of tiles) sim.enqueue({ type: 'place', building: BELT, x: t.x, y: t.y, dir: t.dir });
  sim.applyQueued();
  const last = tiles[tiles.length - 1];
  host.focus?.(last.x, last.y);
  const turned = tiles.length - fresh;
  const corners = tiles.filter((t, i) => i === 0 || i === tiles.length - 1 || tiles[i - 1].dir !== t.dir).map((t) => at(t.x, t.y)).join(' -> ');
  const end = sim.world.buildingAt(last.x, last.y);
  return `Laid ${fresh} belt${fresh === 1 ? '' : 's'}${turned ? ` and turned ${turned} existing` : ''}: ${corners}. The last belt at ${at(last.x, last.y)} faces ${DIRS[last.dir]}. ${frontText(sim, end)} Stock: ${stockText(sim)}.`;
}

function buildBelt(host: AgentHost, input: Record<string, unknown>): string {
  if (!Array.isArray(input.path) || input.path.length === 0) throw new ToolError('path must list at least one point.');
  const points = input.path.map((p, i) => pt(p, `path[${i}]`));
  const cells: { x: number; y: number }[] = [points[0]];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.x !== b.x && a.y !== b.y) throw new ToolError(`path[${i}] and path[${i + 1}] must share an x or a y.`);
    const sx = Math.sign(b.x - a.x);
    const sy = Math.sign(b.y - a.y);
    for (let x = a.x, y = a.y; x !== b.x || y !== b.y;) {
      x += sx;
      y += sy;
      cells.push({ x, y });
    }
  }
  const tiles: BeltTile[] = cells.map((c, i) => {
    const n = cells[i + 1];
    return { x: c.x, y: c.y, dir: n ? (n.x > c.x ? 0 : n.x < c.x ? 2 : n.y > c.y ? 1 : 3) : -1 };
  });
  const last = tiles[tiles.length - 1];
  if (input.end_dir !== undefined) last.dir = dirOf(input.end_dir, 'end_dir');
  else if (tiles.length > 1) last.dir = tiles[tiles.length - 2].dir;
  else throw new ToolError('A single-point path needs end_dir.');
  if (tiles.length > 400) throw new ToolError('That path is over 400 tiles. Build it in shorter pieces.');
  return layBelts(host, tiles);
}

/** Tiles a new belt must not sit on because some building already pushes its output there. */
function outputTiles(sim: Sim, except: number): Set<number> {
  const hot = new Set<number>();
  for (let s = 0; s < sim.count; s++) {
    if (!sim.kind[s] || s === except) continue;
    const role = sim.role(s);
    const d = sim.dir[s];
    const outs = role === ROLE_SPLITTER ? [d, (d + 1) & 3, (d + 3) & 3] : role === ROLE_BELT || role === ROLE_MINER || role === ROLE_MACHINE ? [d] : [];
    for (const o of outs) hot.add((sim.by[s] + DY[o]) * 65536 + sim.bx[s] + DX[o]);
  }
  return hot;
}

function connect(host: AgentHost, input: Record<string, unknown>): string {
  const sim = host.sim();
  const from = pt(input.from, 'from');
  const to = pt(input.to, 'to');
  const target = sim.world.buildingAt(to.x, to.y);
  if (target < 0) throw new ToolError(`There is no building at ${at(to.x, to.y)} to connect to.`);
  const targetRole = sim.role(target);
  if (targetRole === ROLE_MINER) throw new ToolError('A miner accepts nothing.');

  // Where the line starts and which way items are moving when they get there.
  const source = sim.world.buildingAt(from.x, from.y);
  let start = from;
  let startDir = -1;
  if (source >= 0) {
    const role = sim.role(source);
    if (role === ROLE_HUB) throw new ToolError('The hub has no output.');
    if (source === target) throw new ToolError('from and to are the same building.');
    startDir = sim.dir[source];
    if (role === ROLE_SPLITTER && input.out_dir !== undefined) {
      const want = dirOf(input.out_dir, 'out_dir');
      if (want === ((startDir + 2) & 3)) throw new ToolError('That is the splitter\'s input side.');
      startDir = want;
    }
    start = { x: sim.bx[source] + DX[startDir], y: sim.by[source] + DY[startDir] };
    const ahead = sim.world.buildingAt(start.x, start.y);
    if (ahead === target) return `The ${label(sim, source)} already faces the ${label(sim, target)}. No belt is needed.`;
    if (ahead >= 0) throw new ToolError(`The ${label(sim, source)} outputs to ${at(start.x, start.y)}, where there is already a ${nameOf(sim, ahead)}. Connect from the end of that line, or remove it.`);
  }

  // Tiles the last belt may sit on, and the direction it must face there.
  const goals = new Map<number, number>();
  const td = sim.dir[target];
  const half = (BUILDING_BY_ID[sim.kind[target]]?.size ?? 1) >> 1;
  const tx = sim.bx[target];
  const ty = sim.by[target];
  for (let oy = -half; oy <= half; oy++) {
    for (let ox = -half; ox <= half; ox++) {
      for (let side = 0; side < 4; side++) {
        const gx = tx + ox + DX[side];
        const gy = ty + oy + DY[side];
        if (sim.world.buildingAt(gx, gy) === target) continue;
        const into = (side + 2) & 3;
        if (targetRole === ROLE_BELT && side === td) continue;
        if (targetRole === ROLE_SPLITTER && side !== ((td + 2) & 3)) continue;
        if (targetRole === ROLE_MACHINE && side === td) continue;
        goals.set(gy * 65536 + gx, into);
      }
    }
  }

  const hot = outputTiles(sim, source);
  const open = (x: number, y: number): boolean =>
    sim.world.hasTile(x, y) && sim.world.terrainAt(x, y) === TERRAIN_LAND && sim.world.buildingAt(x, y) < 0 && !hot.has(y * 65536 + x);
  if (!sim.world.hasTile(start.x, start.y) || sim.world.terrainAt(start.x, start.y) !== TERRAIN_LAND || sim.world.buildingAt(start.x, start.y) >= 0) {
    throw new ToolError(`The line would start at ${at(start.x, start.y)}, which is not free ground.`);
  }

  // Shortest route with few turns, searched in a box around both ends.
  const margin = 24;
  const x0 = Math.max(sim.world.minTile, Math.min(start.x, tx - half) - margin);
  const y0 = Math.max(sim.world.minTile, Math.min(start.y, ty - half) - margin);
  const x1 = Math.min(sim.world.maxTile, Math.max(start.x, tx + half) + margin);
  const y1 = Math.min(sim.world.maxTile, Math.max(start.y, ty + half) + margin);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const best = new Int32Array(w * h * 4).fill(0x7fffffff);
  const prev = new Int32Array(w * h * 4).fill(-1);
  const heap: number[] = [];
  const push = (cost: number, state: number): void => {
    let i = heap.length;
    heap.push(cost, state);
    while (i > 0) {
      const parent = ((i >> 1) - 1 >> 1) << 1;
      if (heap[parent] <= heap[i]) break;
      [heap[parent], heap[i], heap[parent + 1], heap[i + 1]] = [heap[i], heap[parent], heap[i + 1], heap[parent + 1]];
      i = parent;
    }
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [heap[0], heap[1]];
    const state = heap.pop()!;
    const cost = heap.pop()!;
    if (heap.length) {
      heap[0] = cost;
      heap[1] = state;
      let i = 0;
      for (;;) {
        const l = i * 2 + 2;
        const r = l + 2;
        let m = i;
        if (l < heap.length && heap[l] < heap[m]) m = l;
        if (r < heap.length && heap[r] < heap[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i], heap[m + 1], heap[i + 1]] = [heap[i], heap[m], heap[i + 1], heap[m + 1]];
        i = m;
      }
    }
    return top;
  };
  const stateOf = (x: number, y: number, d: number): number => ((y - y0) * w + (x - x0)) * 4 + d;
  for (let d = 0; d < 4; d++) {
    if (startDir >= 0 && d !== startDir) continue;
    best[stateOf(start.x, start.y, d)] = 0;
    push(0, stateOf(start.x, start.y, d));
  }
  let end = -1;
  while (heap.length) {
    const [cost, state] = pop();
    if (cost > best[state]) continue;
    const d = state & 3;
    const tile = state >> 2;
    const x = (tile % w) + x0;
    const y = Math.floor(tile / w) + y0;
    if (goals.has(y * 65536 + x)) {
      end = state;
      break;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue;
      const nx = x + DX[nd];
      const ny = y + DY[nd];
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1 || !open(nx, ny)) continue;
      const step = 10 + (nd === d ? 0 : 3) + (sim.world.depositAt(nx, ny) ? 12 : 0);
      const next = stateOf(nx, ny, nd);
      if (cost + step < best[next]) {
        best[next] = cost + step;
        prev[next] = state;
        push(cost + step, next);
      }
    }
  }
  if (end < 0) {
    throw new ToolError(`No free route from ${at(start.x, start.y)} to the ${label(sim, target)}. Look at the area with view_map; something may need removing, or the target may have no free side.`);
  }
  const tiles: BeltTile[] = [];
  for (let state = end; state >= 0; state = prev[state]) {
    const tile = state >> 2;
    tiles.push({ x: (tile % w) + x0, y: Math.floor(tile / w) + y0, dir: 0 });
  }
  tiles.reverse();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const n = tiles[i + 1];
    t.dir = n ? (n.x > t.x ? 0 : n.x < t.x ? 2 : n.y > t.y ? 1 : 3) : goals.get(t.y * 65536 + t.x)!;
  }
  return layBelts(host, tiles);
}

function setRecipe(host: AgentHost, input: Record<string, unknown>): string {
  const sim = host.sim();
  const x = int(input.x, 'x') + HUB_X;
  const y = int(input.y, 'y') + HUB_Y;
  const slot = sim.world.buildingAt(x, y);
  if (slot < 0 || sim.role(slot) !== ROLE_MACHINE) throw new ToolError(`There is no machine at ${at(x, y)}.`);
  const r = RECIPE_BY_KEY.get(String(input.recipe));
  if (!r) throw new ToolError(`Unknown recipe: ${String(input.recipe)}.`);
  if (r.building !== nameOf(sim, slot)) throw new ToolError(`${r.key} is made in a ${r.building}, not a ${nameOf(sim, slot)}.`);
  if (!sim.unlockedRecipes[r.id]) throw new ToolError(`The ${r.key} recipe is not unlocked yet.`);
  sim.enqueue({ type: 'setRecipe', x, y, recipe: r.id });
  sim.applyQueued();
  host.focus?.(x, y);
  return `The ${label(sim, slot)} now makes ${r.key}: ${recipeText(r.id)}.`;
}

function remove(host: AgentHost, input: Record<string, unknown>): string {
  const sim = host.sim();
  const tiles: { x: number; y: number }[] = [];
  if (Array.isArray(input.tiles)) input.tiles.forEach((p, i) => tiles.push(pt(p, `tiles[${i}]`)));
  if (input.from !== undefined || input.to !== undefined) {
    const a = pt(input.from, 'from');
    const b = pt(input.to, 'to');
    if ((Math.abs(a.x - b.x) + 1) * (Math.abs(a.y - b.y) + 1) > 2500) throw new ToolError('That rectangle is too large.');
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) tiles.push({ x, y });
    }
  }
  if (!tiles.length) throw new ToolError('Give tiles, or from and to.');
  const removed = new Map<string, number>();
  let hub = false;
  for (const t of tiles) {
    const slot = sim.world.buildingAt(t.x, t.y);
    if (slot < 0) continue;
    if (sim.role(slot) === ROLE_HUB) {
      hub = true;
      continue;
    }
    const name = nameOf(sim, slot);
    sim.enqueue({ type: 'remove', x: t.x, y: t.y });
    sim.applyQueued();
    removed.set(name, (removed.get(name) ?? 0) + 1);
  }
  if (!removed.size) return `Nothing to remove there.${hub ? ' The hub cannot be removed.' : ''}`;
  host.focus?.(tiles[0].x, tiles[0].y);
  return `Removed ${[...removed].map(([name, n]) => `${n} ${name}`).join(', ')}. Stock: ${stockText(sim)}.`;
}

async function wait(host: AgentHost, input: Record<string, unknown>, cancelled: () => boolean): Promise<string> {
  const seconds = Math.max(1, Math.min(MAX_WAIT_SECONDS, int(input.seconds, 'seconds')));
  let sim = host.sim();
  const startTick = sim.tick;
  const startGoal = sim.goalIndex;
  const before = Uint32Array.from(sim.delivered);
  await host.advance(seconds * TICKS_PER_SECOND, () => cancelled() || host.sim().goalIndex !== startGoal);
  sim = host.sim();
  const waited = (sim.tick - startTick) / TICKS_PER_SECOND;
  const lines: string[] = [`Waited ${Math.round(waited)}s. Game time ${clock(sim.tick)}.`];
  const arrived = ITEMS.filter((i) => sim.delivered[i.id] > before[i.id]).map((i) => {
    const n = sim.delivered[i.id] - before[i.id];
    return `${i.key} +${n} (${(n / Math.max(waited, 1) * 60).toFixed(0)}/min)`;
  });
  lines.push(arrived.length ? `Delivered to the hub: ${arrived.join(', ')}.` : 'Nothing reached the hub.');
  for (let g = startGoal; g < sim.goalIndex; g++) {
    lines.push(`DELIVERY LIST COMPLETE: "${GOALS[g].title}". Unlocked: ${unlockText(g)}.`);
  }
  lines.push(goalText(sim));
  lines.push(`Stock: ${stockText(sim)}.`);
  const issues = problems(sim);
  if (issues.length) {
    lines.push('Problems:');
    for (const p of issues) lines.push(`  ${p}`);
  }
  return lines.join('\n');
}

/** Runs one tool call. Throws ToolError for anything the agent should be told about and can fix. */
export async function runTool(host: AgentHost, name: string, input: unknown, cancelled: () => boolean = () => false): Promise<string> {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'get_state': return getState(host.sim());
    case 'view_map': return viewMap(host.sim(), args);
    case 'find_deposits': return findDeposits(host.sim(), args);
    case 'inspect': return inspect(host.sim(), args);
    case 'build': return build(host, args);
    case 'build_belt': return buildBelt(host, args);
    case 'connect': return connect(host, args);
    case 'set_recipe': return setRecipe(host, args);
    case 'remove': return remove(host, args);
    case 'wait': return wait(host, args, cancelled);
    default: throw new ToolError(`Unknown tool: ${name}.`);
  }
}

/** A host that runs a simulation as fast as it will go. For tests and the command line. */
export function headlessHost(sim: Sim): AgentHost {
  return {
    sim: () => sim,
    advance: async (ticks, shouldStop) => {
      for (let i = 0; i < ticks && !shouldStop(); i++) sim.step();
    },
  };
}
