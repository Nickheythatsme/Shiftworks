import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND, TIDE_CYCLE_SECONDS, TIDE_HIGH, TIDE_LOW, itemId } from '../src/content/content';
import { HUB_X, HUB_Y, STATUS_DORMANT, Sim, TIDE_CYCLE_TICKS, flooding, loadSim, saveSim, tideInfo, tideLevel } from '../src/sim';
import { BELT, CRATE, MINER, SOUTH, WEST, belts, place, run, slotAt } from './helpers';

// The slope test map: dry round the hub, and east of it the ground climbs out
// of the tide one level every two tiles, starting at the low-water mark 16
// tiles out. Stone lies along rows where y % 8 === 0 from 32 tiles out.
const STONE = itemId('stone');
const ROW = HUB_Y - 8;
/** The x of the first tile at a given height on the slope. */
const xAt = (height: number) => HUB_X + 16 + (height - TIDE_LOW) * 2;
/** The first tick at which the water stands at a level, on the way up. */
function tickOfLevel(level: number): number {
  for (let t = 0; t <= TIDE_CYCLE_TICKS / 2; t += TICKS_PER_SECOND) if (tideLevel(t) >= level) return t;
  throw new Error('the tide never gets that high');
}

function slope(): Sim {
  return new Sim({ seed: 5, worldType: 'slope', unlockAll: true, freeBuild: true });
}

describe('the tide', () => {
  it('starts low, reaches high water half way through a cycle, and comes back', () => {
    expect(TIDE_CYCLE_TICKS).toBe(TIDE_CYCLE_SECONDS * TICKS_PER_SECOND);
    expect(tideLevel(0)).toBe(TIDE_LOW);
    expect(tideLevel(TIDE_CYCLE_TICKS / 2)).toBe(TIDE_HIGH);
    expect(tideLevel(TIDE_CYCLE_TICKS)).toBe(TIDE_LOW);
    expect(tideLevel(TIDE_CYCLE_TICKS * 3 + 100)).toBe(tideLevel(100));
    let last = TIDE_LOW;
    const ticksAt = new Map<number, number>();
    for (let t = 0; t <= TIDE_CYCLE_TICKS / 2; t++) {
      const level = tideLevel(t);
      expect(level === last || level === last + 1).toBe(true);
      expect(tideLevel(TIDE_CYCLE_TICKS - t)).toBe(level);
      ticksAt.set(level, (ticksAt.get(level) ?? 0) + 1);
      last = level;
    }
    // Every level lasts about as long as every other on the way up.
    const share = TIDE_CYCLE_TICKS / 2 / (TIDE_HIGH - TIDE_LOW + 1);
    for (let level = TIDE_LOW; level < TIDE_HIGH; level++) expect(Math.abs(ticksAt.get(level)! - share)).toBeLessThan(2);
  });

  it('says which way it is going and when it turns', () => {
    expect(tideInfo(0)).toEqual({ level: TIDE_LOW, rising: true, ticksToTurn: TIDE_CYCLE_TICKS / 2 });
    const falling = tideInfo(TIDE_CYCLE_TICKS / 2 + 300);
    expect(falling.rising).toBe(false);
    expect(falling.ticksToTurn).toBe(TIDE_CYCLE_TICKS / 2 - 300);
  });

  it('covers and uncovers ground by its height, and never the ground round the hub', () => {
    const sim = slope();
    const low = xAt(TIDE_LOW);
    const mid = xAt(92);
    const top = xAt(TIDE_HIGH);
    expect(sim.world.terrainAt(low, ROW)).toBe(0);
    run(sim, tickOfLevel(93) + 1);
    expect(sim.world.level).toBe(93);
    expect(sim.world.terrainAt(low, ROW)).toBe(1);
    expect(sim.world.terrainAt(mid, ROW)).toBe(1);
    expect(sim.world.terrainAt(mid + 2, ROW)).toBe(0);
    expect(sim.placeError(BELT, mid, ROW)).toMatch(/water/);
    expect(sim.placeError(BELT, mid + 2, ROW)).toBeNull();
    run(sim, TIDE_CYCLE_TICKS / 2 - sim.tick + 1);
    expect(sim.world.level).toBe(TIDE_HIGH);
    expect(sim.world.terrainAt(top - 1, ROW)).toBe(1);
    expect(sim.world.terrainAt(top, ROW)).toBe(0);
    expect(sim.world.terrainAt(HUB_X + 10, HUB_Y)).toBe(0);
  });
});

describe('a flooded factory', () => {
  /** A stone miner on tidal ground at height 96, with a belt west to a crate on high ground. */
  function flat(): { sim: Sim; mx: number } {
    const sim = slope();
    const mx = xAt(96);
    place(sim, MINER, mx, ROW, WEST);
    belts(sim, mx - 1, ROW, WEST, mx - 1 - (HUB_X + 12));
    place(sim, CRATE, HUB_X + 12, ROW, SOUTH);
    return { sim, mx };
  }

  function held(sim: Sim): number {
    let n = sim.countBeltItems();
    for (let s = 0; s < sim.count; s++) if (sim.kind[s]) n += sim.out[s];
    return n;
  }

  it('sleeps under water, loses nothing, and wakes when the tide goes out', () => {
    const { sim, mx } = flat();
    const miner = () => slotAt(sim, mx, ROW);
    const crate = () => slotAt(sim, HUB_X + 12, ROW);
    sim.applyQueued();
    expect(sim.world.depositAt(mx, ROW)).toBe(STONE);

    // The belt lies lower than the miner, so the water reaches it first.
    run(sim, tickOfLevel(90));
    const before = sim.out[crate()];
    expect(before).toBeGreaterThan(20);
    expect(sim.isDormant(miner())).toBe(false);
    expect(sim.isDormant(slotAt(sim, xAt(86), ROW))).toBe(true);
    expect(held(sim)).toBe(sim.totalMined);

    run(sim, tickOfLevel(97) - sim.tick + 1);
    expect(sim.isDormant(miner())).toBe(true);
    expect(sim.status[miner()]).toBe(STATUS_DORMANT);
    const mined = sim.totalMined;
    const stored = sim.out[crate()];
    run(sim, 30 * 60);
    expect(sim.totalMined).toBe(mined);
    expect(sim.out[crate()]).toBe(stored);
    expect(held(sim)).toBe(sim.totalMined);

    // Round to low water again: everything runs and the crate has grown.
    run(sim, TIDE_CYCLE_TICKS - sim.tick + 30 * 60);
    expect(sim.isDormant(miner())).toBe(false);
    expect(sim.status[miner()]).not.toBe(STATUS_DORMANT);
    expect(sim.totalMined).toBeGreaterThan(mined);
    expect(sim.out[crate()]).toBeGreaterThan(stored);
    expect(held(sim)).toBe(sim.totalMined);
  });

  it('can still be taken down while it is under water', () => {
    const { sim, mx } = flat();
    run(sim, tickOfLevel(98) + 1);
    expect(sim.isDormant(slotAt(sim, mx, ROW))).toBe(true);
    sim.enqueue({ type: 'remove', x: mx, y: ROW });
    run(sim, 1);
    expect(slotAt(sim, mx, ROW)).toBe(-1);
    expect(sim.placeError(MINER, mx, ROW)).toMatch(/water/);
  });

  it('reloads from a save made at any state of the tide to exactly the same game', () => {
    for (const level of [88, 95, TIDE_HIGH]) {
      const { sim } = flat();
      run(sim, tickOfLevel(level) + 77);
      const loaded = loadSim(saveSim(sim));
      expect(loaded.world.level).toBe(sim.world.level);
      expect(loaded.hash()).toBe(sim.hash());
      run(sim, TIDE_CYCLE_TICKS / 2);
      run(loaded, TIDE_CYCLE_TICKS / 2);
      expect(loaded.hash()).toBe(sim.hash());
    }
  });
});

describe('the forecast', () => {
  it('says exactly when the water will arrive and leave, for every height', () => {
    const sim = slope();
    // Ask at several moments in the cycle, then run on and see whether it was right.
    for (const start of [0, 7_001, TIDE_CYCLE_TICKS / 2 - 3, TIDE_CYCLE_TICKS / 2 + 4_444, TIDE_CYCLE_TICKS - 10]) {
      run(sim, start - (sim.tick % TIDE_CYCLE_TICKS) + (start < sim.tick % TIDE_CYCLE_TICKS ? TIDE_CYCLE_TICKS : 0));
      for (const height of [TIDE_LOW, 87, 92, 96, TIDE_HIGH - 1]) {
        const f = flooding(height, sim.tick);
        const x = xAt(height);
        expect(f.kind).toBe('tidal');
        // What the forecast says of now is what the map says of now.
        expect(f.wet).toBe(sim.world.terrainAt(x, ROW) === 1);
        // One tick before the change the tile is as it is now; at the change it has flipped.
        const probe = new Sim({ seed: 5, worldType: 'slope' });
        probe.tick = sim.tick;
        probe.rebuildDerived();
        run(probe, f.ticksToChange - 1);
        expect(probe.world.terrainAt(x, ROW) === 1).toBe(f.wet);
        run(probe, 1);
        expect(probe.world.terrainAt(x, ROW) === 1).toBe(!f.wet);
      }
    }
  });

  it('adds up: time under water and time dry make one cycle', () => {
    for (let height = TIDE_LOW; height < TIDE_HIGH; height++) {
      const f = flooding(height, 0);
      expect(f.wet).toBe(false);
      const later = flooding(height, f.ticksToChange);
      expect(later.wet).toBe(true);
      expect(later.ticksToChange).toBe(f.wetTicks);
      // Lower ground is under water for longer.
      if (height > TIDE_LOW) expect(f.wetTicks).toBeLessThan(flooding(height - 1, 0).wetTicks);
    }
    expect(flooding(TIDE_LOW - 1, 0).kind).toBe('water');
    expect(flooding(TIDE_HIGH, 0).kind).toBe('dry');
  });
});
