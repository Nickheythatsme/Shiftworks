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

export interface Flooding {
  /** 'dry' never floods, 'water' is always under water, 'tidal' is covered for part of every cycle. */
  kind: 'dry' | 'water' | 'tidal';
  wet: boolean;
  /** Ticks until the water arrives if the ground is dry now, or leaves if it is wet. 0 unless tidal. */
  ticksToChange: number;
  /** Ticks under water in each cycle. */
  wetTicks: number;
}

/**
 * What the tide does to ground of a given height, seen from a given tick. This
 * is the same rule the simulation applies, turned round to give a time, so it
 * is always right about what will happen.
 */
export function flooding(height: number, tick: number): Flooding {
  if (height < TIDE_LOW) return { kind: 'water', wet: true, ticksToChange: 0, wetTicks: TIDE_CYCLE_TICKS };
  if (height >= TIDE_HIGH) return { kind: 'dry', wet: false, ticksToChange: 0, wetTicks: 0 };
  // The ground is wet while the water level is above it, which is while the
  // tide is at least `first` ticks into its climb, on the way up or the way down.
  const first = Math.ceil(((height + 1 - TIDE_LOW) * (HALF + 1)) / STEPS);
  const last = TIDE_CYCLE_TICKS - first;
  const phase = tick % TIDE_CYCLE_TICKS;
  const wet = phase >= first && phase <= last;
  const ticksToChange = wet ? last + 1 - phase : phase < first ? first - phase : TIDE_CYCLE_TICKS - phase + first;
  return { kind: 'tidal', wet, ticksToChange, wetTicks: last - first + 1 };
}
