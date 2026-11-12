// The top-down camera rig: pan, zoom, and rotate in quarter turns. Tilt is fixed
// so the grid stays legible.

import * as THREE from 'three';

const TILT = THREE.MathUtils.degToRad(38); // from straight down
const MIN_DISTANCE = 7;
const MAX_DISTANCE = 150;

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.5, 1200);
  readonly target = new THREE.Vector3();
  distance = 34;
  private goalDistance = 34;
  private quarterTurns = 0;
  private yaw = 0;
  /** Map limits the target is kept inside. */
  min = 0;
  max = 1;

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  rotate(direction: 1 | -1): void {
    this.quarterTurns += direction;
  }

  zoom(factor: number): void {
    this.goalDistance = THREE.MathUtils.clamp(this.goalDistance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** Moves the target across the ground. `right` and `forward` are in screen terms. */
  pan(right: number, forward: number): void {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.target.x += right * cos - forward * sin;
    this.target.z += -right * sin - forward * cos;
    this.clamp();
  }

  private clamp(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, this.min, this.max);
    this.target.z = THREE.MathUtils.clamp(this.target.z, this.min, this.max);
  }

  update(dt: number): void {
    const ease = 1 - Math.exp(-dt * 12);
    this.yaw += (this.quarterTurns * (Math.PI / 2) - this.yaw) * ease;
    this.distance += (this.goalDistance - this.distance) * ease;
    this.clamp();
    const horizontal = Math.sin(TILT) * this.distance;
    const height = Math.cos(TILT) * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horizontal,
      height,
      this.target.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.target);
  }
}
