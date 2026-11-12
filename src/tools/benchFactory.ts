// Builds a valid factory of a chosen size on the test map, so performance can
// be measured long before anyone plays that far.

import { buildingId, recipeId } from '../content/content';
import { HUB_X, HUB_Y, Sim } from '../sim';

export interface BenchSize {
  /** Production lines. Each is a miner, a kiln and a run of belt. */
  lines: number;
  /** Belt tiles between the kiln and the end of each line. */
  beltLength: number;
  /** Map size in chunks out from the centre. Defaults to the starting map. */
  radius?: number;
}

/**
 * Lines run east along the test map's deposit rows. Each line ends in a belt
 * that dead-ends, so belts fill up and stay full: the worst case for the tick.
 */
export function buildBenchFactory(size: BenchSize, seed = 1): Sim {
  const sim = new Sim({ seed, worldType: 'test', unlockAll: true, freeBuild: true });
  if (size.radius) sim.world.growTo(size.radius);
  const belt = buildingId('belt');
  const miner = buildingId('miner');
  const kiln = buildingId('kiln');
  const ironPlate = recipeId('iron_plate');
  const left = sim.world.minTile;
  let placed = 0;
  // Iron ore sits where ((x >> 4) % 5) === 2 on rows where y % 8 === 0.
  for (let y = sim.world.minTile; y <= sim.world.maxTile && placed < size.lines; y += 8) {
    for (let x = left; x + size.beltLength + 3 <= sim.world.maxTile && placed < size.lines; x += 16) {
      if ((x >> 4) % 5 !== 2) continue;
      if (Math.abs(y - HUB_Y) < 4 && x < HUB_X + 4 && x + size.beltLength + 3 > HUB_X - 4) continue;
      sim.enqueue({ type: 'place', building: miner, x, y, dir: 1 });
      sim.enqueue({ type: 'place', building: belt, x, y: y + 1, dir: 1 });
      sim.enqueue({ type: 'place', building: kiln, x, y: y + 2, dir: 0 });
      sim.enqueue({ type: 'setRecipe', x, y: y + 2, recipe: ironPlate });
      for (let i = 1; i <= size.beltLength; i++) {
        sim.enqueue({ type: 'place', building: belt, x: x + i, y: y + 2, dir: 0 });
      }
      placed++;
    }
  }
  sim.step();
  return sim;
}
