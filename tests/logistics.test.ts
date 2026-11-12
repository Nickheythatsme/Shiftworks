import { describe, expect, it } from 'vitest';
import { BRIDGE_SPAN, CRATE_CAPACITY, itemId } from '../src/content/content';
import { History } from '../src/history';
import { STATUS_BLOCKED, Sim, loadSim, saveSim } from '../src/sim';
import { BELT, BRIDGE, CRATE, EAST, FILTER, MINER, NORTH, ROW, SOUTH, STONE_X, TIMBER_X, WEST, belts, place, run, slotAt, testSim } from './helpers';

const TIMBER = itemId('timber');
const STONE = itemId('stone');
const TX = TIMBER_X;

/** Everything mined is still somewhere: on a belt, in a crate, or waiting in a miner. */
function nothingLost(sim: Sim): void {
  let held = sim.countBeltItems();
  for (let s = 0; s < sim.count; s++) if (sim.kind[s]) held += sim.out[s];
  for (let item = 1; item < sim.delivered.length; item++) held += sim.delivered[item];
  expect(held).toBe(sim.totalMined);
}

describe('crates', () => {
  it('fill up to their limit with one kind of item and then hold the line', () => {
    const sim = testSim();
    for (let i = 0; i < 6; i++) place(sim, MINER, TX + i, ROW, SOUTH);
    for (let i = 0; i < 6; i++) place(sim, BELT, TX + i, ROW + 1, i === 0 ? SOUTH : WEST);
    belts(sim, TX, ROW + 2, SOUTH, 2);
    place(sim, CRATE, TX, ROW + 4, SOUTH);
    run(sim, 30 * 40);
    const crate = slotAt(sim, TX, ROW + 4);
    expect(sim.aux[crate]).toBe(TIMBER);
    expect(sim.out[crate]).toBeGreaterThan(50);
    expect(sim.out[crate]).toBeLessThan(CRATE_CAPACITY);
    nothingLost(sim);
    run(sim, 30 * 120);
    expect(sim.out[crate]).toBe(CRATE_CAPACITY);
    expect(sim.status[slotAt(sim, TX, ROW)]).toBe(STATUS_BLOCKED);
    nothingLost(sim);
  });

  it('pass items on out of the front, and refuse a second kind of item', () => {
    const sim = testSim();
    place(sim, MINER, TX, ROW, SOUTH);
    place(sim, CRATE, TX, ROW + 1, SOUTH);
    belts(sim, TX, ROW + 2, SOUTH, 3);
    place(sim, CRATE, TX, ROW + 5, SOUTH);
    // Stone arrives at the side of the second crate, which is already holding timber.
    place(sim, MINER, STONE_X, ROW, SOUTH);
    belts(sim, STONE_X, ROW + 1, SOUTH, 4);
    belts(sim, STONE_X, ROW + 5, WEST, STONE_X - TX);
    run(sim, 30 * 90);
    const last = slotAt(sim, TX, ROW + 5);
    expect(sim.aux[last]).toBe(TIMBER);
    expect(sim.out[last]).toBeGreaterThan(20);
    expect(sim.slots[slotAt(sim, TX + 1, ROW + 5) * 4 + 3]).toBe(STONE);
    nothingLost(sim);
  });
});

describe('bridges', () => {
  it('carry one line over another without the two mixing', () => {
    const sim = testSim();
    // Timber runs east along the deposit row and is bridged over column TX + 5.
    place(sim, MINER, TX, ROW, EAST);
    belts(sim, TX + 1, ROW, EAST, 3);
    place(sim, BRIDGE, TX + 4, ROW, EAST);
    place(sim, BRIDGE, TX + 7, ROW, EAST);
    place(sim, BELT, TX + 8, ROW, EAST);
    place(sim, CRATE, TX + 9, ROW, EAST);
    // Stone comes west along a row further north, then south through the gap.
    place(sim, MINER, STONE_X, ROW - 8, WEST);
    belts(sim, STONE_X - 1, ROW - 8, WEST, STONE_X - 1 - (TX + 5));
    belts(sim, TX + 5, ROW - 8, SOUTH, 12);
    place(sim, CRATE, TX + 5, ROW + 4, SOUTH);
    run(sim, 30 * 120);

    const near = slotAt(sim, TX + 4, ROW);
    const far = slotAt(sim, TX + 7, ROW);
    expect(sim.bridgeFarEnd(near)).toBe(far);
    expect(sim.isBridgeFarEnd(far)).toBe(true);
    const timber = slotAt(sim, TX + 9, ROW);
    const stone = slotAt(sim, TX + 5, ROW + 4);
    expect(sim.aux[timber]).toBe(TIMBER);
    expect(sim.out[timber]).toBeGreaterThan(40);
    expect(sim.aux[stone]).toBe(STONE);
    expect(sim.out[stone]).toBeGreaterThan(40);
    nothingLost(sim);
  });

  it('pair up along a line: near, far, near, and only within reach', () => {
    const sim = testSim();
    const x = TX + 20;
    place(sim, BRIDGE, x, ROW + 2, EAST);
    place(sim, BRIDGE, x + 3, ROW + 2, EAST);
    place(sim, BRIDGE, x + 5, ROW + 2, EAST);
    // A bridge facing another way in between is not part of the line.
    place(sim, BRIDGE, x + 1, ROW + 2, SOUTH);
    // Too far apart to pair: one tile more than the span between them.
    place(sim, BRIDGE, x, ROW + 4, EAST);
    place(sim, BRIDGE, x + BRIDGE_SPAN + 2, ROW + 4, EAST);
    // Exactly at the limit.
    place(sim, BRIDGE, x, ROW + 6, WEST);
    place(sim, BRIDGE, x - BRIDGE_SPAN - 1, ROW + 6, WEST);
    sim.applyQueued();
    const at = (dx: number, dy: number) => slotAt(sim, x + dx, ROW + dy);
    expect(sim.bridgeFarEnd(at(0, 2))).toBe(at(3, 2));
    expect(sim.isBridgeFarEnd(at(3, 2))).toBe(true);
    expect(sim.isBridgeFarEnd(at(5, 2))).toBe(false);
    expect(sim.bridgeFarEnd(at(5, 2))).toBe(-1);
    expect(sim.bridgeFarEnd(at(1, 2))).toBe(-1);
    expect(sim.bridgeFarEnd(at(0, 4))).toBe(-1);
    expect(sim.bridgeFarEnd(at(0, 6))).toBe(at(-BRIDGE_SPAN - 1, 6));
  });

  it('take nothing at the far end except from the near end', () => {
    const sim = testSim();
    place(sim, BRIDGE, TX + 2, ROW, EAST);
    place(sim, MINER, TX + 3, ROW, EAST);
    place(sim, BRIDGE, TX + 4, ROW, EAST);
    place(sim, BELT, TX + 5, ROW, EAST);
    place(sim, CRATE, TX + 6, ROW, EAST);
    run(sim, 30 * 30);
    expect(sim.status[slotAt(sim, TX + 3, ROW)]).toBe(STATUS_BLOCKED);
    expect(sim.out[slotAt(sim, TX + 6, ROW)]).toBe(0);
  });
});

describe('filters', () => {
  /** Timber and stone share a belt that ends in a filter, with a crate ahead and one to its right. */
  function mixed(): Sim {
    const sim = testSim();
    place(sim, MINER, TX, ROW, SOUTH);
    belts(sim, TX, ROW + 1, SOUTH, 8);
    place(sim, MINER, STONE_X, ROW, SOUTH);
    belts(sim, STONE_X, ROW + 1, SOUTH, 3);
    belts(sim, STONE_X, ROW + 4, WEST, STONE_X - TX);
    place(sim, FILTER, TX, ROW + 9, SOUTH);
    place(sim, CRATE, TX, ROW + 10, SOUTH);
    place(sim, CRATE, TX - 1, ROW + 9, NORTH);
    return sim;
  }

  it('send the chosen item to the right and everything else straight on', () => {
    const sim = mixed();
    sim.enqueue({ type: 'setFilter', x: TX, y: ROW + 9, item: STONE });
    run(sim, 30 * 120);
    const ahead = slotAt(sim, TX, ROW + 10);
    const right = slotAt(sim, TX - 1, ROW + 9);
    expect(sim.aux[ahead]).toBe(TIMBER);
    expect(sim.out[ahead]).toBeGreaterThan(40);
    expect(sim.aux[right]).toBe(STONE);
    expect(sim.out[right]).toBeGreaterThan(40);
    nothingLost(sim);
  });

  it('send everything straight on until an item is chosen', () => {
    const sim = mixed();
    run(sim, 30 * 60);
    expect(sim.out[slotAt(sim, TX - 1, ROW + 9)]).toBe(0);
    expect(sim.out[slotAt(sim, TX, ROW + 10)]).toBeGreaterThan(0);
  });

  it('only take a filter setting on a filter', () => {
    const sim = mixed();
    const history = new History(() => sim);
    sim.applyQueued();
    expect(history.do({ type: 'setFilter', x: TX, y: ROW + 10, item: STONE })).toBe(false);
    expect(history.do({ type: 'setFilter', x: TX, y: ROW + 9, item: STONE })).toBe(true);
    history.undo();
    expect(sim.recipe[slotAt(sim, TX, ROW + 9)]).toBe(0);
  });
});

describe('the new buildings and the rest of the game', () => {
  function yard(): Sim {
    const sim = testSim();
    place(sim, MINER, TX, ROW, EAST);
    belts(sim, TX + 1, ROW, EAST, 2);
    place(sim, BRIDGE, TX + 3, ROW, EAST);
    place(sim, BRIDGE, TX + 6, ROW, EAST);
    place(sim, FILTER, TX + 7, ROW, EAST);
    place(sim, CRATE, TX + 8, ROW, EAST);
    belts(sim, TX + 9, ROW, EAST, 3);
    sim.enqueue({ type: 'setFilter', x: TX + 7, y: ROW, item: STONE });
    return sim;
  }

  it('come back from an undo with everything they held', () => {
    const control = yard();
    run(control, 900);
    for (const dx of [3, 6, 7, 8]) {
      const sim = yard();
      const history = new History(() => sim);
      run(sim, 600);
      expect(history.do({ type: 'remove', x: TX + dx, y: ROW })).toBe(true);
      expect(history.undo()).toEqual({ done: 1, failed: 0 });
      run(sim, 300);
      expect(sim.hash()).toBe(control.hash());
    }
  });

  it('survive a save and load', () => {
    const sim = yard();
    run(sim, 600);
    const loaded = loadSim(saveSim(sim));
    run(sim, 300);
    run(loaded, 300);
    expect(loaded.hash()).toBe(sim.hash());
  });
});
