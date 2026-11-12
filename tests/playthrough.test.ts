import { describe, expect, it } from 'vitest';
import { BUILDING_BY_ID, GOALS, TECHS, TICKS_PER_SECOND, buildingId, itemId, recipeId, type BuildingKey } from '../src/content/content';
import { HUB_X, HUB_Y, ROLE_MACHINE, ROLE_MINER, Sim, type Command } from '../src/sim';
import { ASSEMBLER, BELT, EAST, KILN, MINER, NORTH, SAWMILL, SOUTH, WEST, belts, place } from './helpers';

// Plays the whole arc on the test map, building each line as soon as the town
// unlocks it and the hub can pay for it. This proves every delivery list and
// every rate gate can be passed with what is unlocked at that point, and
// reports how long the arc takes and how big the factory has to be.
//
// Four shared belts run into the hub, one into each corner of its north and
// south sides, so no single belt has to carry more than it can.

const NORTH_BUS = HUB_Y - 20;
const SOUTH_BUS = HUB_Y + 20;
/** Deposit rows: lines north of the hub run south to the bus, and the other way round. */
const NORTH_ROW = HUB_Y - 40;
const SOUTH_ROW = HUB_Y + 40;

/** miner -> optional machine -> belt to the bus. `toward` is +1 for a line that runs south, -1 north. */
function line(sim: Sim, x: number, row: number, toward: 1 | -1, machine = 0, recipe = ''): void {
  const dir = toward > 0 ? SOUTH : NORTH;
  const bus = toward > 0 ? NORTH_BUS : SOUTH_BUS;
  place(sim, MINER, x, row, dir);
  let y = row + toward;
  if (machine) {
    place(sim, machine, x, y, dir);
    if (recipe) sim.enqueue({ type: 'setRecipe', x, y, recipe: recipeId(recipe) });
    y += toward;
  }
  belts(sim, x, y, dir, Math.abs(bus - y));
}

interface Source { x: number; machine?: number; recipe?: string }

/** Two sources meet at an assembler under source `a`; its output runs south to the north bus. */
function assemblerUnit(sim: Sim, row: number, a: Source, b: Source, recipe: string): void {
  for (const s of [a, b]) {
    place(sim, MINER, s.x, row, SOUTH);
    if (s.machine) {
      place(sim, s.machine, s.x, row + 1, SOUTH);
      if (s.recipe) sim.enqueue({ type: 'setRecipe', x: s.x, y: row + 1, recipe: recipeId(s.recipe) });
    } else {
      place(sim, BELT, s.x, row + 1, SOUTH);
    }
    belts(sim, s.x, row + 2, SOUTH, 2);
  }
  place(sim, ASSEMBLER, a.x, row + 4, SOUTH);
  sim.enqueue({ type: 'setRecipe', x: a.x, y: row + 4, recipe: recipeId(recipe) });
  if (b.x < a.x) belts(sim, b.x, row + 4, EAST, a.x - b.x);
  else belts(sim, b.x, row + 4, WEST, b.x - a.x);
  belts(sim, a.x, row + 5, SOUTH, NORTH_BUS - (row + 5));
}

/** Collects the commands a build step would issue, so its cost can be checked first. */
function plan(build: (recorder: Sim) => void): Command[] {
  const commands: Command[] = [];
  build({ enqueue: (c: Command) => commands.push(c) } as unknown as Sim);
  return commands;
}

function costOf(commands: Command[]): Map<number, number> {
  const total = new Map<number, number>();
  for (const c of commands) {
    if (c.type !== 'place') continue;
    for (const part of BUILDING_BY_ID[c.building]!.cost) {
      const id = itemId(part.item);
      total.set(id, (total.get(id) ?? 0) + part.count);
    }
  }
  return total;
}

describe('a full playthrough', () => {
  it('passes every gate, paying for every building and tech from deliveries', () => {
    const sim = new Sim({ seed: 9, worldType: 'test' });
    const unlockedB = (key: BuildingKey) => sim.unlockedBuildings[buildingId(key)] === 1;
    const unlockedR = (key: string) => sim.unlockedRecipes[recipeId(key)] === 1;

    // The test map puts deposits 40 tiles from the hub, far further than a real
    // map does, so the long shared belts into the hub are granted up front.
    // Everything else is paid for out of the starting materials and deliveries.
    const bus = plan((r) => {
      for (const [y, into] of [[NORTH_BUS, SOUTH], [SOUTH_BUS, NORTH]] as const) {
        belts(r, HUB_X - 70, y, EAST, 69);
        belts(r, HUB_X - 1, y, into, 19);
        belts(r, HUB_X + 80, y, WEST, 79);
        belts(r, HUB_X + 1, y, into, 19);
      }
    });
    for (const [item, count] of costOf(bus)) sim.stock[item] += count;
    for (const c of bus) sim.enqueue(c);

    // Columns by resource band on the test map, as offsets from the hub:
    // west of it timber -64, stone -48, iron -32, coal 0; east of it timber 16,
    // iron 48, copper 64. An assembler unit further north always has its
    // output column outside the units south of it.
    interface Step { name: string; ready: () => boolean; commands: Command[] }
    const steps: Step[] = [];
    const add = (name: string, ready: () => boolean, build: (r: Sim) => void) => steps.push({ name, ready, commands: plan(build) });
    const unitRow = (k: number) => NORTH_ROW - 8 * (k + 1);

    add('timber', () => true, (r) => line(r, HUB_X - 64, NORTH_ROW, 1));
    add('stone', () => true, (r) => line(r, HUB_X - 48, NORTH_ROW, 1));
    add('timber 2', () => true, (r) => line(r, HUB_X - 63, NORTH_ROW, 1));
    add('timber 3', () => true, (r) => line(r, HUB_X - 62, NORTH_ROW, 1));
    add('planks', () => unlockedB('sawmill'), (r) => line(r, HUB_X - 64, SOUTH_ROW, -1, SAWMILL));
    add('bricks', () => unlockedB('kiln'), (r) => line(r, HUB_X - 48, SOUTH_ROW, -1, KILN, 'bricks'));
    add('iron plate', () => unlockedB('kiln'), (r) => line(r, HUB_X + 48, SOUTH_ROW, -1, KILN, 'iron_plate'));
    // The camp gate asks for 100 a minute of each: three sawmills and four kilns apiece.
    for (let k = 1; k < 3; k++) add(`planks ${k + 1}`, () => unlockedB('kiln'), (r) => line(r, HUB_X - 64 + k, SOUTH_ROW, -1, SAWMILL));
    for (let k = 1; k < 4; k++) {
      add(`bricks ${k + 1}`, () => unlockedB('kiln'), (r) => line(r, HUB_X - 48 + k, SOUTH_ROW, -1, KILN, 'bricks'));
      add(`iron plate ${k + 1}`, () => unlockedB('kiln'), (r) => line(r, HUB_X + 48 + k, SOUTH_ROW, -1, KILN, 'iron_plate'));
    }
    // The hamlet gate asks for 100 a minute of each: six tools assemblers, three of the others.
    for (let k = 0; k < 6; k++) {
      add(`tools ${k + 1}`, () => unlockedB('assembler'), (r) =>
        assemblerUnit(r, unitRow(k), { x: HUB_X - 32 + k, machine: KILN, recipe: 'iron_plate' }, { x: HUB_X - 60 + k, machine: SAWMILL }, 'tools'));
    }
    add('charcoal', () => unlockedR('charcoal'), (r) => line(r, HUB_X + 20, SOUTH_ROW, -1, KILN, 'charcoal'));
    add('charcoal 2', () => unlockedR('charcoal'), (r) => line(r, HUB_X + 21, SOUTH_ROW, -1, KILN, 'charcoal'));
    for (let k = 0; k < 3; k++) {
      add(`fasteners ${k + 1}`, () => unlockedR('fasteners'), (r) =>
        assemblerUnit(r, unitRow(6 + k), { x: HUB_X + 2 + k }, { x: HUB_X - 20 + k, machine: KILN, recipe: 'iron_plate' }, 'fasteners'));
    }
    for (let k = 0; k < 3; k++) {
      add(`copper wire ${k + 1}`, () => unlockedR('copper_wire'), (r) =>
        assemblerUnit(r, unitRow(k), { x: HUB_X + 64 + k }, { x: HUB_X + 20 + k, machine: KILN, recipe: 'charcoal' }, 'copper_wire'));
    }

    let next = 0;
    const passedAt: string[] = [];
    const learnedAt: string[] = [];
    let buying = 0;
    const limit = TICKS_PER_SECOND * 60 * 240;
    while (sim.goalIndex < GOALS.length && sim.tick < limit) {
      // The town learns each thing as soon as the hub can pay for it.
      if (sim.tick % TICKS_PER_SECOND === 0) {
        for (const t of TECHS) {
          if (sim.techError(t.id) === null) {
            sim.enqueue({ type: 'research', tech: t.id });
            buying = t.id;
            break;
          }
        }
      }
      const step = steps[next];
      if (step && step.ready()) {
        let affordable = true;
        for (const [item, count] of costOf(step.commands)) if (sim.stock[item] < count) affordable = false;
        if (affordable) {
          for (const c of step.commands) sim.enqueue(c);
          next++;
        }
      }
      const before = sim.goalIndex;
      sim.step();
      if (buying && sim.researched[buying]) learnedAt.push(`${TECHS.find((t) => t.id === buying)!.key} ${(sim.tick / TICKS_PER_SECOND / 60).toFixed(1)}m`);
      buying = 0;
      if (sim.goalIndex !== before) passedAt.push(`${GOALS[before].key} ${(sim.tick / TICKS_PER_SECOND / 60).toFixed(1)}m`);
    }

    let machines = 0;
    for (let s = 0; s < sim.count; s++) if (sim.role(s) === ROLE_MINER || sim.role(s) === ROLE_MACHINE) machines++;
    const minutes = sim.tick / TICKS_PER_SECOND / 60;
    console.log(`Full arc: ${minutes.toFixed(1)} minutes of game time, ${machines} miners and machines`);
    console.log(`Passed at: ${passedAt.join(', ')}`);
    console.log(`Learned at: ${learnedAt.join(', ')}`);
    expect(learnedAt.length).toBe(TECHS.length);
    expect(sim.goalIndex).toBe(GOALS.length);
    expect(sim.events.at(-1)).toEqual({ type: 'won' });
    expect(next).toBe(steps.length);
    // Every placement in the plan landed: nothing was refused for lack of materials.
    let placed = 0;
    for (const c of [...bus, ...steps.flatMap((s) => s.commands)]) if (c.type === 'place') placed++;
    expect(sim.count - sim.freeCount - 1).toBe(placed);
  });
});
