// Every model is assembled in code from simple shapes. There are no asset files.
// Models face +X: that is the side a building pushes items out of.
//
// Each vertex carries two extra attributes that the building shader reads:
//   aAnim  = (mode, p1, p2, speed)   what, if anything, this part does
//   aPivot = the point the motion is measured from
// so one merged mesh per building can still have spinning, bobbing and glowing
// parts without any per-frame work on the processor.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const ANIM_NONE = 0;
/** Belt surface. p1 is the distance along the belt, in tiles. */
export const ANIM_BELT = 1;
/** Spins about a vertical axis through the pivot while the building works. */
export const ANIM_SPIN_Y = 2;
/** Spins about the Z axis through the pivot while the building works. */
export const ANIM_SPIN_Z = 3;
/** Bobs up and down. p1 phase, p2 height. */
export const ANIM_BOB = 4;
/** Flickering glow while the building works. p1 phase. */
export const ANIM_FIRE = 5;
/** Status lamp: green, amber, red or grey. */
export const ANIM_LAMP = 6;
/** Smoke puff that rises from the pivot and fades. p1 phase, p2 height. */
export const ANIM_SMOKE = 7;
/** Swings back and forth about a vertical axis. p1 angle in radians. */
export const ANIM_SWING_Y = 8;
/** Always glows softly: lit windows. */
export const ANIM_GLOW = 9;
/** Ripples like cloth. */
export const ANIM_FLAG = 10;
/** Sways in the wind, more at the top. Trees and grass. */
export const ANIM_SWAY = 11;

interface Motion {
  mode: number;
  p1?: number;
  p2?: number;
  speed?: number;
  pivot?: [number, number, number];
}

const scratch = new THREE.Color();

/**
 * Finishes a part: one colour, a little darker near the ground so shapes sit in
 * their own shade, plus the motion attributes.
 */
function part(geometry: THREE.BufferGeometry, color: number, motion?: Motion, shade = true): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  g.deleteAttribute('uv');
  if (!g.hasAttribute('normal')) g.computeVertexNormals();
  scratch.setHex(color);
  const position = g.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);
  const anim = new Float32Array(count * 4);
  const pivot = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = position.getY(i);
    const k = shade ? 0.7 + 0.3 * Math.min(1, Math.max(0, y / 0.45)) : 1;
    colors[i * 3] = scratch.r * k;
    colors[i * 3 + 1] = scratch.g * k;
    colors[i * 3 + 2] = scratch.b * k;
    if (motion) {
      anim[i * 4] = motion.mode;
      anim[i * 4 + 1] = motion.p1 ?? 0;
      anim[i * 4 + 2] = motion.p2 ?? 0;
      anim[i * 4 + 3] = motion.speed ?? 1;
      if (motion.pivot) pivot.set(motion.pivot, i * 3);
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('aAnim', new THREE.BufferAttribute(anim, 4));
  g.setAttribute('aPivot', new THREE.BufferAttribute(pivot, 3));
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, motion?: Motion): THREE.BufferGeometry {
  return part(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), color, motion);
}

function cyl(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, color: number, sides = 8, motion?: Motion): THREE.BufferGeometry {
  return part(new THREE.CylinderGeometry(rTop, rBottom, h, sides).translate(x, y + h / 2, z), color, motion);
}

function ball(r: number, x: number, y: number, z: number, color: number, motion?: Motion): THREE.BufferGeometry {
  return part(new THREE.IcosahedronGeometry(r, 0).translate(x, y, z), color, motion, false);
}

/** A gable roof: ridge along X, `w` long, `d` across, `h` high, sitting at height `y`. */
function gable(w: number, d: number, h: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const a0 = [-w / 2, 0, -d / 2];
  const a1 = [w / 2, 0, -d / 2];
  const b0 = [-w / 2, 0, d / 2];
  const b1 = [w / 2, 0, d / 2];
  const r0 = [-w / 2, h, 0];
  const r1 = [w / 2, h, 0];
  const tris = [b0, b1, r1, b0, r1, r0, a1, a0, r0, a1, r0, r1, a1, r1, b1, b0, r0, a0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat()), 3));
  g.computeVertexNormals();
  g.translate(x, y, z);
  return part(g, color, undefined, false);
}

/** A flat arrowhead lying on a surface, pointing along `angle` (0 is +X). */
function arrow(size: number, x: number, y: number, z: number, angle: number, color: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(size * 0.6, size, 3);
  g.rotateZ(-Math.PI / 2);
  g.scale(1, 0.12, 1);
  g.rotateY(angle);
  g.translate(x, y, z);
  return part(g, color, undefined, false);
}

/** The chute that marks a building's output side. */
function chute(): THREE.BufferGeometry[] {
  return [
    box(0.2, 0.06, 0.4, 0.4, 0.1, 0, 0x3a3f4b),
    box(0.2, 0.14, 0.04, 0.4, 0.14, 0.2, 0xf2c14e),
    box(0.2, 0.14, 0.04, 0.4, 0.14, -0.2, 0xf2c14e),
    arrow(0.16, 0.4, 0.17, 0, 0, 0xf2c14e),
  ];
}

/** A status lamp on a short pole. */
function lamp(x: number, y: number, z: number): THREE.BufferGeometry[] {
  return [
    cyl(0.025, 0.025, 0.14, x, y, z, 0x2b2f38, 5),
    part(new THREE.BoxGeometry(0.13, 0.11, 0.13).translate(x, y + 0.19, z), 0xffffff, { mode: ANIM_LAMP }, false),
  ];
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Could not merge model parts.');
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** Mirrors a model across the X axis line (flips Z) and keeps its faces outward. */
function mirrorZ(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.clone();
  g.scale(1, 1, -1);
  const pivot = g.getAttribute('aPivot') as THREE.BufferAttribute;
  for (let i = 0; i < pivot.count; i++) pivot.setZ(i, -pivot.getZ(i));
  // Swap two corners of every triangle so the faces still point out.
  for (const name of Object.keys(g.attributes)) {
    const attribute = g.getAttribute(name) as THREE.BufferAttribute;
    const size = attribute.itemSize;
    const array = attribute.array as Float32Array;
    for (let t = 0; t < attribute.count; t += 3) {
      for (let k = 0; k < size; k++) {
        const a = (t + 1) * size + k;
        const b = (t + 2) * size + k;
        const tmp = array[a];
        array[a] = array[b];
        array[b] = tmp;
      }
    }
  }
  g.computeVertexNormals();
  return g;
}

// ---- belts -------------------------------------------------------------------

const BELT_DARK = 0x2b303b;
const BELT_RAIL = 0x6c7689;
const BELT_SURFACE = 0x474e5e;

export function buildBeltStraight(): THREE.BufferGeometry {
  const surface = new THREE.BoxGeometry(1, 0.03, 0.7).translate(0, 0.115, 0);
  const s = part(surface, BELT_SURFACE, { mode: ANIM_BELT }, false);
  const position = s.getAttribute('position');
  const anim = s.getAttribute('aAnim') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) anim.setY(i, position.getX(i) + 0.5);
  return merge([
    box(1, 0.1, 0.8, 0, 0, 0, BELT_DARK),
    s,
    box(1, 0.1, 0.06, 0, 0.08, 0.39, BELT_RAIL),
    box(1, 0.1, 0.06, 0, 0.08, -0.39, BELT_RAIL),
  ]);
}

/**
 * A belt that turns: items come in from the +Z side and leave through +X.
 * `mirrored` gives the turn from the -Z side.
 */
export function buildBeltCurve(mirrored: boolean): THREE.BufferGeometry {
  const sector = (inner: number, outer: number, y: number) =>
    new THREE.RingGeometry(inner, outer, 10, 1, Math.PI / 2, Math.PI / 2).rotateX(-Math.PI / 2).translate(0.5, y, 0.5);
  const surface = part(sector(0.15, 0.85, 0.13), BELT_SURFACE, { mode: ANIM_BELT }, false);
  const position = surface.getAttribute('position');
  const anim = surface.getAttribute('aAnim') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    let angle = Math.atan2(position.getZ(i) - 0.5, position.getX(i) - 0.5);
    if (angle < 0) angle += Math.PI * 2;
    anim.setY(i, (angle - Math.PI) / (Math.PI / 2));
  }
  const rail = (radius: number) =>
    part(
      new THREE.TorusGeometry(radius, 0.04, 4, 8, Math.PI / 2).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).translate(0.5, 0.14, 0.5),
      BELT_RAIL, undefined, false,
    );
  const model = merge([
    part(sector(0.1, 0.9, 0.1), BELT_DARK, undefined, false),
    surface,
    rail(0.11),
    rail(0.89),
    box(0.5, 0.1, 0.5, -0.05, 0, -0.05, BELT_DARK),
  ]);
  if (!mirrored) return model;
  const flipped = mirrorZ(model);
  model.dispose();
  return flipped;
}

// ---- buildings -----------------------------------------------------------------

export function buildSplitter(): THREE.BufferGeometry {
  return merge([
    box(0.94, 0.16, 0.94, 0, 0, 0, 0x39506e),
    box(0.8, 0.14, 0.8, 0, 0.16, 0, 0x4c6a92),
    cyl(0.26, 0.3, 0.1, 0, 0.3, 0, 0x2b3a50, 10),
    part(new THREE.BoxGeometry(0.44, 0.07, 0.1).translate(0, 0.43, 0), 0xf2c14e, { mode: ANIM_SPIN_Y, speed: 4, pivot: [0, 0.43, 0] }, false),
    cyl(0.06, 0.06, 0.1, 0, 0.4, 0, 0xdfe6e9, 6),
    arrow(0.2, 0.36, 0.31, 0, 0, 0xf2c14e),
    arrow(0.2, 0, 0.31, 0.36, -Math.PI / 2, 0xf2c14e),
    arrow(0.2, 0, 0.31, -0.36, Math.PI / 2, 0xf2c14e),
    box(0.1, 0.08, 0.5, -0.44, 0.12, 0, 0x2b303b),
  ]);
}

export function buildMiner(): THREE.BufferGeometry {
  const leg = (x: number, z: number) => box(0.07, 0.95, 0.07, x, 0.1, z, 0x8a5a44);
  return merge([
    box(0.9, 0.1, 0.9, -0.02, 0, 0, 0x4a4038),
    box(0.42, 0.34, 0.5, -0.2, 0.1, 0, 0xc97b5a),
    box(0.36, 0.06, 0.44, -0.2, 0.44, 0, 0x9c5a40),
    box(0.04, 0.2, 0.3, -0.42, 0.18, 0, 0x2b2f38),
    leg(-0.05, -0.28), leg(-0.05, 0.28), leg(0.3, -0.28), leg(0.3, 0.28),
    box(0.42, 0.05, 0.05, 0.125, 0.55, -0.28, 0x6e4636),
    box(0.42, 0.05, 0.05, 0.125, 0.55, 0.28, 0x6e4636),
    box(0.05, 0.05, 0.6, 0.3, 0.8, 0, 0x6e4636),
    box(0.05, 0.05, 0.6, -0.05, 0.8, 0, 0x6e4636),
    box(0.5, 0.08, 0.7, 0.125, 1.02, 0, 0x8a5a44),
    // The drill: a shaft with a bit at the bottom and a flywheel on top.
    part(new THREE.CylinderGeometry(0.05, 0.05, 0.95, 6).translate(0.125, 0.6, 0), 0xcfd6dd, { mode: ANIM_SPIN_Y, speed: 7, pivot: [0.125, 0, 0] }, false),
    part(new THREE.ConeGeometry(0.14, 0.26, 5).rotateX(Math.PI).translate(0.125, 0.2, 0), 0x9aa3ad, { mode: ANIM_SPIN_Y, speed: 7, pivot: [0.125, 0, 0] }, false),
    part(new THREE.BoxGeometry(0.34, 0.07, 0.1).translate(0.125, 1.14, 0), 0xe0a458, { mode: ANIM_SPIN_Y, speed: 7, pivot: [0.125, 0, 0] }, false),
    part(new THREE.BoxGeometry(0.1, 0.07, 0.34).translate(0.125, 1.14, 0), 0xe0a458, { mode: ANIM_SPIN_Y, speed: 7, pivot: [0.125, 0, 0] }, false),
    // A piston on the engine.
    part(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 6).translate(-0.2, 0.56, 0.12), 0xdfe6e9, { mode: ANIM_BOB, p1: 0, p2: 0.05, speed: 9 }, false),
    part(new THREE.CylinderGeometry(0.06, 0.06, 0.16, 6).translate(-0.2, 0.56, -0.12), 0xdfe6e9, { mode: ANIM_BOB, p1: 3.14, p2: 0.05, speed: 9 }, false),
    ...lamp(-0.36, 0.44, -0.18),
    ...chute(),
  ]);
}

export function buildSawmill(): THREE.BufferGeometry {
  const post = (x: number, z: number) => box(0.07, 0.62, 0.07, x, 0.1, z, 0x7a5a36);
  return merge([
    box(0.92, 0.1, 0.92, -0.02, 0, 0, 0x5b4a36),
    post(-0.4, -0.4), post(-0.4, 0.4), post(0.3, -0.4), post(0.3, 0.4),
    gable(0.86, 0.96, 0.28, -0.05, 0.72, 0, 0x4f7a4a),
    box(0.86, 0.04, 0.06, -0.05, 0.98, 0, 0x3c5e39),
    // The saw bench with a log on it.
    box(0.6, 0.2, 0.34, -0.08, 0.1, 0, 0x8a6a42),
    part(new THREE.CylinderGeometry(0.08, 0.08, 0.42, 7).rotateZ(Math.PI / 2).translate(-0.2, 0.38, 0), 0x8a5a2b, undefined, false),
    part(new THREE.CylinderGeometry(0.081, 0.081, 0.02, 7).rotateZ(Math.PI / 2).translate(0.015, 0.38, 0), 0xe3c28a, undefined, false),
    part(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 14).rotateX(Math.PI / 2).translate(0.12, 0.36, 0.1), 0xdfe6e9, { mode: ANIM_SPIN_Z, speed: 14, pivot: [0.12, 0.36, 0.1] }, false),
    part(new THREE.BoxGeometry(0.5, 0.05, 0.035).translate(0.12, 0.36, 0.1), 0x9aa3ad, { mode: ANIM_SPIN_Z, speed: 14, pivot: [0.12, 0.36, 0.1] }, false),
    // Planks stacked by the output and a sawdust pile.
    box(0.26, 0.05, 0.14, 0.14, 0.1, -0.28, 0xd9a55b),
    box(0.26, 0.05, 0.14, 0.14, 0.15, -0.28, 0xc9954b),
    part(new THREE.ConeGeometry(0.12, 0.1, 6).translate(-0.28, 0.15, 0.3), 0xe3c28a, undefined, false),
    ...lamp(-0.4, 0.72, -0.4),
    ...chute(),
  ]);
}

export function buildKiln(): THREE.BufferGeometry {
  const smoke = (phase: number) =>
    ball(0.11, -0.2, 1.22, -0.2, 0xd8d8d8, { mode: ANIM_SMOKE, p1: phase, p2: 0.75, speed: 0.45, pivot: [-0.2, 1.22, -0.2] });
  return merge([
    box(0.92, 0.12, 0.92, -0.02, 0, 0, 0x5a4a44),
    cyl(0.36, 0.42, 0.42, -0.05, 0.12, 0, 0xa64b3c, 8),
    cyl(0.4, 0.4, 0.05, -0.05, 0.3, 0, 0x8c3b2f, 8),
    cyl(0.18, 0.36, 0.26, -0.05, 0.54, 0, 0xb5543c, 8),
    cyl(0.2, 0.2, 0.05, -0.05, 0.78, 0, 0x8c3b2f, 8),
    // Chimney.
    cyl(0.09, 0.11, 0.7, -0.2, 0.5, -0.2, 0x5a4a44, 6),
    cyl(0.12, 0.12, 0.06, -0.2, 1.16, -0.2, 0x3f3531, 6),
    // The fire door glows while the kiln works.
    box(0.06, 0.26, 0.3, 0.33, 0.14, 0, 0x3a2a26),
    part(new THREE.BoxGeometry(0.04, 0.18, 0.2).translate(0.36, 0.27, 0), 0xff8a2a, { mode: ANIM_FIRE, p1: 0 }, false),
    part(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 6).translate(-0.05, 0.84, 0), 0xff6a1a, { mode: ANIM_FIRE, p1: 2 }, false),
    // A stack of bricks and a coal bin.
    box(0.2, 0.08, 0.12, -0.3, 0.12, 0.34, 0xb5543c),
    box(0.2, 0.08, 0.12, -0.27, 0.2, 0.34, 0xa64b3c),
    smoke(0), smoke(0.33), smoke(0.66),
    ...lamp(0.2, 0.12, -0.36),
    ...chute(),
  ]);
}

export function buildAssembler(): THREE.BufferGeometry {
  const armPivot: [number, number, number] = [-0.08, 0.6, 0];
  const swing = { mode: ANIM_SWING_Y, p1: 1.1, speed: 2.2, pivot: armPivot };
  return merge([
    box(0.94, 0.1, 0.94, -0.02, 0, 0, 0x3e3548),
    box(0.8, 0.34, 0.8, -0.05, 0.1, 0, 0x8d6f9c),
    box(0.84, 0.05, 0.84, -0.05, 0.44, 0, 0x6f567c),
    // Intake hoppers on both sides and the back.
    box(0.3, 0.16, 0.12, -0.05, 0.2, 0.44, 0x2b2f38),
    box(0.3, 0.16, 0.12, -0.05, 0.2, -0.44, 0x2b2f38),
    box(0.12, 0.16, 0.3, -0.48, 0.2, 0, 0x2b2f38),
    // Side panels with vents.
    box(0.02, 0.14, 0.4, 0.36, 0.2, 0, 0x5a4766),
    box(0.03, 0.03, 0.34, 0.37, 0.3, 0, 0xdfe6e9),
    box(0.03, 0.03, 0.34, 0.37, 0.24, 0, 0xdfe6e9),
    // Work table and the arm that swings over it.
    cyl(0.2, 0.22, 0.06, 0.16, 0.49, 0, 0x4a3f55, 10),
    part(new THREE.BoxGeometry(0.14, 0.05, 0.14).translate(0.16, 0.575, 0), 0x4f8fd6, { mode: ANIM_GLOW }, false),
    cyl(0.07, 0.09, 0.22, -0.08, 0.49, 0, 0xdfe6e9, 8),
    part(new THREE.BoxGeometry(0.34, 0.06, 0.07).translate(0.08, 0.74, 0), 0xe8b04a, swing, false),
    part(new THREE.BoxGeometry(0.05, 0.14, 0.05).translate(0.23, 0.66, 0), 0xdfe6e9, swing, false),
    part(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 6).translate(-0.08, 0.74, 0), 0x3a3f4b, swing, false),
    // Antenna.
    cyl(0.015, 0.015, 0.4, -0.38, 0.49, -0.36, 0xdfe6e9, 4),
    part(new THREE.IcosahedronGeometry(0.04, 0).translate(-0.38, 0.92, -0.36), 0xff5a5a, { mode: ANIM_GLOW }, false),
    ...lamp(-0.38, 0.49, 0.36),
    ...chute(),
  ]);
}

/**
 * The town hub. It grows with the town: a camp with a tent and a fire, then a
 * hamlet hall, then a village hall with a tower.
 */
export function buildHub(stage: number): THREE.BufferGeometry {
  const crate = (x: number, z: number, s = 0.26) => box(s, s, s, x, 0.12, z, 0xb08a54);
  const window = (x: number, y: number, z: number, w: number, d: number) =>
    part(new THREE.BoxGeometry(w, 0.2, d).translate(x, y, z), 0xffd27a, { mode: ANIM_GLOW }, false);
  const flag = (x: number, y: number, z: number) => [
    cyl(0.03, 0.03, 1.0, x, y, z, 0x4a3f3b, 5),
    part(new THREE.BoxGeometry(0.42, 0.24, 0.02, 6, 1, 1).translate(x + 0.23, y + 0.85, z), 0x4f8fd6, { mode: ANIM_FLAG, pivot: [x, 0, z] }, false),
  ];
  const yard = [
    box(2.96, 0.12, 2.96, 0, 0, 0, 0xcdb88a),
    box(2.7, 0.03, 2.7, 0, 0.12, 0, 0xdccb9f),
  ];
  // Delivery bays: a dark mat on each side where belts come in.
  const bays = [
    box(0.5, 0.02, 0.24, 0, 0.15, 1.34, 0x5a4a44),
    box(0.5, 0.02, 0.24, 0, 0.15, -1.34, 0x5a4a44),
    box(0.24, 0.02, 0.5, 1.34, 0.15, 0, 0x5a4a44),
    box(0.24, 0.02, 0.5, -1.34, 0.15, 0, 0x5a4a44),
  ];
  if (stage === 0) {
    const fire: Motion = { mode: ANIM_FIRE, p1: 1 };
    return merge([
      ...yard, ...bays,
      // A big tent.
      gable(1.5, 1.5, 0.95, -0.35, 0.15, -0.3, 0xe9dcc0),
      box(0.04, 1.0, 0.04, -1.1, 0.15, -0.3, 0x6b4a2b),
      box(0.04, 1.0, 0.04, 0.4, 0.15, -0.3, 0x6b4a2b),
      box(0.03, 0.6, 0.5, 0.41, 0.15, -0.3, 0x6b4a2b),
      // Campfire: stones, logs and a flame.
      cyl(0.26, 0.28, 0.06, 0.75, 0.15, 0.7, 0x8f8f8f, 8),
      part(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 5).rotateZ(Math.PI / 2).translate(0.75, 0.24, 0.7), 0x6b4a2b, undefined, false),
      part(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 5).rotateX(Math.PI / 2).translate(0.75, 0.27, 0.7), 0x5a3d22, undefined, false),
      part(new THREE.ConeGeometry(0.11, 0.3, 5).translate(0.75, 0.44, 0.7), 0xff8a2a, fire, false),
      part(new THREE.ConeGeometry(0.06, 0.2, 5).translate(0.75, 0.42, 0.7), 0xffd27a, fire, false),
      ball(0.08, 0.75, 0.7, 0.7, 0xd0d0d0, { mode: ANIM_SMOKE, p1: 0, p2: 0.9, speed: 0.4, pivot: [0.75, 0.7, 0.7] }),
      ball(0.08, 0.75, 0.7, 0.7, 0xd0d0d0, { mode: ANIM_SMOKE, p1: 0.5, p2: 0.9, speed: 0.4, pivot: [0.75, 0.7, 0.7] }),
      // Log seats, crates and barrels.
      part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 6).rotateX(Math.PI / 2).translate(1.1, 0.24, 0.7), 0x8a5a2b, undefined, false),
      part(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 6).rotateZ(Math.PI / 2).translate(0.75, 0.24, 1.08), 0x8a5a2b, undefined, false),
      crate(-0.9, 0.85), crate(-0.6, 0.9, 0.22), crate(-0.82, 0.86, 0.2),
      cyl(0.12, 0.12, 0.3, 0.95, 0.15, -0.9, 0x7a5a36, 8),
      cyl(0.12, 0.12, 0.3, 0.7, 0.15, -1.0, 0x8a6a42, 8),
      ...flag(-1.1, 0.15, 0.95),
    ]);
  }
  if (stage === 1) {
    return merge([
      ...yard, ...bays,
      // A timber hall on a stone footing.
      box(1.9, 0.2, 1.5, -0.1, 0.15, -0.15, 0x9a9a94),
      box(1.8, 0.75, 1.4, -0.1, 0.35, -0.15, 0xf0e2c0),
      box(1.84, 0.07, 0.07, -0.1, 0.7, 0.55, 0x6b4a2b),
      box(0.07, 0.75, 0.07, -0.98, 0.35, 0.55, 0x6b4a2b),
      box(0.07, 0.75, 0.07, 0.78, 0.35, 0.55, 0x6b4a2b),
      box(0.07, 0.75, 0.07, -0.1, 0.35, 0.55, 0x6b4a2b),
      gable(2.0, 1.7, 0.75, -0.1, 1.1, -0.15, 0xb5543c),
      box(2.04, 0.06, 0.1, -0.1, 1.82, -0.15, 0x8c3b2f),
      box(0.34, 0.5, 0.06, -0.5, 0.35, 0.56, 0x6b4a2b),
      window(0.35, 0.72, 0.56, 0.26, 0.04), window(-0.1, 0.72, -0.86, 0.26, 0.04), window(0.81, 0.72, -0.15, 0.04, 0.3),
      cyl(0.13, 0.15, 0.7, 0.45, 1.3, -0.5, 0x8f8f8f, 6),
      ball(0.09, 0.45, 2.05, -0.5, 0xd0d0d0, { mode: ANIM_SMOKE, p1: 0, p2: 0.8, speed: 0.35, pivot: [0.45, 2.05, -0.5] }),
      ball(0.09, 0.45, 2.05, -0.5, 0xd0d0d0, { mode: ANIM_SMOKE, p1: 0.5, p2: 0.8, speed: 0.35, pivot: [0.45, 2.05, -0.5] }),
      // A shed and the yard's stores.
      box(0.7, 0.45, 0.6, 0.95, 0.15, 0.95, 0xd9c08a),
      gable(0.8, 0.74, 0.3, 0.95, 0.6, 0.95, 0x8c3b2f),
      crate(-1.05, 1.0), crate(-0.76, 1.05, 0.22), crate(-0.98, 1.0, 0.2),
      cyl(0.12, 0.12, 0.3, -0.3, 0.15, 1.1, 0x7a5a36, 8),
      // A well.
      cyl(0.2, 0.2, 0.22, 1.05, 0.15, -1.0, 0x9a9a94, 8),
      box(0.04, 0.5, 0.04, 0.87, 0.15, -1.0, 0x6b4a2b),
      box(0.04, 0.5, 0.04, 1.23, 0.15, -1.0, 0x6b4a2b),
      gable(0.5, 0.4, 0.16, 1.05, 0.65, -1.0, 0x6b4a2b),
      ...flag(-1.25, 0.15, -1.2),
    ]);
  }
  return merge([
    ...yard, ...bays,
    // A two-storey hall with a clock tower.
    box(2.1, 0.22, 1.7, -0.15, 0.15, -0.1, 0x9a9a94),
    box(2.0, 0.7, 1.6, -0.15, 0.37, -0.1, 0xf0e2c0),
    box(2.06, 0.08, 1.66, -0.15, 1.07, -0.1, 0x6b4a2b),
    box(1.9, 0.55, 1.5, -0.15, 1.15, -0.1, 0xf5ead0),
    gable(2.15, 1.75, 0.7, -0.15, 1.7, -0.1, 0xb5543c),
    box(2.2, 0.06, 0.1, -0.15, 2.38, -0.1, 0x8c3b2f),
    box(0.4, 0.55, 0.06, -0.15, 0.37, 0.71, 0x6b4a2b),
    window(-0.75, 0.75, 0.71, 0.26, 0.04), window(0.45, 0.75, 0.71, 0.26, 0.04),
    window(-0.75, 1.42, 0.66, 0.24, 0.04), window(-0.15, 1.42, 0.66, 0.24, 0.04), window(0.45, 1.42, 0.66, 0.24, 0.04),
    window(0.86, 0.75, -0.1, 0.04, 0.3), window(0.81, 1.42, -0.1, 0.04, 0.3),
    // Tower.
    box(0.62, 2.3, 0.62, 0.95, 0.15, -0.95, 0xe6d8b4),
    box(0.7, 0.08, 0.7, 0.95, 2.45, -0.95, 0x6b4a2b),
    part(new THREE.ConeGeometry(0.52, 0.7, 4).rotateY(Math.PI / 4).translate(0.95, 2.88, -0.95), 0x8c3b2f, undefined, false),
    part(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 12).rotateX(Math.PI / 2).translate(0.95, 2.05, -0.63), 0xfff6dc, { mode: ANIM_GLOW }, false),
    cyl(0.13, 0.15, 0.6, -0.8, 2.0, -0.5, 0x8f8f8f, 6),
    ball(0.09, -0.8, 2.65, -0.5, 0xd0d0d0, { mode: ANIM_SMOKE, p1: 0, p2: 0.8, speed: 0.35, pivot: [-0.8, 2.65, -0.5] }),
    ball(0.09, -0.8, 2.65, -0.5, 0xd0d0d0, { mode: ANIM_SMOKE, p1: 0.5, p2: 0.8, speed: 0.35, pivot: [-0.8, 2.65, -0.5] }),
    // Market stalls and stores in the yard.
    box(0.6, 0.3, 0.4, -1.0, 0.15, 1.05, 0x8a6a42),
    gable(0.74, 0.56, 0.2, -1.0, 0.72, 1.05, 0x4f8fd6),
    box(0.04, 0.57, 0.04, -1.3, 0.15, 0.85, 0x6b4a2b), box(0.04, 0.57, 0.04, -0.7, 0.15, 0.85, 0x6b4a2b),
    box(0.04, 0.57, 0.04, -1.3, 0.15, 1.25, 0x6b4a2b), box(0.04, 0.57, 0.04, -0.7, 0.15, 1.25, 0x6b4a2b),
    crate(0.5, 1.1), crate(0.8, 1.05, 0.22), crate(0.58, 1.08, 0.2),
    cyl(0.12, 0.12, 0.3, 1.15, 0.15, 0.9, 0x7a5a36, 8),
    cyl(0.2, 0.2, 0.22, -1.1, 0.15, -1.05, 0x9a9a94, 8),
    ...flag(0.95, 3.2, -0.95),
  ]);
}

// ---- items ---------------------------------------------------------------------

export type ItemShape = 'chunk' | 'log' | 'plank' | 'plate' | 'brick' | 'crate' | 'coil';

export function buildItemShape(shape: ItemShape): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (shape) {
    case 'chunk':
      g = new THREE.DodecahedronGeometry(0.105, 0).scale(1, 0.8, 1).translate(0, 0.02, 0);
      break;
    case 'log':
      g = new THREE.CylinderGeometry(0.06, 0.06, 0.24, 7).rotateZ(Math.PI / 2);
      break;
    case 'plank':
      g = new THREE.BoxGeometry(0.24, 0.05, 0.13).translate(0, -0.03, 0);
      break;
    case 'plate':
      g = new THREE.BoxGeometry(0.2, 0.035, 0.2).translate(0, -0.04, 0);
      break;
    case 'brick':
      g = new THREE.BoxGeometry(0.19, 0.09, 0.12).translate(0, -0.015, 0);
      break;
    case 'crate':
      g = new THREE.BoxGeometry(0.17, 0.15, 0.17).translate(0, 0.015, 0);
      break;
    case 'coil':
      g = new THREE.TorusGeometry(0.075, 0.035, 5, 10).rotateX(Math.PI / 2);
      break;
  }
  const flat = g.index ? g.toNonIndexed() : g;
  flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  return flat;
}

// ---- scenery -------------------------------------------------------------------

const sway: Motion = { mode: ANIM_SWAY };

export function buildPine(variant: number): THREE.BufferGeometry {
  const tall = variant === 0;
  const green = tall ? 0x2f6b3a : 0x3d7a3f;
  const layer = (r: number, h: number, y: number, c: number) =>
    part(new THREE.ConeGeometry(r, h, 6).translate(0, y + h / 2, 0), c, sway, false);
  return merge([
    part(new THREE.CylinderGeometry(0.035, 0.05, 0.2, 5).translate(0, 0.1, 0), 0x5e4127, undefined, false),
    layer(0.2, 0.26, 0.14, green),
    layer(0.15, 0.24, 0.3, tall ? 0x37783f : 0x478a45),
    ...(tall ? [layer(0.1, 0.22, 0.46, 0x418848)] : []),
  ]);
}

export function buildRoundTree(): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(0.035, 0.05, 0.26, 5).translate(0, 0.13, 0), 0x6b4a2b, undefined, false),
    part(new THREE.IcosahedronGeometry(0.2, 0).scale(1, 0.9, 1).translate(0, 0.4, 0), 0x5f9a48, sway, false),
    part(new THREE.IcosahedronGeometry(0.13, 0).translate(0.1, 0.52, 0.05), 0x6fae52, sway, false),
  ]);
}

export function buildBush(): THREE.BufferGeometry {
  return merge([
    part(new THREE.IcosahedronGeometry(0.12, 0).scale(1, 0.7, 1).translate(0, 0.07, 0), 0x4f8a45, sway, false),
    part(new THREE.IcosahedronGeometry(0.08, 0).scale(1, 0.7, 1).translate(0.11, 0.05, 0.04), 0x5f9a48, sway, false),
  ]);
}

export function buildTuft(): THREE.BufferGeometry {
  const blade = (angle: number, lean: number) =>
    part(new THREE.ConeGeometry(0.02, 0.16, 3).translate(0, 0.08, 0).rotateZ(lean).rotateY(angle), 0x7fb45a, sway, false);
  return merge([blade(0, 0.3), blade(2.1, 0.35), blade(4.2, 0.25), blade(1, -0.1)]);
}

/** A rock. White, so each instance can be tinted with its ore's colour. */
export function buildRock(): THREE.BufferGeometry {
  return merge([
    part(new THREE.DodecahedronGeometry(0.15, 0).scale(1, 0.7, 0.9).translate(0, 0.06, 0), 0xffffff, undefined, false),
    part(new THREE.DodecahedronGeometry(0.08, 0).scale(1, 0.8, 1).translate(0.14, 0.03, 0.08), 0xe0e0e0, undefined, false),
  ]);
}

export function buildStump(): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(0.07, 0.08, 0.08, 6).translate(0, 0.04, 0), 0x6b4a2b, undefined, false),
    part(new THREE.CylinderGeometry(0.06, 0.06, 0.01, 6).translate(0, 0.085, 0), 0xd9b77a, undefined, false),
  ]);
}
