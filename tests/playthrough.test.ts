import { describe, expect, it } from 'vitest';
import { BUILDING_BY_ID, GOALS, TICKS_PER_SECOND, buildingId, itemId, recipeId, type BuildingKey } from '../src/content/content';
import { HUB_X, HUB_Y, Sim, type Command } from '../src/sim';
import { ASSEMBLER, BELT, EAST, KILN, MINER, SAWMILL, SOUTH, WEST, belts, place } from './helpers';

// Plays the whole arc on the test map with one small line per product, building
// each line as soon as the town unlocks it. This proves every delivery list can
// be completed with what is unlocked at that point, and reports how long a
// minimal factory takes.

const BUS_Y = HUB_Y - 20;

/** miner -> optional machine -> belt south to the bus. */
function line(sim: Sim, x: number, row: number, machine = 0, recipe = ''): void {
  place(sim, MINER, x, row, SOUTH);
  if (machine) {
    place(sim, machine, x, row + 1, SOUTH);
    if (recipe) sim.enqueue({ type: 'setRecipe', x, y: row + 1, recipe: recipeId(recipe) });
    belts(sim, x, row + 2, SOUTH, BUS_Y - (row + 2));
  } else {
    belts(sim, x, row + 1, SOUTH, BUS_Y - (row + 1));
  }
}

interface Source { x: number; machine?: number; recipe?: string }

/** Two sources meet at an assembler under source `a`; its output runs south to the bus. */
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
  belts(sim, a.x, row + 5, SOUTH, BUS_Y - (row + 5));
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
  it('reaches the last unlock paying for every building from deliveries', () => {
    const sim = new Sim({ seed: 9, worldType: 'test' });
    const row = HUB_Y - 40;
    const unlockedB = (key: BuildingKey) => sim.unlockedBuildings[buildingId(key)] === 1;
    const unlockedR = (key: string) => sim.unlockedRecipes[recipeId(key)] === 1;

    // The test map puts deposits 40 tiles from the hub, far further than a real
    // map does, so the long shared belt into the hub is granted up front.
    // Everything else is paid for out of the starting materials and deliveries.
    const bus = plan((r) => {
      belts(r, HUB_X - 70, BUS_Y, EAST, 70);
      belts(r, HUB_X + 70, BUS_Y, WEST, 70);
      belts(r, HUB_X, BUS_Y, SOUTH, 19);
    });
    for (const [item, count] of costOf(bus)) sim.stock[item] += count;
    for (const c of bus) sim.enqueue(c);

    // Built in this order, each as soon as it is unlocked and affordable.
    const steps: { name: string; ready: () => boolean; commands: Command[] }[] = [
      { name: 'timber', ready: () => true, commands: plan((r) => line(r, HUB_X - 62, row)) },
      { name: 'stone', ready: () => true, commands: plan((r) => line(r, HUB_X - 44, row)) },
      { name: 'planks', ready: () => unlockedB('sawmill'), commands: plan((r) => line(r, HUB_X - 60, row, SAWMILL)) },
      { name: 'bricks', ready: () => unlockedB('kiln'), commands: plan((r) => line(r, HUB_X - 46, row, KILN, 'bricks')) },
      { name: 'iron plate', ready: () => unlockedB('kiln'), commands: plan((r) => line(r, HUB_X - 30, row, KILN, 'iron_plate')) },
      {
        name: 'tools', ready: () => unlockedB('assembler'),
        commands: plan((r) => assemblerUnit(r, row - 8, { x: HUB_X - 24, machine: KILN, recipe: 'iron_plate' }, { x: HUB_X - 54, machine: SAWMILL }, 'tools')),
      },
      { name: 'charcoal', ready: () => unlockedR('charcoal'), commands: plan((r) => line(r, HUB_X - 58, row, KILN, 'charcoal')) },
      {
        name: 'fasteners', ready: () => unlockedR('fasteners'),
        commands: plan((r) => assemblerUnit(r, row - 16, { x: HUB_X - 18, machine: KILN, recipe: 'iron_plate' }, { x: HUB_X + 2 }, 'fasteners')),
      },
      {
        name: 'copper wire', ready: () => unlockedR('copper_wire'),
        commands: plan((r) => assemblerUnit(r, row - 24, { x: HUB_X + 64 }, { x: HUB_X + 30, machine: KILN, recipe: 'charcoal' }, 'copper_wire')),
      },
    ];

    let next = 0;
    const builtAt: string[] = [];
    const limit = TICKS_PER_SECOND * 60 * 90;
    while (sim.goalIndex < GOALS.length && sim.tick < limit) {
      const step = steps[next];
      if (step && step.ready()) {
        let affordable = true;
        for (const [item, count] of costOf(step.commands)) if (sim.stock[item] < count) affordable = false;
        if (affordable) {
          for (const c of step.commands) sim.enqueue(c);
          builtAt.push(`${step.name} ${(sim.tick / TICKS_PER_SECOND / 60).toFixed(1)}m`);
          next++;
        }
      }
      sim.step();
    }

    const minutes = sim.tick / TICKS_PER_SECOND / 60;
    console.log(`Full arc with a minimal factory: ${minutes.toFixed(1)} minutes of game time`);
    console.log(`Built at: ${builtAt.join(', ')}`);
    expect(sim.goalIndex).toBe(GOALS.length);
    expect(sim.events.at(-1)).toEqual({ type: 'won' });
    expect(next).toBe(steps.length);
    // Every placement in the plan landed: nothing was refused for lack of materials.
    let placed = 0;
    for (const c of [...bus, ...steps.flatMap((s) => s.commands)]) if (c.type === 'place') placed++;
    expect(sim.count - sim.freeCount - 1).toBe(placed);
  });
});
