import { describe, expect, it } from 'vitest';
import { buildBenchFactory, type BenchSize } from '../src/tools/benchFactory';

// One row per tier of the design's scale table. Each line is one miner, one
// kiln and a run of belt, so "machines" below is two per line.
const ROWS: { name: string; size: BenchSize }[] = [
  { name: 'tiers 1-2  (60 machines, 500 belts)', size: { lines: 30, beltLength: 16 } },
  { name: 'tier 3     (150 machines, 2,000 belts)', size: { lines: 75, beltLength: 26 } },
  { name: 'tier 4     (400 machines, 6,000 belts)', size: { lines: 200, beltLength: 29, radius: 8 } },
  { name: 'tier 5     (600 machines, 10,000 belts)', size: { lines: 300, beltLength: 32, radius: 8 } },
  { name: 'ceiling    (2,000 machines, 25,000 belts)', size: { lines: 1000, beltLength: 24, radius: 16 } },
];

const TICKS = 3000;

describe('tick benchmark', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const sim = buildBenchFactory(row.size);
      let machines = 0;
      let beltTiles = 0;
      for (let s = 0; s < sim.count; s++) {
        const role = sim.role(s);
        if (role === 3 || role === 4) machines++;
        if (role === 1) beltTiles++;
      }
      expect(machines).toBe(row.size.lines * 2);

      // Warm up and let belts fill, then measure.
      for (let i = 0; i < 1500; i++) sim.step();
      sim.work.machineUpdates = 0;
      sim.work.transportUpdates = 0;
      const start = performance.now();
      for (let i = 0; i < TICKS; i++) sim.step();
      const ms = (performance.now() - start) / TICKS;

      // The gate is counted work, which does not depend on the machine running
      // the test. The plain simulation touches every machine every tick and
      // every belt on every belt beat; anything above that is a regression.
      const beats = Math.ceil(TICKS / sim.beltPeriod);
      expect(sim.work.machineUpdates).toBeLessThanOrEqual(machines * TICKS);
      expect(sim.work.transportUpdates).toBeLessThanOrEqual(beltTiles * beats);

      console.log(
        `${row.name}: ${ms.toFixed(4)} ms/tick, ${machines} machines, ${beltTiles} belt tiles, ` +
          `${sim.countBeltItems()} items on belts`,
      );
    });
  }
});
