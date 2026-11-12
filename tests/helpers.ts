import { buildingId } from '../src/content/content';
import { HUB_X, HUB_Y, Sim } from '../src/sim';

export const BELT = buildingId('belt');
export const SPLITTER = buildingId('splitter');
export const MINER = buildingId('miner');
export const SAWMILL = buildingId('sawmill');
export const KILN = buildingId('kiln');
export const ASSEMBLER = buildingId('assembler');

export const EAST = 0;
export const SOUTH = 1;
export const WEST = 2;
export const NORTH = 3;

/** Test map: all land, deposits on rows where y % 8 === 0, resource by 16-tile band. */
export function testSim(seed = 1): Sim {
  return new Sim({ seed, worldType: 'test', unlockAll: true });
}

/** A deposit row well away from the hub. Timber starts at X0, then stone, iron, copper, coal. */
export const ROW = HUB_Y - 40;
export const X0 = HUB_X - 64;
export const TIMBER_X = X0;
export const STONE_X = X0 + 16;
export const IRON_X = X0 + 32;
export const COPPER_X = X0 + 48;
export const COAL_X = X0 + 64;

export function place(sim: Sim, building: number, x: number, y: number, dir: number): void {
  sim.enqueue({ type: 'place', building, x, y, dir });
}

export function belts(sim: Sim, x: number, y: number, dir: number, length: number): void {
  const dx = [1, 0, -1, 0][dir];
  const dy = [0, 1, 0, -1][dir];
  for (let i = 0; i < length; i++) place(sim, BELT, x + dx * i, y + dy * i, dir);
}

export function run(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step();
}

export function slotAt(sim: Sim, x: number, y: number): number {
  return sim.world.buildingAt(x, y);
}

/** Items held anywhere in buildings: belts, machine inputs and outputs. */
export function itemsOnBelts(sim: Sim): number {
  return sim.countBeltItems();
}
