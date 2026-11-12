// Every model is assembled in code from boxes, cylinders and cones. There are
// no asset files. Models face +X: that is the side a building pushes items out of.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingKey } from '../content/content';

const scratch = new THREE.Color();

function paint(geometry: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  scratch.setHex(color);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), color);
}

function cylinder(r: number, h: number, x: number, y: number, z: number, color: number, sides = 10): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(r, r, h, sides).translate(x, y + h / 2, z), color);
}

/** A flat arrowhead lying on a surface, pointing along `angle` (0 is +X). */
function arrow(size: number, x: number, y: number, z: number, angle: number, color: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(size * 0.6, size, 3);
  g.rotateZ(-Math.PI / 2);
  g.scale(1, 0.12, 1);
  g.rotateY(angle);
  g.translate(x, y, z);
  return paint(g, color);
}

/** The chute that marks a building's output side. */
function chute(color = 0xf2c14e): THREE.BufferGeometry {
  return box(0.2, 0.18, 0.34, 0.42, 0.1, 0, color);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Could not merge model parts.');
  for (const p of parts) p.dispose();
  return merged;
}

export function buildModel(key: BuildingKey): THREE.BufferGeometry {
  switch (key) {
    case 'belt':
      return merge([
        box(1, 0.08, 0.84, 0, 0, 0, 0x2f3542),
        box(1, 0.14, 0.07, 0, 0, 0.42, 0x596275),
        box(1, 0.14, 0.07, 0, 0, -0.42, 0x596275),
        arrow(0.3, 0.05, 0.09, 0, 0, 0x7f8aa0),
      ]);
    case 'splitter':
      return merge([
        box(0.92, 0.2, 0.92, 0, 0, 0, 0x4c6a92),
        box(0.5, 0.1, 0.5, 0, 0.2, 0, 0x34495e),
        arrow(0.26, 0.3, 0.22, 0, 0, 0xf2c14e),
        arrow(0.26, 0, 0.22, 0.3, -Math.PI / 2, 0xf2c14e),
        arrow(0.26, 0, 0.22, -0.3, Math.PI / 2, 0xf2c14e),
      ]);
    case 'miner':
      return merge([
        box(0.78, 0.42, 0.78, -0.04, 0, 0, 0xc97b5a),
        cylinder(0.2, 0.5, -0.04, 0.42, 0, 0x3a3f4b, 8),
        cylinder(0.3, 0.08, -0.04, 0.9, 0, 0xe0a458, 8),
        chute(),
      ]);
    case 'sawmill':
      return merge([
        box(0.8, 0.36, 0.8, -0.04, 0, 0, 0x7da568),
        box(0.5, 0.3, 0.7, -0.1, 0.36, 0, 0x5d8050),
        paint(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12).rotateX(Math.PI / 2).translate(0.2, 0.52, 0), 0xdfe6e9),
        chute(),
      ]);
    case 'kiln':
      return merge([
        box(0.8, 0.5, 0.8, -0.04, 0, 0, 0xa64b3c),
        box(0.6, 0.2, 0.6, -0.04, 0.5, 0, 0x8c3b2f),
        cylinder(0.14, 0.6, -0.2, 0.7, -0.15, 0x4a3f3b, 8),
        box(0.06, 0.22, 0.3, 0.37, 0.14, 0, 0xffb347),
        chute(),
      ]);
    case 'assembler':
      return merge([
        box(0.84, 0.4, 0.84, -0.04, 0, 0, 0x9a79a8),
        box(0.56, 0.24, 0.56, -0.04, 0.4, 0, 0x7b5f8a),
        cylinder(0.08, 0.3, -0.04, 0.64, 0, 0xdfe6e9, 6),
        box(0.4, 0.06, 0.06, 0.02, 0.9, 0, 0xdfe6e9),
        chute(),
      ]);
    case 'hub':
      return merge([
        box(2.9, 0.3, 2.9, 0, 0, 0, 0xd9c08a),
        box(1.9, 0.9, 1.9, 0, 0.3, 0, 0xf0e2c0),
        paint(new THREE.ConeGeometry(1.5, 0.9, 4).rotateY(Math.PI / 4).translate(0, 1.65, 0), 0xb5543c),
        cylinder(0.04, 1.1, 0.9, 1.2, 0.9, 0x4a3f3b, 6),
        box(0.4, 0.24, 0.03, 1.1, 2.0, 0.9, 0x4f8fd6),
        box(0.5, 0.5, 0.06, 0, 0.3, 0.96, 0x6b4a2b),
      ]);
  }
}

export function buildItemGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(0.2, 0.14, 0.2);
}

export function buildTreeGeometry(): THREE.BufferGeometry {
  return merge([
    cylinder(0.05, 0.14, 0, 0, 0, 0x6b4a2b, 5),
    paint(new THREE.ConeGeometry(0.22, 0.42, 6).translate(0, 0.35, 0), 0x2f6b3a),
  ]);
}

export function buildRockGeometry(): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(0.17, 0);
  g.scale(1, 0.7, 1);
  g.translate(0, 0.07, 0);
  return paint(g, 0xffffff);
}
