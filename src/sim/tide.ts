// The tide. The water level is a formula of the tick and nothing else, so it
// is never saved, the same on every run, and can be asked about any moment in
// the future. Whole numbers only, like the rest of the simulation.

import { TICKS_PER_SECOND, TIDE_CYCLE_SECONDS, TIDE_HIGH, TIDE_LOW } from '../content/content';

export const TIDE_CYCLE_TICKS = TIDE_CYCLE_SECONDS * TICKS_PER_SECOND;
const HALF = TIDE_CYCLE_TICKS / 2;
const STEPS = TIDE_HIGH - TIDE_LOW + 1;

/** Ticks into the rising half (0 at low water, HALF at high water) for any tick. */
function climb(tick: number): number {
  const phase = tick % TIDE_CYCLE_TICKS;
  return phase < HALF ? phase : TIDE_CYCLE_TICKS - phase;
}

/**
 * The water level at a tick. A tile is under water when its height is below
 * this. A game starts at low water with the tide coming in; each level between
 * low and high lasts the same length of time.
 */
export function tideLevel(tick: number): number {
  return TIDE_LOW + Math.floor((STEPS * climb(tick)) / (HALF + 1));
}

/** The level as a smooth number, for drawing the shoreline between steps. Never used by the simulation. */
export function tideSmooth(tick: number): number {
  return TIDE_LOW + (STEPS * climb(tick)) / (HALF + 1);
}

export interface TideInfo {
  level: number;
  rising: boolean;
  /** Ticks until the tide turns: high water if it is rising, low water if it is falling. */
  ticksToTurn: number;
}

export function tideInfo(tick: number): TideInfo {
  const phase = tick % TIDE_CYCLE_TICKS;
  const rising = phase < HALF;
  return { level: tideLevel(tick), rising, ticksToTurn: rising ? HALF - phase : TIDE_CYCLE_TICKS - phase };
}
