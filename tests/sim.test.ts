import { describe, expect, it } from 'vitest';
import { GOALS, RATE_WINDOW_SECONDS, itemId, recipeId, buildingId } from '../src/content/content';
import { HUB_X, HUB_Y, SAVE_VERSION, STATUS_BLOCKED, STATUS_STARVED, Sim, loadSim, saveSim } from '../src/sim';
import { buildBenchFactory } from '../src/tools/benchFactory';
import {
  ASSEMBLER, BELT, COAL_X, EAST, IRON_X, KILN, MINER, NORTH, ROW, SAWMILL, SOUTH, SPLITTER, STONE_X, TIMBER_X, WEST,
  belts, place, run, slotAt, testSim,
} from './helpers';

const TIMBER = itemId('timber');
const IRON_ORE = itemId('iron_ore');
const IRON_PLATE = itemId('iron_plate');
const PLANKS = itemId('planks');

describe('placing and removing', () => {
  it('places a building and removes it again', () => {
    const sim = testSim();
    place(sim, BELT, TIMBER_X, ROW + 1, EAST);
    run(sim, 1);
    expect(slotAt(sim, TIMBER_X, ROW + 1)).toBeGreaterThanOrEqual(0);
    sim.enqueue({ type: 'remove', x: TIMBER_X, y: ROW + 1 });
    run(sim, 1);
    expect(slotAt(sim, TIMBER_X, ROW + 1)).toBe(-1);
  });

  it('refuses a miner off a deposit, a build on an occupied tile, and removing the hub', () => {
    const sim = testSim();
    expect(sim.placeError(MINER, TIMBER_X, ROW + 1)).toMatch(/deposit/);
    place(sim, KILN, TIMBER_X, ROW + 1, EAST);
    run(sim, 1);
    expect(sim.placeError(KILN, TIMBER_X, ROW + 1)).toMatch(/already/);
    sim.enqueue({ type: 'remove', x: HUB_X, y: HUB_Y });
    run(sim, 1);
    expect(slotAt(sim, HUB_X + 1, HUB_Y - 1)).toBe(0);
  });

  it('refuses locked buildings and water in a normal game', () => {
    const sim = new Sim({ seed: 7 });
    expect(sim.placeError(KILN, HUB_X + 5, HUB_Y)).toMatch(/not unlocked/);
    expect(sim.placeError(BELT, HUB_X + 5, HUB_Y)).toBeNull();
    let water: [number, number] | null = null;
    for (let x = sim.world.minTile; x <= sim.world.maxTile && !water; x++) {
      if (sim.world.terrainAt(x, HUB_Y + 60) === 1) water = [x, HUB_Y + 60];
      else if (sim.world.terrainAt(x, HUB_Y - 60) === 1) water = [x, HUB_Y - 60];
    }
    expect(water).not.toBeNull();
    expect(sim.placeError(BELT, water![0], water![1])).toMatch(/water/);
  });

  it('reuses the most recently freed slot and bumps its generation', () => {
    const sim = testSim();
    place(sim, BELT, TIMBER_X, ROW + 1, EAST);
    place(sim, BELT, TIMBER_X + 1, ROW + 1, EAST);
    run(sim, 1);
    const slot = slotAt(sim, TIMBER_X + 1, ROW + 1);
    const gen = sim.gen[slot];
    sim.enqueue({ type: 'remove', x: TIMBER_X + 1, y: ROW + 1 });
    place(sim, KILN, TIMBER_X + 5, ROW + 1, EAST);
    run(sim, 1);
    expect(slotAt(sim, TIMBER_X + 5, ROW + 1)).toBe(slot);
    expect(sim.gen[slot]).toBe(gen + 1);
  });

  it('turns an existing belt when a belt is laid over it', () => {
    const sim = testSim();
    place(sim, BELT, TIMBER_X, ROW + 1, EAST);
    run(sim, 1);
    place(sim, BELT, TIMBER_X, ROW + 1, SOUTH);
    run(sim, 1);
    expect(sim.dir[slotAt(sim, TIMBER_X, ROW + 1)]).toBe(SOUTH);
    expect(sim.count).toBe(2); // hub + one belt
  });
});

describe('belts and miners', () => {
  it('carries mined items to the hub without losing or duplicating any', () => {
    const sim = testSim();
    // Miner faces south into a belt that runs to the hub's top edge.
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    belts(sim, TIMBER_X, ROW + 1, SOUTH, 5);
    belts(sim, TIMBER_X, ROW + 6, EAST, HUB_X - TIMBER_X);
    belts(sim, HUB_X, ROW + 6, SOUTH, HUB_Y - 2 - (ROW + 6) + 1);
    for (let i = 0; i < 40; i++) {
      run(sim, 250);
      const miner = slotAt(sim, TIMBER_X, ROW);
      const held = sim.countBeltItems() + sim.out[miner] + sim.delivered[TIMBER];
      expect(held).toBe(sim.totalMined);
    }
    expect(sim.delivered[TIMBER]).toBeGreaterThan(100);
  });

  it('queues items on a blocked belt, four to a tile, and blocks the miner', () => {
    const sim = testSim();
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    belts(sim, TIMBER_X, ROW + 1, SOUTH, 3);
    run(sim, 3000);
    expect(sim.countBeltItems()).toBe(12);
    expect(sim.status[slotAt(sim, TIMBER_X, ROW)]).toBe(STATUS_BLOCKED);
    const before = sim.totalMined;
    run(sim, 600);
    expect(sim.totalMined).toBe(before);
  });

  it('merges a side belt into a main belt', () => {
    const sim = testSim();
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    place(sim, MINER, TIMBER_X + 2, ROW, SOUTH);
    belts(sim, TIMBER_X, ROW + 1, SOUTH, 2);
    belts(sim, TIMBER_X + 2, ROW + 1, SOUTH, 2);
    // The second line turns west and joins the first from the side.
    belts(sim, TIMBER_X + 2, ROW + 3, WEST, 2);
    belts(sim, TIMBER_X, ROW + 3, SOUTH, 4);
    run(sim, 4000);
    // Everything backs up; both miners contributed and nothing vanished.
    const m1 = slotAt(sim, TIMBER_X, ROW);
    const m2 = slotAt(sim, TIMBER_X + 2, ROW);
    expect(sim.countBeltItems() + sim.out[m1] + sim.out[m2]).toBe(sim.totalMined);
    expect(sim.countBeltItems()).toBe(10 * 4);
  });

  it('shares items between the outputs of a splitter', () => {
    const sim = testSim();
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    belts(sim, TIMBER_X, ROW + 1, SOUTH, 2);
    place(sim, SPLITTER, TIMBER_X, ROW + 3, SOUTH);
    belts(sim, TIMBER_X, ROW + 4, SOUTH, 3); // front
    belts(sim, TIMBER_X - 1, ROW + 3, WEST, 3); // the splitter's right when facing south
    belts(sim, TIMBER_X + 1, ROW + 3, EAST, 3); // left
    run(sim, 30 * 20);
    const count = (x: number, y: number, dx: number, dy: number) => {
      let n = 0;
      for (let i = 0; i < 3; i++) {
        const s = slotAt(sim, x + dx * i, y + dy * i);
        for (let k = 0; k < 4; k++) if (sim.slots[s * 4 + k]) n++;
      }
      return n;
    };
    const front = count(TIMBER_X, ROW + 4, 0, 1);
    const right = count(TIMBER_X - 1, ROW + 3, -1, 0);
    const left = count(TIMBER_X + 1, ROW + 3, 1, 0);
    expect(front).toBeGreaterThan(0);
    expect(Math.abs(front - right)).toBeLessThanOrEqual(1);
    expect(Math.abs(front - left)).toBeLessThanOrEqual(1);
  });

  it('passes nothing between two belts that face each other', () => {
    const sim = testSim();
    place(sim, MINER, TIMBER_X, ROW, EAST);
    place(sim, BELT, TIMBER_X + 1, ROW, EAST);
    place(sim, BELT, TIMBER_X + 2, ROW, WEST);
    run(sim, 2000);
    const facing = slotAt(sim, TIMBER_X + 2, ROW);
    expect(sim.slots[facing * 4]).toBe(0);
  });

  it('keeps a loop of belts from losing items', () => {
    const sim = testSim();
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    place(sim, BELT, TIMBER_X, ROW + 1, SOUTH);
    // A 2 by 2 loop fed from the top.
    place(sim, BELT, TIMBER_X, ROW + 2, EAST);
    place(sim, BELT, TIMBER_X + 1, ROW + 2, SOUTH);
    place(sim, BELT, TIMBER_X + 1, ROW + 3, WEST);
    place(sim, BELT, TIMBER_X, ROW + 3, NORTH);
    run(sim, 5000);
    const miner = slotAt(sim, TIMBER_X, ROW);
    expect(sim.countBeltItems() + sim.out[miner]).toBe(sim.totalMined);
  });
});

describe('machines', () => {
  it('turns ore into plate in a kiln and delivers it', () => {
    const sim = testSim();
    place(sim, MINER, IRON_X, ROW, SOUTH);
    place(sim, BELT, IRON_X, ROW + 1, SOUTH);
    place(sim, KILN, IRON_X, ROW + 2, SOUTH);
    sim.enqueue({ type: 'setRecipe', x: IRON_X, y: ROW + 2, recipe: recipeId('iron_plate') });
    belts(sim, IRON_X, ROW + 3, SOUTH, 3);
    run(sim, 30 * 30);
    let plates = 0;
    for (let i = 0; i < 3; i++) {
      const s = slotAt(sim, IRON_X, ROW + 3 + i);
      for (let k = 0; k < 4; k++) if (sim.slots[s * 4 + k] === IRON_PLATE) plates++;
    }
    expect(plates).toBeGreaterThan(5);
  });

  it('reports a machine with no inputs as starved and one with no room as blocked', () => {
    const sim = testSim();
    place(sim, KILN, STONE_X, ROW + 2, SOUTH);
    run(sim, 10);
    expect(sim.status[slotAt(sim, STONE_X, ROW + 2)]).toBe(STATUS_STARVED);
    place(sim, MINER, IRON_X, ROW, SOUTH);
    place(sim, KILN, IRON_X, ROW + 1, SOUTH);
    sim.enqueue({ type: 'setRecipe', x: IRON_X, y: ROW + 1, recipe: recipeId('iron_plate') });
    run(sim, 30 * 60);
    expect(sim.status[slotAt(sim, IRON_X, ROW + 1)]).toBe(STATUS_BLOCKED);
  });

  it('combines two inputs in an assembler', () => {
    const sim = testSim();
    const y = ROW + 4;
    // Iron: miner -> kiln -> belt east along row y.
    place(sim, MINER, IRON_X, ROW, SOUTH);
    place(sim, KILN, IRON_X, ROW + 1, SOUTH);
    sim.enqueue({ type: 'setRecipe', x: IRON_X, y: ROW + 1, recipe: recipeId('iron_plate') });
    belts(sim, IRON_X, ROW + 2, SOUTH, 2);
    place(sim, ASSEMBLER, IRON_X, y, SOUTH);
    sim.enqueue({ type: 'setRecipe', x: IRON_X, y, recipe: recipeId('tools') });
    // Timber: miner -> sawmill -> belt east to the assembler's west side.
    place(sim, MINER, TIMBER_X + 15, ROW, SOUTH);
    place(sim, SAWMILL, TIMBER_X + 15, ROW + 1, SOUTH);
    belts(sim, TIMBER_X + 15, ROW + 2, SOUTH, 2);
    belts(sim, TIMBER_X + 15, y, EAST, IRON_X - (TIMBER_X + 15));
    belts(sim, IRON_X, y + 1, SOUTH, 4);
    run(sim, 30 * 90);
    let tools = 0;
    for (let i = 0; i < 4; i++) {
      const s = slotAt(sim, IRON_X, y + 1 + i);
      for (let k = 0; k < 4; k++) if (sim.slots[s * 4 + k] === itemId('tools')) tools++;
    }
    expect(tools).toBeGreaterThan(3);
  });

  it('refuses a recipe that belongs to another machine', () => {
    const sim = testSim();
    place(sim, KILN, STONE_X, ROW + 2, SOUTH);
    run(sim, 1);
    const slot = slotAt(sim, STONE_X, ROW + 2);
    const before = sim.recipe[slot];
    sim.enqueue({ type: 'setRecipe', x: STONE_X, y: ROW + 2, recipe: recipeId('tools') });
    run(sim, 1);
    expect(sim.recipe[slot]).toBe(before);
  });
});

/** Fills in everything the current list asks for, so the next town step completes it. */
function passCurrentList(sim: Sim): void {
  const goal = GOALS[sim.goalIndex];
  for (const need of goal.needs) sim.goalProgress[itemId(need.item)] = need.count;
  sim.gateHeld = goal.holdSeconds ?? 0;
}

/** Makes the hub look as if it had received `perSecond` of an item in each of the last 60 seconds. */
function fakeRate(sim: Sim, item: number, perSecond: number): void {
  sim.rateBuckets.fill(perSecond, item * RATE_WINDOW_SECONDS, (item + 1) * RATE_WINDOW_SECONDS);
}

describe('rate gates', () => {
  const gate = GOALS.findIndex((g) => g.rates);

  it('measures what the hub received over the last minute', () => {
    const sim = testSim();
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    belts(sim, TIMBER_X, ROW + 1, SOUTH, 5);
    belts(sim, TIMBER_X, ROW + 6, EAST, HUB_X - TIMBER_X);
    belts(sim, HUB_X, ROW + 6, SOUTH, HUB_Y - 2 - (ROW + 6) + 1);
    run(sim, 30 * 200);
    // One miner extracts an item every 1.5 seconds.
    expect(sim.rate[TIMBER]).toBe(40);
    expect(sim.rate[itemId('stone')]).toBe(0);
  });

  it('cannot be passed by waiting with a factory that is too small', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    sim.goalIndex = gate;
    // Every good arrives, but at half the rate the gate asks for.
    for (let second = 0; second < 600; second++) {
      for (const r of GOALS[gate].rates!) fakeRate(sim, itemId(r.item), 1);
      run(sim, 30);
    }
    expect(sim.gateHeld).toBe(0);
    expect(sim.goalIndex).toBe(gate);
  });

  it('counts only while every rate is met, pauses when one drops, and never resets', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    sim.goalIndex = gate;
    const items = GOALS[gate].rates!.map((r) => itemId(r.item));
    const hold = GOALS[gate].holdSeconds!;
    const second = (rates: number[]) => {
      items.forEach((item, i) => fakeRate(sim, item, rates[i]));
      run(sim, 30);
    };
    for (let i = 0; i < 10; i++) second([2, 2, 2]);
    expect(sim.gateHeld).toBe(10);
    expect(sim.gateRatesMet()).toBe(true);
    for (let i = 0; i < 20; i++) second([2, 2, 1]);
    expect(sim.gateHeld).toBe(10);
    expect(sim.gateRatesMet()).toBe(false);
    for (let i = 0; i < hold - 11; i++) second([2, 2, 2]);
    expect(sim.goalIndex).toBe(gate);
    second([2, 2, 2]);
    expect(sim.goalIndex).toBe(gate + 1);
    expect(sim.gateHeld).toBe(0);
  });
});

describe('the town', () => {
  it('completes a delivery list and unlocks the next step', () => {
    const sim = new Sim({ seed: 3, worldType: 'test', freeBuild: true });
    expect(sim.unlockedBuildings[SAWMILL]).toBe(0);
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    belts(sim, TIMBER_X, ROW + 1, SOUTH, 5);
    belts(sim, TIMBER_X, ROW + 6, EAST, HUB_X - TIMBER_X);
    belts(sim, HUB_X, ROW + 6, SOUTH, HUB_Y - 2 - (ROW + 6) + 1);
    run(sim, 30 * 120);
    expect(sim.goalIndex).toBeGreaterThanOrEqual(1);
    expect(sim.unlockedBuildings[SAWMILL]).toBe(1);
    // Deliveries stay in the hub as building material.
    expect(sim.stock[TIMBER]).toBe(60 + sim.delivered[TIMBER]);
    expect(sim.events.some((e) => e.type === 'goal' && e.index === 0)).toBe(true);
  });

  it('opens a ring of map and new resources when the camp becomes a hamlet', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    const radius = sim.world.radius;
    const hamlet = GOALS.findIndex((g) => g.unlocks.growMap);
    sim.goalIndex = hamlet;
    passCurrentList(sim);
    run(sim, 31);
    expect(sim.world.radius).toBe(radius + 1);
    expect(sim.unlockedResources[itemId('coal')]).toBe(1);
    expect(sim.unlockedBuildings[buildingId('assembler')]).toBe(1);
    expect(sim.placeError(BELT, sim.world.minTile, sim.world.minTile)).toBeNull();
  });

  it('does not count the starting materials toward a delivery list', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    expect(sim.stock[TIMBER]).toBeGreaterThanOrEqual(GOALS[0].needs[0].count);
    run(sim, 90);
    expect(sim.goalIndex).toBe(0);
  });

  it('announces the win after the last list', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    for (let g = 0; g < GOALS.length; g++) {
      passCurrentList(sim);
      run(sim, 30);
    }
    expect(sim.goalIndex).toBe(GOALS.length);
    expect(sim.events.at(-1)).toEqual({ type: 'won' });
  });
});

/** A busy little factory driven by commands spread over time. */
function scriptedGame(seed: number, ticks: number, saveAt = -1): Sim {
  let sim = testSim(seed);
  for (let t = 0; t < ticks; t++) {
    if (t === 0) {
      place(sim, MINER, IRON_X, ROW, SOUTH);
      place(sim, KILN, IRON_X, ROW + 1, SOUTH);
      sim.enqueue({ type: 'setRecipe', x: IRON_X, y: ROW + 1, recipe: recipeId('iron_plate') });
      belts(sim, IRON_X, ROW + 2, SOUTH, 6);
    }
    if (t === 200) {
      place(sim, SPLITTER, IRON_X, ROW + 8, SOUTH);
      belts(sim, IRON_X + 1, ROW + 8, EAST, 5);
      belts(sim, IRON_X - 1, ROW + 8, WEST, 5);
      belts(sim, IRON_X, ROW + 9, SOUTH, 5);
    }
    if (t === 500) {
      place(sim, MINER, COAL_X, ROW, SOUTH);
      belts(sim, COAL_X, ROW + 1, SOUTH, 4);
      sim.enqueue({ type: 'remove', x: IRON_X, y: ROW + 4 });
    }
    if (t === 650) place(sim, BELT, IRON_X, ROW + 4, SOUTH);
    if (t === 900) sim.enqueue({ type: 'rotate', x: IRON_X + 3, y: ROW + 8 });
    if (t === saveAt) sim = loadSim(saveSim(sim));
    sim.step();
  }
  return sim;
}

describe('building costs', () => {
  const STONE = itemId('stone');

  it('takes materials from the hub when building and returns them when removing', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    const timber = sim.stock[TIMBER];
    const stone = sim.stock[STONE];
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    place(sim, BELT, TIMBER_X, ROW + 1, SOUTH);
    run(sim, 1);
    expect(sim.stock[TIMBER]).toBe(timber - 4 - 1);
    expect(sim.stock[STONE]).toBe(stone - 4);
    sim.enqueue({ type: 'remove', x: TIMBER_X, y: ROW });
    sim.enqueue({ type: 'remove', x: TIMBER_X, y: ROW + 1 });
    run(sim, 1);
    expect(sim.stock[TIMBER]).toBe(timber);
    expect(sim.stock[STONE]).toBe(stone);
  });

  it('refuses a building the hub cannot pay for, and builds nothing', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    sim.stock[STONE] = 3;
    expect(sim.placeError(MINER, TIMBER_X, ROW)).toMatch(/Not enough stone/);
    expect(sim.canAfford(MINER)).toBe(false);
    place(sim, MINER, TIMBER_X, ROW, SOUTH);
    run(sim, 1);
    expect(slotAt(sim, TIMBER_X, ROW)).toBe(-1);
    expect(sim.stock[STONE]).toBe(3);
  });

  it('stops a queued run of belts when the timber runs out', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    sim.stock[TIMBER] = 5;
    belts(sim, TIMBER_X, ROW + 1, EAST, 9);
    run(sim, 1);
    expect(sim.count - 1).toBe(5);
    expect(sim.stock[TIMBER]).toBe(0);
  });

  it('turns a belt for free', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    place(sim, BELT, TIMBER_X, ROW + 1, EAST);
    run(sim, 1);
    sim.stock[TIMBER] = 0;
    expect(sim.placeError(BELT, TIMBER_X, ROW + 1)).toBeNull();
    place(sim, BELT, TIMBER_X, ROW + 1, SOUTH);
    sim.enqueue({ type: 'rotate', x: TIMBER_X, y: ROW + 1 });
    run(sim, 1);
    expect(sim.dir[slotAt(sim, TIMBER_X, ROW + 1)]).toBe(WEST);
    expect(sim.stock[TIMBER]).toBe(0);
  });

  it('asks for made parts for the more complex buildings', () => {
    const sim = new Sim({ seed: 3, worldType: 'test', unlockAll: true });
    expect(sim.placeError(KILN, STONE_X, ROW + 1)).toMatch(/planks/);
    expect(sim.placeError(ASSEMBLER, STONE_X, ROW + 1)).toMatch(/bricks|iron plate/);
    sim.stock[itemId('planks')] = 8;
    sim.stock[itemId('bricks')] = 12;
    sim.stock[IRON_PLATE] = 12;
    expect(sim.placeError(ASSEMBLER, STONE_X, ROW + 1)).toBeNull();
    place(sim, ASSEMBLER, STONE_X, ROW + 1, SOUTH);
    run(sim, 1);
    expect(sim.stock[itemId('bricks')]).toBe(0);
    expect(sim.stock[IRON_PLATE]).toBe(0);
  });
});

describe('determinism and saves', () => {
  it('gives the same state for the same seed and commands', () => {
    const a = scriptedGame(11, 3000);
    const b = scriptedGame(11, 3000);
    expect(a.hash()).toBe(b.hash());
    expect(a.totalMined).toBeGreaterThan(50);
  });

  it('gives the same state when saved and reloaded halfway', () => {
    const a = scriptedGame(11, 3000);
    const b = scriptedGame(11, 3000, 1337);
    expect(b.hash()).toBe(a.hash());
  });

  it('round-trips a save byte for byte', () => {
    const sim = scriptedGame(5, 1200);
    const first = saveSim(sim);
    const second = saveSim(loadSim(first));
    expect(second).toEqual(first);
  });

  it('refuses a file that is not a save, and a save from another version', () => {
    expect(() => loadSim(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/not a Shiftworks save/);
    const bytes = saveSim(testSim());
    const text = new TextDecoder().decode(bytes.subarray(8));
    const patched = new TextEncoder().encode(text.replace(`"version":${SAVE_VERSION}`, '"version":9'));
    const other = new Uint8Array(8 + patched.length);
    other.set(bytes.subarray(0, 8));
    other.set(patched, 8);
    expect(() => loadSim(other)).toThrow(/version 9/);
  });

  it('replays a game from its command log', () => {
    const original = scriptedGame(21, 2000);
    const replay = testSim(21);
    let next = 0;
    for (let t = 0; t < 2000; t++) {
      while (next < original.log.length && original.log[next].tick === t) replay.enqueue(original.log[next++].command);
      replay.step();
    }
    expect(replay.hash()).toBe(original.hash());
  });
});

describe('benchmark factory generator', () => {
  it('builds the lines it was asked for', () => {
    const sim = buildBenchFactory({ lines: 20, beltLength: 30 });
    let miners = 0;
    for (let s = 0; s < sim.count; s++) if (sim.kind[s] === MINER) miners++;
    expect(miners).toBe(20);
    run(sim, 3000);
    expect(sim.countBeltItems()).toBeGreaterThan(20 * 30);
    expect(IRON_ORE).toBeGreaterThan(0);
    expect(PLANKS).toBeGreaterThan(0);
  });
});
