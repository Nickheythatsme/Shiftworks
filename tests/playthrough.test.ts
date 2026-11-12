import { describe, expect, it } from 'vitest';
import { GOALS, TICKS_PER_SECOND, buildingId, recipeId } from '../src/content/content';
import { HUB_X, HUB_Y, Sim } from '../src/sim';
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

describe('a full playthrough', () => {
  it('reaches the last unlock with one line per product', () => {
    const sim = new Sim({ seed: 9, worldType: 'test' });
    // The bus: two belts along one row that meet above the hub and run down into it.
    belts(sim, HUB_X - 70, BUS_Y, EAST, 70);
    belts(sim, HUB_X + 70, BUS_Y, WEST, 70);
    belts(sim, HUB_X, BUS_Y, SOUTH, 19);

    const row = HUB_Y - 40;
    const done = new Set<string>();
    const once = (key: string, ready: boolean, build: () => void) => {
      if (ready && !done.has(key)) {
        done.add(key);
        build();
      }
    };
    const unlockedB = (key: Parameters<typeof buildingId>[0]) => sim.unlockedBuildings[buildingId(key)] === 1;
    const unlockedR = (key: string) => sim.unlockedRecipes[recipeId(key)] === 1;

    const limit = TICKS_PER_SECOND * 60 * 60;
    while (sim.goalIndex < GOALS.length && sim.tick < limit) {
      once('timber', true, () => line(sim, HUB_X - 62, row));
      once('planks', unlockedB('sawmill'), () => line(sim, HUB_X - 60, row, SAWMILL));
      once('kiln', unlockedB('kiln'), () => {
        line(sim, HUB_X - 46, row, KILN, 'bricks');
        line(sim, HUB_X - 30, row, KILN, 'iron_plate');
      });
      once('tools', unlockedB('assembler'), () =>
        assemblerUnit(sim, row - 8, { x: HUB_X - 24, machine: KILN, recipe: 'iron_plate' }, { x: HUB_X - 54, machine: SAWMILL }, 'tools'));
      once('fasteners', unlockedR('fasteners'), () => {
        assemblerUnit(sim, row - 16, { x: HUB_X - 18, machine: KILN, recipe: 'iron_plate' }, { x: HUB_X + 2 }, 'fasteners');
        line(sim, HUB_X - 58, row, KILN, 'charcoal');
      });
      once('wire', unlockedR('copper_wire'), () =>
        assemblerUnit(sim, row - 24, { x: HUB_X + 64 }, { x: HUB_X + 30, machine: KILN, recipe: 'charcoal' }, 'copper_wire'));
      sim.step();
    }

    const minutes = sim.tick / TICKS_PER_SECOND / 60;
    console.log(`Full arc with a minimal factory: ${minutes.toFixed(1)} minutes of game time`);
    expect(sim.goalIndex).toBe(GOALS.length);
    expect(sim.events.at(-1)).toEqual({ type: 'won' });
    expect(done.size).toBe(6);
  });
});
