// Undo and redo for the player's own actions. Every action already reaches the
// simulation as a command, so undoing one is running the command that reverses
// it: a placement is undone by a removal, and a removal by a placement that
// also puts back what the building was holding.
//
// Actions are grouped, so one drag of belt or one paste is a single undo step.

import type { Command, Sim } from './sim';

interface Entry {
  command: Command;
  /** Commands that put things back as they were, in the order to run them. */
  inverse: Command[];
}

const MAX_STEPS = 200;

export class History {
  private undoStack: Entry[][] = [];
  private redoStack: Command[][] = [];
  private open: Entry[] | null = null;

  constructor(private readonly sim: () => Sim) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0 || (this.open !== null && this.open.length > 0);
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Forgets everything, for when the map is replaced or someone else has been building. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
  }

  /** Starts a group: everything done until `commit` undoes as one step. */
  begin(): void {
    this.commit();
    this.open = [];
  }

  commit(): void {
    if (this.open && this.open.length > 0) this.push(this.open);
    this.open = null;
  }

  /** Runs a command now and remembers how to reverse it. Returns whether it took effect. */
  do(command: Command): boolean {
    const entry = this.run(command);
    if (!entry) return false;
    if (this.open) this.open.push(entry);
    else this.push([entry]);
    this.redoStack = [];
    return true;
  }

  /** Reverses the last step. Returns how many changes were reversed and how many could not be. */
  undo(): { done: number; failed: number } | null {
    this.commit();
    const step = this.undoStack.pop();
    if (!step) return null;
    let done = 0;
    let failed = 0;
    for (let i = step.length - 1; i >= 0; i--) {
      let ok = true;
      for (const command of step[i].inverse) if (!this.apply(command)) ok = false;
      if (ok) done++;
      else failed++;
    }
    this.redoStack.push(step.map((e) => e.command));
    return { done, failed };
  }

  /** Repeats the last step that was undone. */
  redo(): { done: number; failed: number } | null {
    this.commit();
    const commands = this.redoStack.pop();
    if (!commands) return null;
    const step: Entry[] = [];
    for (const command of commands) {
      const entry = this.run(command);
      if (entry) step.push(entry);
    }
    if (step.length > 0) this.push(step);
    return { done: step.length, failed: commands.length - step.length };
  }

  private push(step: Entry[]): void {
    this.undoStack.push(step);
    if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
  }

  private run(command: Command): Entry | null {
    const inverse = this.inverseOf(command);
    return this.apply(command) ? { command, inverse } : null;
  }

  /** Applies a command straight away, which the simulation allows between ticks. */
  private apply(command: Command): boolean {
    const sim = this.sim();
    sim.applyQueued();
    const before = sim.log.length;
    sim.enqueue(command);
    sim.applyQueued();
    return sim.log.length > before;
  }

  /** Worked out before the command runs, from the state it is about to change. */
  private inverseOf(command: Command): Command[] {
    const sim = this.sim();
    const slot = sim.world.buildingAt(command.x, command.y);
    switch (command.type) {
      case 'place':
        // Laying a belt over a belt only turns it, so undoing turns it back.
        if (slot >= 0) return [{ type: 'place', building: sim.kind[slot], x: command.x, y: command.y, dir: sim.dir[slot] }];
        return [{ type: 'remove', x: command.x, y: command.y }];
      case 'remove':
        if (slot < 0) return [];
        return [{ type: 'place', building: sim.kind[slot], x: sim.bx[slot], y: sim.by[slot], dir: sim.dir[slot], held: sim.heldBy(slot) }];
      case 'rotate': {
        const turn: Command = { type: 'rotate', x: command.x, y: command.y };
        return [turn, turn, turn];
      }
      case 'setRecipe':
        return slot < 0 ? [] : [{ type: 'setRecipe', x: command.x, y: command.y, recipe: sim.recipe[slot] }];
    }
  }
}
