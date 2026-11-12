// Ties the pieces together: turns input into commands, runs the fixed-rate
// simulation loop, asks the renderer to draw, and publishes a small summary for
// the interface a few times a second.

import {
  BUILDINGS, BUILDING_BY_ID, FINAL_STAGE, GOALS, ITEMS, ITEM_BY_ID, ITEM_BY_KEY, RECIPE_BY_ID, RECIPE_BY_KEY,
  TICKS_PER_SECOND, buildingId, type BuildingDef,
} from './content/content';
import { GameRenderer } from './render/renderer';
import {
  DX, DY, HUB_X, HUB_Y, ROLE_HUB, ROLE_MACHINE, ROLE_MINER, STATUS_BLOCKED, STATUS_IDLE, STATUS_STARVED, STATUS_WORKING,
  Sim, loadSim, saveSim,
} from './sim';
import { readSave, writeSave } from './storage';

const MAX_TICKS_PER_FRAME = 8;
const AUTOSAVE_SECONDS = 30;
const AUTOSAVE_KEY = 'autosave';
const BELT = buildingId('belt');

export type Tool = { mode: 'none' } | { mode: 'build'; building: number } | { mode: 'delete' };

export interface UiNeed {
  name: string;
  color: string;
  have: number;
  need: number;
}

export interface UiState {
  ready: boolean;
  speed: number;
  paused: boolean;
  seconds: number;
  stage: string;
  goalNumber: number;
  goalCount: number;
  goalTitle: string;
  goalText: string;
  needs: UiNeed[];
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
  private lastFrame = 0;

  tool: Tool = { mode: 'none' };
  toolDir = 0;
  private hover: { x: number; y: number } | null = null;
  private selected: { x: number; y: number } | null = null;
  private readonly keys = new Set<string>();
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
    if (!this.paused) {
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

    this.updateGhost();
    this.renderer.render(this.paused ? 0 : this.accumulator, dt);

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

  private drainEvents(): void {
    if (this.sim.events.length === 0) return;
    for (const event of this.sim.events) {
      if (event.type === 'won') {
        this.won = true;
        continue;
      }
      const goal = GOALS[event.index];
      const gained = this.rewardNames(event.index);
      this.toast(gained.length ? `${goal.title} delivered. Unlocked: ${gained.join(', ')}.` : `${goal.title} delivered.`);
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
    this.tool = tool;
    if (tool.mode !== 'none') this.selected = null;
    this.publish();
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
    this.sim.enqueue({ type: 'setRecipe', x: this.selected.x, y: this.selected.y, recipe });
    this.sincePublish = 1;
  }

  rotateSelected(): void {
    if (this.selected) this.sim.enqueue({ type: 'rotate', x: this.selected.x, y: this.selected.y });
  }

  removeSelected(): void {
    if (!this.selected) return;
    this.sim.enqueue({ type: 'remove', x: this.selected.x, y: this.selected.y });
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
    if (!tile) return;
    if (e.button === 2) {
      this.removeAt(tile.x, tile.y);
    } else if (e.button === 0) {
      if (this.tool.mode === 'build') {
        this.placeAt(this.tool.building, tile.x, tile.y, this.toolDir, true);
      } else if (this.tool.mode === 'delete') {
        this.removeAt(tile.x, tile.y);
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
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    this.keys.add(e.code);
    switch (e.code) {
      case 'KeyR':
        if (this.tool.mode === 'build') this.toolDir = (this.toolDir + (e.shiftKey ? 3 : 1)) & 3;
        else if (this.hover) this.sim.enqueue({ type: 'rotate', x: this.hover.x, y: this.hover.y });
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
    this.sim.enqueue({ type: 'place', building, x, y, dir });
  }

  private removeAt(x: number, y: number): void {
    const slot = this.sim.world.buildingAt(x, y);
    if (slot < 0) return;
    if (BUILDING_BY_ID[this.sim.kind[slot]]?.fixed) {
      this.warn('The town hub cannot be removed.');
      return;
    }
    if (this.selected && this.selected.x === this.sim.bx[slot] && this.selected.y === this.sim.by[slot]) this.selected = null;
    this.sim.enqueue({ type: 'remove', x, y });
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
      this.renderer.setCursor(hover, this.tool.mode === 'delete' ? 0xff5a5a : 0xffffff);
    }
    if (this.selected && this.sim.world.buildingAt(this.selected.x, this.selected.y) < 0) this.selected = null;
    this.renderer.setSelection(this.selected);
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

    return {
      ready,
      speed: this.speed,
      paused: this.paused,
      seconds: Math.floor(sim.tick / TICKS_PER_SECOND),
      stage: goal?.stage ?? FINAL_STAGE,
      goalNumber: Math.min(sim.goalIndex + 1, GOALS.length),
      goalCount: GOALS.length,
      goalTitle: goal?.title ?? 'Every delivery made',
      goalText: goal?.text ?? 'The hamlet has all it asked for. Keep building, or start a new map.',
      needs,
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
