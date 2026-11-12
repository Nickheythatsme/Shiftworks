// Saves: a small JSON header followed by a straight copy of the state arrays.
// Until the game is finished a save from another format version is refused,
// not migrated.

import { Sim } from './sim';
import type { WorldType } from './world';

export const SAVE_VERSION = 1;
const MAGIC = 0x54464853; // "SHFT", little-endian

interface Header {
  format: 'shiftworks';
  version: number;
  seed: number;
  worldType: WorldType;
  tick: number;
  radius: number;
  count: number;
  freeCount: number;
  goalIndex: number;
  totalMined: number;
  arrays: { name: string; bytes: number }[];
}

function townArrays(sim: Sim): { name: string; array: Uint8Array | Uint32Array | Int32Array; bytes: number }[] {
  return [
    { name: 'freeList', array: sim.freeList, bytes: sim.freeCount * 4 },
    { name: 'stock', array: sim.stock, bytes: sim.stock.byteLength },
    { name: 'delivered', array: sim.delivered, bytes: sim.delivered.byteLength },
    { name: 'unlockedBuildings', array: sim.unlockedBuildings, bytes: sim.unlockedBuildings.byteLength },
    { name: 'unlockedRecipes', array: sim.unlockedRecipes, bytes: sim.unlockedRecipes.byteLength },
    { name: 'unlockedResources', array: sim.unlockedResources, bytes: sim.unlockedResources.byteLength },
  ];
}

export function saveSim(sim: Sim): Uint8Array {
  const parts: { name: string; view: Uint8Array }[] = [];
  for (const a of sim.buildingArrays()) {
    const bytes = sim.count * a.per * a.array.BYTES_PER_ELEMENT;
    parts.push({ name: a.name, view: new Uint8Array(a.array.buffer, a.array.byteOffset, bytes) });
  }
  for (const a of townArrays(sim)) {
    parts.push({ name: a.name, view: new Uint8Array(a.array.buffer, a.array.byteOffset, a.bytes) });
  }
  const header: Header = {
    format: 'shiftworks',
    version: SAVE_VERSION,
    seed: sim.world.seed,
    worldType: sim.world.type,
    tick: sim.tick,
    radius: sim.world.radius,
    count: sim.count,
    freeCount: sim.freeCount,
    goalIndex: sim.goalIndex,
    totalMined: sim.totalMined,
    arrays: parts.map((p) => ({ name: p.name, bytes: p.view.byteLength })),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const total = 8 + headerBytes.byteLength + parts.reduce((n, p) => n + p.view.byteLength, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, headerBytes.byteLength, true);
  out.set(headerBytes, 8);
  let offset = 8 + headerBytes.byteLength;
  for (const p of parts) {
    out.set(p.view, offset);
    offset += p.view.byteLength;
  }
  return out;
}

/** Rebuilds a simulation from a save. Throws with a readable message if it cannot. */
export function loadSim(data: Uint8Array): Sim {
  if (data.byteLength < 8) throw new Error('This file is not a Shiftworks save.');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('This file is not a Shiftworks save.');
  const headerLength = dv.getUint32(4, true);
  let header: Header;
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + headerLength))) as Header;
  } catch {
    throw new Error('This save is damaged and cannot be read.');
  }
  if (header.format !== 'shiftworks') throw new Error('This file is not a Shiftworks save.');
  if (header.version !== SAVE_VERSION) {
    throw new Error(`This save is from format version ${header.version}; this build reads version ${SAVE_VERSION}.`);
  }

  const sim = new Sim({ seed: header.seed, worldType: header.worldType, blank: true });
  sim.world.growTo(header.radius);
  sim.reserve(header.count);
  sim.tick = header.tick;
  sim.count = header.count;
  sim.freeCount = header.freeCount;
  sim.goalIndex = header.goalIndex;
  sim.totalMined = header.totalMined;

  const targets = new Map<string, ArrayBufferView>();
  for (const a of sim.buildingArrays()) targets.set(a.name, a.array);
  for (const a of townArrays(sim)) targets.set(a.name, a.array);

  let offset = 8 + headerLength;
  for (const entry of header.arrays) {
    const target = targets.get(entry.name);
    if (!target || entry.bytes > target.byteLength || offset + entry.bytes > data.byteLength) {
      throw new Error('This save is damaged and cannot be read.');
    }
    new Uint8Array(target.buffer, target.byteOffset, entry.bytes).set(data.subarray(offset, offset + entry.bytes));
    offset += entry.bytes;
  }
  sim.rebuildDerived();
  return sim;
}
