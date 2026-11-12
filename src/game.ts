// Ties the pieces together: turns input into commands, runs the fixed-rate
// simulation loop, asks the renderer to draw, and publishes a small summary for
// the interface a few times a second.

import {
  BUILDINGS, BUILDING_BY_ID, FINAL_STAGE, GOALS, ITEMS, ITEM_BY_ID, ITEM_BY_KEY, RECIPE_BY_ID, RECIPE_BY_KEY, TECHS, TECH_BY_ID, TECH_BY_KEY,
  TICKS_PER_SECOND, buildingId, type BuildingDef,
} from './content/content';
import { GameRenderer } from './render/renderer';
import {
  DX, DY, HUB_X, HUB_Y, ROLE_HUB, ROLE_MACHINE, ROLE_MINER, STATUS_BLOCKED, STATUS_IDLE, STATUS_STARVED, STATUS_WORKING,
  Sim, loadSim, saveSim,
} from './sim';
import { readSave, writeSave } from './storage';
import type { AgentHost, StagedStep } from './agent/tools';
import { History } from './history';

const MAX_TICKS_PER_FRAME = 8;
/** While an AI player waits, time may run faster than a person would want to watch. */
const MAX_AI_TICKS_PER_FRAME = 64;
const AUTOSAVE_SECONDS = 30;
const AUTOSAVE_KEY = 'autosave';
const BELT = buildingId('belt');

// How the AI player's hand moves when it places things. Times are real seconds.
const HAND_CARRY_HEIGHT = 0.9;
const HAND_DRAG_HEIGHT = 0.22;
const HAND_DROP_SECONDS = 0.12;
const HAND_LINGER_SECONDS = 0.7;
/** A long belt is dragged out in about this long, however many tiles it has. */
const HAND_RUN_SECONDS = 1.6;
const PLACE_COLOR = 0xc9a6ff;
const REMOVE_COLOR = 0xff6b6b;

interface HandStage {
  steps: StagedStep[];
  apply: (index: number) => void;
  resolve: () => void;
  index: number;
  /** 'carry' brings the hand over the tile, 'drop' lowers the building onto it. */
  phase: 'carry' | 'drop';
  t: number;
  duration: number;
  fromX: number;
  fromZ: number;
  fromLift: number;
  toLift: number;
}

export type Tool = { mode: 'none' } | { mode: 'build'; building: number } | { mode: 'delete' } | { mode: 'copy' } | { mode: 'paste' };

/** A copied group of buildings, as offsets from the middle of the copied area. */
interface Clip {
  building: number;
  dx: number;
  dy: number;
  dir: number;
  recipe: number;
}

export interface UiNeed {
  name: string;
  color: string;
  have: number;
  need: number;
  /** The row is a rate per minute the hub must keep receiving, not a one-off count. */
  perMinute?: boolean;
}

export interface UiState {
  ready: boolean;
  speed: number;
  paused: boolean;
  /** An AI player is in control of the clock. */
  aiActive: boolean;
  seconds: number;
  stage: string;
  goalNumber: number;
  goalCount: number;
  goalTitle: string;
  goalText: string;
  needs: UiNeed[];
  /** Set while the current list is a gate: seconds held so far, seconds asked, and whether the count is moving. */
  gate: { held: number; hold: number; running: boolean } | null;
  /** What the town takes from the hub's stock, and whether it just went without. */
  uses: { name: string; color: string; perMinute: number; short: boolean }[];
  /** Techs the town could learn at this stage and has not yet. */
  techs: {
    id: number;
    name: string;
    text: string;
    cost: { name: string; color: string; count: number; enough: boolean }[];
    /** Empty when it can be bought now; otherwise what it is waiting on. */
    blocked: string;
  }[];
  /** What the hub received over the last minute. */
  arriving: { name: string; color: string; perMinute: number }[];
  rewards: string[];
  won: boolean;
  stock: { name: string; color: string; count: number }[];
  buildBar: {
    id: number;
    name: string;
    color: string;
    hint: string;
    hotkey: string;
    affordable: boolean;
    cost: { name: string; color: string; count: number; enough: boolean }[];
  }[];
  tool: Tool;
  canUndo: boolean;
  canRedo: boolean;
  /** How many buildings are on the clipboard. */
  clipboard: number;
  /** The tool's facing as it appears on screen: 0 right, 1 down, 2 left, 3 up. */
  toolDir: number;
  hover: string;
  selected: null | {
    x: number;
    y: number;
    name: string;
    status: string;
    statusKind: 'ok' | 'warn' | 'bad' | 'idle';
    detail: string[];
    recipe: number;
    recipes: { id: number; name: string; text: string }[];
  };
  toasts: { id: number; text: string }[];
  message: string;
  perf: { tickMs: number; frameMs: number; drawCalls: number; items: number; buildings: number; fps: number };
}

function hex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

function recipeText(id: number): string {
  const r = RECIPE_BY_ID[id];
  if (!r) return '';
  const ins = r.inputs.map((i) => `${i.count} ${ITEM_BY_KEY.get(i.item)?.name ?? i.item}`).join(' + ');
  return `${ins} → ${r.output.count} ${ITEM_BY_KEY.get(r.output.item)?.name ?? r.output.item} (${r.seconds}s)`;
}

export class Game {
  sim: Sim;
  readonly renderer: GameRenderer;
  private readonly canvas: HTMLCanvasElement;

  speed = 1;
  paused = false;
  private accumulator = 0;

  // ---- AI player: it owns the clock while it plays. Time stands still while
  // the model is deciding and runs fast while it waits on the factory. ----
  aiActive = false;
  private aiSpeed = 8;
  private aiFollow = true;
  private aiWait: { remaining: number; shouldStop: () => boolean; resolve: () => void } | null = null;
  private aiAnimate = true;
  private readonly aiHand = { x: HUB_X + 0.5, z: HUB_Y + 0.5, lift: 0 };
  private aiStage: HandStage | null = null;
  private aiHandIdle = HAND_LINGER_SECONDS;
  private aiCameraGoal: { x: number; z: number } | null = null;
  private lastFrame = 0;

  tool: Tool = { mode: 'none' };
  toolDir = 0;
  private hover: { x: number; y: number } | null = null;
  private selected: { x: number; y: number } | null = null;
  private readonly keys = new Set<string>();
  private readonly history = new History(() => this.sim);
  private clipboard: Clip[] = [];
  /** Quarter turns applied to the clipboard before it is pasted. */
  private pasteTurns = 0;
  /** The rectangle being dragged out with the copy tool. */
  private copyArea: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  private drag: { button: number; last: { x: number; y: number } | null; panX: number; panY: number } | null = null;

  private toasts: { id: number; text: string; until: number }[] = [];
  private toastId = 0;
  private message = '';
  private messageUntil = 0;
  private won = false;
  private sinceAutosave = 0;
  private sincePublish = 1;

  private tickMs = 0;
  private frameMs = 0;
  private fps = 60;

  private state: UiState;
  private readonly listeners = new Set<() => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.sim = new Sim({ seed: (Date.now() & 0x7fffffff) | 1 });
    this.renderer = new GameRenderer(canvas, this.sim);
    this.centreCamera();
    this.state = this.snapshot(false);
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Loads the autosave if there is one, then starts the loop. */
  async start(): Promise<void> {
    try {
      const data = await readSave(AUTOSAVE_KEY);
      if (data) {
        this.useSim(loadSim(data));
        this.toast('Continued from your last session.');
      }
    } catch (error) {
      this.toast(`Could not load the last session: ${(error as Error).message}`);
    }
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.save(AUTOSAVE_KEY, false);
    });
  }

  private useSim(sim: Sim): void {
    this.sim = sim;
    this.renderer.setSim(sim);
    this.history.clear();
    this.selected = null;
    this.accumulator = 0;
    this.won = sim.goalIndex >= GOALS.length;
    this.centreCamera();
  }

  private centreCamera(): void {
    this.renderer.rig.target.set(HUB_X + 0.5, 0, HUB_Y + 0.5);
  }

  private resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  // ---- the loop --------------------------------------------------------------

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const frameStart = performance.now();

    this.panFromKeys(dt);

    // Commands apply even while paused, so you can build with time stopped.
    this.sim.applyQueued();
    let running = !this.paused;
    if (this.aiActive) {
      running = this.stepForAgent(dt);
    } else if (!this.paused) {
      this.accumulator += dt * TICKS_PER_SECOND * this.speed;
      // If ticks run long the game slows down instead of trying to catch up.
      if (this.accumulator > MAX_TICKS_PER_FRAME) this.accumulator = MAX_TICKS_PER_FRAME;
      while (this.accumulator >= 1) {
        const start = performance.now();
        this.sim.step();
        this.tickMs += (performance.now() - start - this.tickMs) * 0.05;
        this.accumulator -= 1;
      }
    }
    this.drainEvents();

    this.updateAiHand(dt);
    this.updateGhost();
    this.renderer.render(running ? this.accumulator : 0, dt);

    this.frameMs += (performance.now() - frameStart - this.frameMs) * 0.05;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    this.sinceAutosave += dt;
    if (this.sinceAutosave >= AUTOSAVE_SECONDS) {
      this.sinceAutosave = 0;
      void this.save(AUTOSAVE_KEY, false);
    }
    this.sincePublish += dt;
    if (this.sincePublish >= 0.2) {
      this.sincePublish = 0;
      this.publish();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Runs the ticks an AI player is waiting for. Returns whether time moved. */
  private stepForAgent(dt: number): boolean {
    const wait = this.aiWait;
    if (!wait || this.paused) {
      this.accumulator = 0;
      return false;
    }
    this.accumulator = Math.min(MAX_AI_TICKS_PER_FRAME, this.accumulator + dt * TICKS_PER_SECOND * this.aiSpeed);
    while (this.accumulator >= 1 && wait.remaining > 0 && !wait.shouldStop()) {
      const start = performance.now();
      this.sim.step();
      this.tickMs += (performance.now() - start - this.tickMs) * 0.05;
      this.accumulator -= 1;
      wait.remaining--;
    }
    if (wait.remaining <= 0 || wait.shouldStop()) {
      this.aiWait = null;
      this.accumulator = 0;
      wait.resolve();
    }
    return true;
  }

  /** The game as an AI player reaches it: the same simulation the person sees. */
  agentHost(): AgentHost {
    return {
      sim: () => this.sim,
      advance: (ticks, shouldStop) =>
        new Promise<void>((resolve) => {
          if (!this.aiActive || ticks <= 0) resolve();
          else this.aiWait = { remaining: ticks, shouldStop, resolve };
        }),
      focus: (x, y) => {
        if (this.aiFollow) this.aiCameraGoal = { x: x + 0.5, z: y + 0.5 };
      },
      stage: (steps, apply) => this.stage(steps, apply),
    };
  }

  /**
   * Acts out a run of placements or removals: the hand carries each building
   * to its tile and drops it, and a run of neighbouring tiles is dragged out in
   * one sweep. Each step takes effect as it lands.
   */
  private stage(steps: StagedStep[], apply: (index: number) => void): Promise<void> {
    if (!this.aiActive || !this.aiAnimate || steps.length === 0) {
      for (let i = 0; i < steps.length; i++) apply(i);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.aiStage = { steps, apply, resolve, index: 0, phase: 'carry', t: 0, duration: 0, fromX: 0, fromZ: 0, fromLift: 0, toLift: 0 };
      this.beginCarry(this.aiStage);
    });
  }

  /** Whether step `index` continues a drag from the step before it. */
  private isDrag(stage: HandStage, index: number): boolean {
    const a = stage.steps[index - 1];
    const b = stage.steps[index];
    return a !== undefined && a.building === b.building && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  }

  private beginCarry(stage: HandStage): void {
    const step = stage.steps[stage.index];
    const hand = this.aiHand;
    const drag = this.isDrag(stage, stage.index);
    const distance = Math.hypot(step.x + 0.5 - hand.x, step.y + 0.5 - hand.z);
    stage.phase = 'carry';
    stage.t = 0;
    stage.fromX = hand.x;
    stage.fromZ = hand.z;
    stage.fromLift = hand.lift;
    stage.toLift = drag ? HAND_DRAG_HEIGHT : HAND_CARRY_HEIGHT;
    stage.duration = drag
      ? Math.min(0.06, Math.max(0.02, HAND_RUN_SECONDS / stage.steps.length))
      : Math.min(0.7, Math.max(0.28, 0.24 + distance * 0.018));
  }

  private updateAiHand(dt: number): void {
    const hand = this.aiHand;
    let budget = dt;
    while (this.aiStage && budget >= 0) {
      const stage = this.aiStage;
      const step = stage.steps[stage.index];
      const use = Math.min(budget, stage.duration - stage.t);
      stage.t += use;
      budget -= use;
      const k = stage.duration > 0 ? Math.min(1, stage.t / stage.duration) : 1;
      const ease = k * k * (3 - 2 * k);
      hand.x = stage.fromX + (step.x + 0.5 - stage.fromX) * ease;
      hand.z = stage.fromZ + (step.y + 0.5 - stage.fromZ) * ease;
      hand.lift = stage.fromLift + (stage.toLift - stage.fromLift) * ease;
      if (k < 1) break;
      if (stage.phase === 'carry') {
        stage.phase = 'drop';
        stage.t = 0;
        stage.fromX = hand.x;
        stage.fromZ = hand.z;
        stage.fromLift = hand.lift;
        stage.toLift = 0;
        stage.duration = this.isDrag(stage, stage.index) ? 0 : HAND_DROP_SECONDS;
        continue;
      }
      // Landed: this is the moment the building appears.
      stage.apply(stage.index);
      this.renderer.pulse(step.x, step.y, step.building ? PLACE_COLOR : REMOVE_COLOR);
      stage.index++;
      if (stage.index < stage.steps.length) {
        this.beginCarry(stage);
      } else {
        this.aiStage = null;
        this.aiHandIdle = 0;
        stage.resolve();
      }
    }

    const stage = this.aiStage;
    if (stage) {
      const step = stage.steps[stage.index];
      this.renderer.setAiHand({ x: hand.x, z: hand.z, lift: hand.lift, building: step.building, dir: step.dir, tileX: step.x, tileY: step.y });
      if (this.aiFollow) this.aiCameraGoal = { x: hand.x, z: hand.z };
    } else {
      this.aiHandIdle += dt;
      // The empty hand rests where it last put something down, then goes away.
      if (this.aiActive && this.aiHandIdle < HAND_LINGER_SECONDS) {
        this.renderer.setAiHand({ x: hand.x, z: hand.z, lift: 0, building: 0, dir: 0, tileX: Math.floor(hand.x), tileY: Math.floor(hand.z) });
      } else {
        this.renderer.setAiHand(null);
      }
    }

    // The camera glides after the hand instead of jumping to it.
    const goal = this.aiCameraGoal;
    if (goal) {
      const target = this.renderer.rig.target;
      const ease = 1 - Math.exp(-dt * 5);
      target.x += (goal.x - target.x) * ease;
      target.z += (goal.z - target.z) * ease;
      if (!this.aiStage && Math.hypot(goal.x - target.x, goal.z - target.z) < 0.05) this.aiCameraGoal = null;
    }
  }

  /** Lands everything still in the hand at once, so a stopped session leaves nothing half done. */
  private finishStage(): void {
    const stage = this.aiStage;
    if (!stage) return;
    this.aiStage = null;
    for (let i = stage.index; i < stage.steps.length; i++) stage.apply(i);
    stage.resolve();
  }

  setAiActive(active: boolean): void {
    this.aiActive = active;
    // The AI builds without going through the history, so earlier steps no longer line up.
    this.history.clear();
    if (!active) {
      this.finishStage();
      this.aiCameraGoal = null;
    }
    this.accumulator = 0;
    if (!active && this.aiWait) {
      const wait = this.aiWait;
      this.aiWait = null;
      wait.resolve();
    }
    if (active) this.paused = false;
    this.publish();
  }

  setAiOptions(speed: number, follow: boolean, animate: boolean): void {
    this.aiSpeed = speed;
    this.aiFollow = follow;
    this.aiAnimate = animate;
    if (!follow) this.aiCameraGoal = null;
  }

  private drainEvents(): void {
    if (this.sim.events.length === 0) return;
    for (const event of this.sim.events) {
      if (event.type === 'won') {
        this.won = true;
        continue;
      }
      if (event.type === 'tech') {
        this.toast(`The town learned: ${TECH_BY_ID[event.id]?.name}.`);
        continue;
      }
      const gained = this.rewardNames(event.index);
      const next = GOALS[event.index + 1]?.stage ?? FINAL_STAGE;
      this.toast(gained.length ? `The town is now a ${next.toLowerCase()}. Opened: ${gained.join(', ')}.` : `The town is now a ${next.toLowerCase()}.`);
    }
    this.sim.events = [];
    this.sincePublish = 1;
  }

  private rewardNames(goalIndex: number): string[] {
    const unlocks = GOALS[goalIndex]?.unlocks;
    if (!unlocks) return [];
    const names: string[] = [];
    for (const key of unlocks.buildings ?? []) names.push(BUILDINGS.find((b) => b.key === key)?.name ?? key);
    for (const key of unlocks.recipes ?? []) names.push(`${RECIPE_BY_KEY.get(key)?.name ?? key} recipe`);
    for (const key of unlocks.resources ?? []) names.push(`${ITEM_BY_KEY.get(key)?.name ?? key} deposits`);
    if (unlocks.growMap) names.push('more land');
    return names;
  }

  // ---- actions the interface can call -----------------------------------------

  setTool(tool: Tool): void {
    if (tool.mode === 'paste' && this.clipboard.length === 0) {
      this.warn('Nothing copied yet. Press C and drag over some buildings.');
      return;
    }
    this.tool = tool;
    this.copyArea = null;
    if (tool.mode !== 'none') this.selected = null;
    this.publish();
  }

  /** Buys a tech from the hub's stock. */
  research(id: number): void {
    const error = this.sim.techError(id);
    if (error) {
      this.warn(error);
      return;
    }
    this.sim.enqueue({ type: 'research', tech: id });
    this.sim.applyQueued();
    this.sincePublish = 1;
  }

  undo(): void {
    const result = this.history.undo();
    if (!result) this.warn('Nothing to undo.');
    else if (result.failed) this.warn(`Undone, but ${result.failed} ${result.failed === 1 ? 'change' : 'changes'} could not be put back.`);
    this.sincePublish = 1;
  }

  redo(): void {
    const result = this.history.redo();
    if (!result) this.warn('Nothing to redo.');
    else if (result.failed) this.warn(`Redone, but ${result.failed} ${result.failed === 1 ? 'change' : 'changes'} could not be repeated.`);
    this.sincePublish = 1;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.paused = false;
    this.publish();
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.publish();
  }

  setRecipe(recipe: number): void {
    if (!this.selected) return;
    this.history.do({ type: 'setRecipe', x: this.selected.x, y: this.selected.y, recipe });
    this.sincePublish = 1;
  }

  rotateSelected(): void {
    if (this.selected) this.history.do({ type: 'rotate', x: this.selected.x, y: this.selected.y });
  }

  removeSelected(): void {
    if (!this.selected) return;
    this.history.do({ type: 'remove', x: this.selected.x, y: this.selected.y });
    this.selected = null;
  }

  async save(key = 'manual', announce = true): Promise<void> {
    try {
      await writeSave(key, saveSim(this.sim));
      if (announce) this.note('Game saved.');
    } catch (error) {
      this.note(`Could not save: ${(error as Error).message}`);
    }
  }

  async load(key = 'manual'): Promise<void> {
    try {
      const data = await readSave(key);
      if (!data) {
        this.note('There is no saved game yet.');
        return;
      }
      this.useSim(loadSim(data));
      this.note('Game loaded.');
    } catch (error) {
      this.note(`Could not load: ${(error as Error).message}`);
    }
  }

  exportSave(): void {
    const data = saveSim(this.sim);
    const url = URL.createObjectURL(new Blob([data.slice().buffer], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `shiftworks-${Math.floor(this.sim.tick / TICKS_PER_SECOND)}s.shft`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.note('Save exported to a file.');
  }

  async importSave(file: File): Promise<void> {
    try {
      this.useSim(loadSim(new Uint8Array(await file.arrayBuffer())));
      this.note('Save imported.');
    } catch (error) {
      this.note(`Could not import: ${(error as Error).message}`);
    }
  }

  newGame(): void {
    this.useSim(new Sim({ seed: (Date.now() & 0x7fffffff) | 1 }));
    this.tool = { mode: 'none' };
    this.note('New map generated.');
  }

  dismissWin(): void {
    this.won = false;
    this.publish();
  }

  private note(text: string): void {
    this.toast(text);
  }

  private toast(text: string): void {
    this.toasts.push({ id: ++this.toastId, text, until: performance.now() + 6000 });
    this.sincePublish = 1;
  }

  private warn(text: string): void {
    this.message = text;
    this.messageUntil = performance.now() + 2200;
    this.sincePublish = 1;
  }

  // ---- input -----------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.canvas;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.renderer.rig.zoom(Math.exp(e.deltaY * 0.0015));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const tile = this.renderer.pick(e.clientX, e.clientY);
    this.hover = tile;
    this.drag = { button: e.button, last: tile, panX: e.clientX, panY: e.clientY };
    // Everything done until the button comes up undoes as one step.
    this.history.begin();
    if (!tile) return;
    if (e.button === 2) {
      this.removeAt(tile.x, tile.y);
    } else if (e.button === 0) {
      if (this.tool.mode === 'build') {
        this.placeAt(this.tool.building, tile.x, tile.y, this.toolDir, true);
      } else if (this.tool.mode === 'delete') {
        this.removeAt(tile.x, tile.y);
      } else if (this.tool.mode === 'copy') {
        this.copyArea = { from: tile, to: tile };
      } else if (this.tool.mode === 'paste') {
        this.pasteAt(tile);
      } else {
        const slot = this.sim.world.buildingAt(tile.x, tile.y);
        this.selected = slot >= 0 ? { x: this.sim.bx[slot], y: this.sim.by[slot] } : null;
        this.sincePublish = 1;
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const tile = this.renderer.pick(e.clientX, e.clientY);
    this.hover = tile;
    const drag = this.drag;
    if (!drag) return;
    if (drag.button === 1) {
      // Dragging with the middle button slides the map under the cursor.
      const scale = this.renderer.rig.distance / window.innerHeight;
      this.renderer.rig.pan(-(e.clientX - drag.panX) * scale, (e.clientY - drag.panY) * scale * 1.3);
      drag.panX = e.clientX;
      drag.panY = e.clientY;
      return;
    }
    if (!tile || (drag.last && drag.last.x === tile.x && drag.last.y === tile.y)) return;
    if (drag.button === 0 && this.copyArea) this.copyArea.to = tile;
    const deleting = drag.button === 2 || (drag.button === 0 && this.tool.mode === 'delete');
    if (deleting) {
      this.removeAt(tile.x, tile.y);
    } else if (drag.button === 0 && this.tool.mode === 'build') {
      if (this.tool.building === BELT && drag.last) this.layBelt(drag.last, tile);
      else this.placeAt(this.tool.building, tile.x, tile.y, this.toolDir, false);
    }
    drag.last = tile;
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.history.commit();
    if (this.copyArea) {
      // The button can come up without a last move event, so take the corner from here.
      const tile = this.renderer.pick(e.clientX, e.clientY);
      if (tile) this.copyArea.to = tile;
      this.finishCopy();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    if (e.metaKey || e.ctrlKey) {
      // The usual shortcuts work as well as the single keys.
      const action = e.code === 'KeyZ' ? (e.shiftKey ? 'redo' : 'undo') : e.code === 'KeyY' ? 'redo' : e.code === 'KeyC' ? 'copy' : e.code === 'KeyV' ? 'paste' : '';
      if (!action) return;
      e.preventDefault();
      if (action === 'undo') this.undo();
      else if (action === 'redo') this.redo();
      else this.setTool({ mode: action });
      return;
    }
    this.keys.add(e.code);
    switch (e.code) {
      case 'KeyR':
        if (this.tool.mode === 'build') this.toolDir = (this.toolDir + (e.shiftKey ? 3 : 1)) & 3;
        else if (this.tool.mode === 'paste') this.pasteTurns = (this.pasteTurns + (e.shiftKey ? 3 : 1)) & 3;
        else if (this.hover) this.history.do({ type: 'rotate', x: this.hover.x, y: this.hover.y });
        break;
      case 'KeyZ':
        if (e.shiftKey) this.redo();
        else this.undo();
        break;
      case 'KeyC':
        this.setTool(this.tool.mode === 'copy' ? { mode: 'none' } : { mode: 'copy' });
        break;
      case 'KeyV':
        this.setTool(this.tool.mode === 'paste' ? { mode: 'none' } : { mode: 'paste' });
        break;
      case 'KeyQ':
        this.renderer.rig.rotate(-1);
        break;
      case 'KeyE':
        this.renderer.rig.rotate(1);
        break;
      case 'KeyF':
        this.pipette();
        break;
      case 'KeyX':
        this.setTool(this.tool.mode === 'delete' ? { mode: 'none' } : { mode: 'delete' });
        break;
      case 'Escape':
        this.selected = null;
        this.setTool({ mode: 'none' });
        break;
      case 'Space':
        e.preventDefault();
        this.togglePause();
        break;
      default: {
        const match = /^Digit([1-9])$/.exec(e.code);
        if (match) {
          const entry = this.buildable()[Number(match[1]) - 1];
          if (entry) this.setTool({ mode: 'build', building: entry.id });
        }
      }
    }
    this.sincePublish = 1;
  }

  private panFromKeys(dt: number): void {
    const k = this.keys;
    const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (right || forward) {
      const speed = this.renderer.rig.distance * 0.9 * dt;
      this.renderer.rig.pan(right * speed, forward * speed);
    }
  }

  /** Picks up the building under the cursor as the current tool. */
  private pipette(): void {
    if (!this.hover) return;
    const slot = this.sim.world.buildingAt(this.hover.x, this.hover.y);
    if (slot < 0) return;
    const def = BUILDING_BY_ID[this.sim.kind[slot]];
    if (!def || def.fixed) return;
    this.toolDir = this.sim.dir[slot];
    this.setTool({ mode: 'build', building: def.id });
  }

  private placeAt(building: number, x: number, y: number, dir: number, explain: boolean): void {
    const error = this.sim.placeError(building, x, y);
    if (error) {
      if (explain) this.warn(error);
      return;
    }
    this.history.do({ type: 'place', building, x, y, dir });
  }

  /** The clipboard as it would land with its middle on `tile`, turned by the paste rotation. */
  private pasteGhosts(tile: { x: number; y: number }): { building: number; x: number; y: number; dir: number; recipe: number; ok: boolean }[] {
    return this.clipboard.map((c) => {
      let dx = c.dx;
      let dy = c.dy;
      for (let t = 0; t < this.pasteTurns; t++) [dx, dy] = [-dy, dx];
      const x = tile.x + dx;
      const y = tile.y + dy;
      return { building: c.building, x, y, dir: (c.dir + this.pasteTurns) & 3, recipe: c.recipe, ok: this.sim.placeError(c.building, x, y) === null };
    });
  }

  /** Places every copied building that fits and can be paid for. One undo step. */
  private pasteAt(tile: { x: number; y: number }): void {
    let placed = 0;
    let skipped = 0;
    for (const g of this.pasteGhosts(tile)) {
      if (!this.history.do({ type: 'place', building: g.building, x: g.x, y: g.y, dir: g.dir })) {
        skipped++;
        continue;
      }
      placed++;
      if (g.recipe && this.sim.recipe[this.sim.world.buildingAt(g.x, g.y)] !== g.recipe) {
        this.history.do({ type: 'setRecipe', x: g.x, y: g.y, recipe: g.recipe });
      }
    }
    if (skipped) this.warn(`Pasted ${placed} of ${placed + skipped}. The rest did not fit or could not be paid for.`);
  }

  /** Copies the buildings inside the dragged rectangle and switches to pasting them. */
  private finishCopy(): void {
    const area = this.copyArea!;
    this.copyArea = null;
    const x0 = Math.min(area.from.x, area.to.x);
    const x1 = Math.max(area.from.x, area.to.x);
    const y0 = Math.min(area.from.y, area.to.y);
    const y1 = Math.max(area.from.y, area.to.y);
    const cx = (x0 + x1) >> 1;
    const cy = (y0 + y1) >> 1;
    const clips: Clip[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const slot = this.sim.world.buildingAt(x, y);
        // A building is copied from its own tile, so a large one is taken once.
        if (slot < 0 || this.sim.bx[slot] !== x || this.sim.by[slot] !== y) continue;
        if (BUILDING_BY_ID[this.sim.kind[slot]]?.fixed) continue;
        clips.push({ building: this.sim.kind[slot], dx: x - cx, dy: y - cy, dir: this.sim.dir[slot], recipe: this.sim.recipe[slot] });
      }
    }
    if (clips.length === 0) {
      this.warn('No buildings in that area to copy.');
      return;
    }
    this.clipboard = clips;
    this.pasteTurns = 0;
    this.setTool({ mode: 'paste' });
  }

  private removeAt(x: number, y: number): void {
    const slot = this.sim.world.buildingAt(x, y);
    if (slot < 0) return;
    if (BUILDING_BY_ID[this.sim.kind[slot]]?.fixed) {
      this.warn('The town hub cannot be removed.');
      return;
    }
    if (this.selected && this.selected.x === this.sim.bx[slot] && this.selected.y === this.sim.by[slot]) this.selected = null;
    this.history.do({ type: 'remove', x, y });
  }

  /** Lays belt along a drag, turning each tile to point at the next one. */
  private layBelt(from: { x: number; y: number }, to: { x: number; y: number }): void {
    let x = from.x;
    let y = from.y;
    let guard = 0;
    while ((x !== to.x || y !== to.y) && guard++ < 512) {
      const dir = x !== to.x ? (to.x > x ? 0 : 2) : to.y > y ? 1 : 3;
      this.placeAt(BELT, x, y, dir, false);
      x += DX[dir];
      y += DY[dir];
      this.placeAt(BELT, x, y, dir, false);
      this.toolDir = dir;
    }
  }

  private updateGhost(): void {
    const hover = this.hover;
    if (this.tool.mode === 'build' && hover) {
      const ok = this.sim.placeError(this.tool.building, hover.x, hover.y) === null;
      this.renderer.setGhost({ building: this.tool.building, x: hover.x, y: hover.y, dir: this.toolDir, ok });
      this.renderer.setCursor(hover, ok ? 0x7dffa0 : 0xff5a5a);
    } else {
      this.renderer.setGhost(null);
      this.renderer.setCursor(hover, this.tool.mode === 'delete' ? 0xff5a5a : this.tool.mode === 'copy' ? 0x8fd3ff : 0xffffff);
    }
    this.renderer.setPasteGhosts(this.tool.mode === 'paste' && hover ? this.pasteGhosts(hover) : []);
    const area = this.copyArea;
    this.renderer.setArea(area && {
      x0: Math.min(area.from.x, area.to.x), y0: Math.min(area.from.y, area.to.y),
      x1: Math.max(area.from.x, area.to.x), y1: Math.max(area.from.y, area.to.y),
    });
    if (this.selected && this.sim.world.buildingAt(this.selected.x, this.selected.y) < 0) this.selected = null;
    this.renderer.setSelection(this.selected);

    // Flow arrows: on what you are about to place, else on what you point at,
    // else on what you have selected.
    if (this.tool.mode === 'build' && hover) {
      this.renderer.setPorts({ building: this.tool.building, x: hover.x, y: hover.y, dir: this.toolDir });
    } else {
      const at = this.tool.mode === 'none' && hover && this.sim.world.buildingAt(hover.x, hover.y) >= 0 ? hover : this.selected;
      const slot = at ? this.sim.world.buildingAt(at.x, at.y) : -1;
      this.renderer.setPorts(slot < 0 ? null : {
        building: this.sim.kind[slot], x: this.sim.bx[slot], y: this.sim.by[slot], dir: this.sim.dir[slot],
      });
    }
  }

  // ---- the interface's view of the game -----------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): UiState => this.state;

  private publish(): void {
    this.state = this.snapshot(true);
    for (const listener of this.listeners) listener();
  }

  private buildable(): BuildingDef[] {
    return BUILDINGS.filter((b) => !b.fixed && this.sim.unlockedBuildings[b.id]);
  }

  private snapshot(ready: boolean): UiState {
    const sim = this.sim;
    const now = performance.now();
    this.toasts = this.toasts.filter((t) => t.until > now);
    if (now > this.messageUntil) this.message = '';

    const goal = GOALS[sim.goalIndex];
    const needs: UiNeed[] = (goal?.needs ?? []).map((n) => {
      const item = ITEM_BY_KEY.get(n.item)!;
      return { name: item.name, color: hex(item.color), have: Math.min(sim.goalProgress[item.id], n.count), need: n.count };
    });
    for (const r of goal?.rates ?? []) {
      const item = ITEM_BY_KEY.get(r.item)!;
      needs.push({ name: item.name, color: hex(item.color), have: sim.rate[item.id], need: r.perMinute, perMinute: true });
    }

    return {
      ready,
      speed: this.speed,
      paused: this.paused,
      aiActive: this.aiActive,
      seconds: Math.floor(sim.tick / TICKS_PER_SECOND),
      stage: goal?.stage ?? FINAL_STAGE,
      goalNumber: sim.goalIndex + 1,
      goalCount: GOALS.length,
      goalTitle: goal?.title ?? 'A thriving village',
      goalText: goal?.text ?? 'The town has grown as far as it can for now. Keep it supplied, keep building, or start a new map.',
      needs,
      gate: goal?.rates ? { held: Math.min(sim.gateHeld, goal.holdSeconds ?? 0), hold: goal.holdSeconds ?? 0, running: sim.gateRatesMet() && !sim.townIsShort() } : null,
      uses: sim.consumption().map((u) => {
        const item = ITEM_BY_KEY.get(u.item)!;
        return { name: item.name, color: hex(item.color), perMinute: u.perMinute, short: sim.short[item.id] === 1 };
      }),
      techs: TECHS.filter((t) => !sim.researched[t.id] && t.stage <= sim.goalIndex).map((t) => {
        const missing = t.requires.map((key) => TECH_BY_KEY.get(key)!).filter((r) => !sim.researched[r.id]);
        const cost = t.cost.map((c) => {
          const item = ITEM_BY_KEY.get(c.item)!;
          return { name: item.name, color: hex(item.color), count: c.count, enough: sim.stock[item.id] >= c.count };
        });
        const blocked = missing.length ? `Needs ${missing.map((r) => r.name).join(' and ')}` : cost.every((c) => c.enough) ? '' : 'Not enough in the hub';
        return { id: t.id, name: t.name, text: t.text, cost, blocked };
      }),
      arriving: ITEMS.filter((i) => sim.rate[i.id] > 0).map((i) => ({ name: i.name, color: hex(i.color), perMinute: sim.rate[i.id] })),
      rewards: goal ? this.rewardNames(sim.goalIndex) : [],
      won: this.won,
      stock: ITEMS.filter((i) => sim.stock[i.id] > 0).map((i) => ({ name: i.name, color: hex(i.color), count: sim.stock[i.id] })),
      buildBar: this.buildable().map((b, i) => ({
        id: b.id,
        name: b.name,
        color: hex(b.color),
        hint: b.hint,
        hotkey: String(i + 1),
        affordable: sim.canAfford(b.id),
        cost: b.cost.map((c) => {
          const item = ITEM_BY_KEY.get(c.item)!;
          return { name: item.name, color: hex(item.color), count: c.count, enough: sim.stock[item.id] >= c.count };
        }),
      })),
      tool: this.tool,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      clipboard: this.clipboard.length,
      toolDir: (this.toolDir + this.renderer.rig.turns) & 3,
      hover: this.describeHover(),
      selected: this.describeSelected(),
      toasts: this.toasts.map((t) => ({ id: t.id, text: t.text })),
      message: this.message,
      perf: {
        tickMs: this.tickMs,
        frameMs: this.frameMs,
        drawCalls: this.renderer.drawCalls,
        items: this.renderer.itemCount,
        buildings: sim.count - sim.freeCount,
        fps: this.fps,
      },
    };
  }

  private describeHover(): string {
    const h = this.hover;
    if (!h || !this.sim.world.hasTile(h.x, h.y)) return '';
    const slot = this.sim.world.buildingAt(h.x, h.y);
    if (slot >= 0) return BUILDING_BY_ID[this.sim.kind[slot]]?.name ?? '';
    const deposit = this.sim.world.depositAt(h.x, h.y);
    if (deposit) {
      const locked = this.sim.unlockedResources[deposit] ? '' : ' (not usable yet)';
      return `${ITEM_BY_ID[deposit]?.name ?? ''} deposit${locked}`;
    }
    return this.sim.world.terrainAt(h.x, h.y) === 0 ? 'Open ground' : 'Water';
  }

  private describeSelected(): UiState['selected'] {
    const sel = this.selected;
    if (!sel) return null;
    const sim = this.sim;
    const slot = sim.world.buildingAt(sel.x, sel.y);
    if (slot < 0) return null;
    const def = BUILDING_BY_ID[sim.kind[slot]];
    if (!def) return null;
    const role = sim.role(slot);
    const detail: string[] = [];
    let status = '';
    let statusKind: 'ok' | 'warn' | 'bad' | 'idle' = 'idle';
    if (role === ROLE_MACHINE || role === ROLE_MINER) {
      switch (sim.status[slot]) {
        case STATUS_WORKING: status = 'Working'; statusKind = 'ok'; break;
        case STATUS_STARVED: status = 'Waiting for inputs'; statusKind = 'warn'; break;
        case STATUS_BLOCKED: status = 'Output is full: nothing in front takes it'; statusKind = 'bad'; break;
        case STATUS_IDLE: status = 'No recipe chosen'; statusKind = 'idle'; break;
      }
    }
    if (role === ROLE_MINER) {
      detail.push(`Extracting ${ITEM_BY_ID[sim.aux[slot]]?.name ?? '?'}`);
      detail.push(`Holding ${sim.out[slot]} ready to push out`);
    }
    if (role === ROLE_MACHINE) {
      const r = RECIPE_BY_ID[sim.recipe[slot]];
      if (r) {
        const a = ITEM_BY_KEY.get(r.inputs[0].item)?.name;
        detail.push(`${a}: ${sim.inA[slot]} waiting`);
        if (r.inputs[1]) detail.push(`${ITEM_BY_KEY.get(r.inputs[1].item)?.name}: ${sim.inB[slot]} waiting`);
        detail.push(`${ITEM_BY_KEY.get(r.output.item)?.name}: ${sim.out[slot]} ready to push out`);
      }
    }
    if (role === ROLE_HUB) {
      status = 'Belts pointing into the hub deliver to the town';
      statusKind = 'ok';
    }
    const recipes = role === ROLE_MACHINE
      ? sim.recipesFor(sim.kind[slot]).map((id) => ({ id, name: RECIPE_BY_ID[id]?.name ?? '', text: recipeText(id) }))
      : [];
    return { x: sel.x, y: sel.y, name: def.name, status, statusKind, detail, recipe: sim.recipe[slot], recipes };
  }
}
