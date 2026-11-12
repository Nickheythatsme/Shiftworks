import { describe, expect, it } from 'vitest';
import { itemId, recipeId } from '../src/content/content';
import { History } from '../src/history';
import { HUB_X, HUB_Y, Sim } from '../src/sim';
import { ASSEMBLER, BELT, EAST, IRON_X, KILN, MINER, ROW, SAWMILL, SOUTH, SPLITTER, TIMBER_X, belts, place, run, slotAt, testSim } from './helpers';

/** A small working factory: timber to planks through a splitter, and an assembler making tools. */
function factory(): Sim {
  const sim = testSim();
  place(sim, MINER, TIMBER_X, ROW, SOUTH);
  place(sim, SAWMILL, TIMBER_X, ROW + 1, SOUTH);
  belts(sim, TIMBER_X, ROW + 2, SOUTH, 3);
  place(sim, SPLITTER, TIMBER_X, ROW + 5, SOUTH);
  belts(sim, TIMBER_X, ROW + 6, EAST, IRON_X - TIMBER_X);
  place(sim, MINER, IRON_X, ROW, SOUTH);
  place(sim, KILN, IRON_X, ROW + 1, SOUTH);
  sim.enqueue({ type: 'setRecipe', x: IRON_X, y: ROW + 1, recipe: recipeId('iron_plate') });
  belts(sim, IRON_X, ROW + 2, SOUTH, 4);
  place(sim, ASSEMBLER, IRON_X, ROW + 6, SOUTH);
  sim.enqueue({ type: 'setRecipe', x: IRON_X, y: ROW + 6, recipe: recipeId('tools') });
  belts(sim, IRON_X, ROW + 7, SOUTH, 6);
  return sim;
}

describe('undo and redo', () => {
  it('undoes a placement and gives the materials back, and redoes it', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    const history = new History(() => sim);
    const timber = sim.stock[itemId('timber')];
    expect(history.do({ type: 'place', building: BELT, x: HUB_X + 5, y: HUB_Y + 5, dir: EAST })).toBe(true);
    expect(sim.stock[itemId('timber')]).toBe(timber - 1);
    expect(history.undo()).toEqual({ done: 1, failed: 0 });
    expect(slotAt(sim, HUB_X + 5, HUB_Y + 5)).toBe(-1);
    expect(sim.stock[itemId('timber')]).toBe(timber);
    expect(history.redo()).toEqual({ done: 1, failed: 0 });
    expect(slotAt(sim, HUB_X + 5, HUB_Y + 5)).toBeGreaterThanOrEqual(0);
    expect(history.undo()).toEqual({ done: 1, failed: 0 });
    expect(history.undo()).toBeNull();
  });

  it('does not record a command the simulation refused', () => {
    const sim = testSim();
    const history = new History(() => sim);
    expect(history.do({ type: 'place', building: MINER, x: HUB_X + 5, y: HUB_Y + 5, dir: EAST })).toBe(false);
    expect(history.canUndo).toBe(false);
  });

  it('puts a removed building back with everything it held', () => {
    // Removing and restoring any one building must leave the factory exactly as
    // it would have been had nothing happened.
    const targets: [number, number][] = [
      [TIMBER_X, ROW], [TIMBER_X, ROW + 1], [TIMBER_X, ROW + 3], [TIMBER_X, ROW + 5], [IRON_X, ROW + 6], [IRON_X - 4, ROW + 6],
    ];
    const control = factory();
    run(control, 900);
    for (const [x, y] of targets) {
      const sim = factory();
      const history = new History(() => sim);
      run(sim, 600);
      expect(history.do({ type: 'remove', x, y })).toBe(true);
      expect(slotAt(sim, x, y)).toBe(-1);
      expect(history.undo()).toEqual({ done: 1, failed: 0 });
      run(sim, 300);
      expect(sim.hash()).toBe(control.hash());
    }
  });

  it('undoes a whole group in one step', () => {
    const sim = testSim();
    const history = new History(() => sim);
    history.begin();
    for (let i = 0; i < 6; i++) history.do({ type: 'place', building: BELT, x: HUB_X + 5 + i, y: HUB_Y + 5, dir: EAST });
    history.commit();
    history.do({ type: 'place', building: BELT, x: HUB_X + 5, y: HUB_Y + 7, dir: EAST });
    expect(history.undo()).toEqual({ done: 1, failed: 0 });
    expect(history.undo()).toEqual({ done: 6, failed: 0 });
    for (let i = 0; i < 6; i++) expect(slotAt(sim, HUB_X + 5 + i, HUB_Y + 5)).toBe(-1);
    expect(history.redo()).toEqual({ done: 6, failed: 0 });
    expect(history.redo()).toEqual({ done: 1, failed: 0 });
    expect(history.canRedo).toBe(false);
  });

  it('turns a belt back, and restores a recipe and a rotation', () => {
    const sim = testSim();
    const history = new History(() => sim);
    const x = HUB_X + 5;
    const y = HUB_Y + 5;
    history.do({ type: 'place', building: BELT, x, y, dir: EAST });
    history.do({ type: 'place', building: BELT, x, y, dir: SOUTH });
    history.undo();
    expect(sim.dir[slotAt(sim, x, y)]).toBe(EAST);

    history.do({ type: 'place', building: KILN, x, y: y + 2, dir: EAST });
    const kiln = slotAt(sim, x, y + 2);
    const first = sim.recipe[kiln];
    history.do({ type: 'setRecipe', x, y: y + 2, recipe: recipeId('charcoal') });
    history.do({ type: 'rotate', x, y: y + 2 });
    expect(sim.dir[kiln]).toBe(SOUTH);
    history.undo();
    expect(sim.dir[kiln]).toBe(EAST);
    history.undo();
    expect(sim.recipe[kiln]).toBe(first);
  });

  it('says so when a removed building can no longer be paid for', () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    const history = new History(() => sim);
    history.do({ type: 'place', building: BELT, x: HUB_X + 5, y: HUB_Y + 5, dir: EAST });
    history.do({ type: 'remove', x: HUB_X + 5, y: HUB_Y + 5 });
    sim.stock.fill(0);
    expect(history.undo()).toEqual({ done: 0, failed: 1 });
    expect(slotAt(sim, HUB_X + 5, HUB_Y + 5)).toBe(-1);
  });

  it('forgets a redo once something new is done', () => {
    const sim = testSim();
    const history = new History(() => sim);
    history.do({ type: 'place', building: BELT, x: HUB_X + 5, y: HUB_Y + 5, dir: EAST });
    history.undo();
    history.do({ type: 'place', building: BELT, x: HUB_X + 6, y: HUB_Y + 5, dir: EAST });
    expect(history.canRedo).toBe(false);
  });
});
