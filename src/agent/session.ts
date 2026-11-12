// The browser side of "AI plays": owns one agent run against the live game and
// publishes what it is doing for the panel to draw.

import Anthropic from '@anthropic-ai/sdk';
import type { Game } from '../game';
import { DEFAULT_MODEL, runAgent, type AgentEvent, type AgentUsage, type Effort } from './agent';

export interface LogEntry {
  id: number;
  kind: 'thinking' | 'text' | 'tool' | 'notice' | 'end';
  /** Game clock when it happened, in seconds. */
  seconds: number;
  title: string;
  body: string;
  error?: boolean;
  /** Still being written by the model, or a tool call that has not finished. */
  pending?: boolean;
}

export interface AiState {
  /** Whether the dev server has a key of its own: null until checked. */
  available: boolean | null;
  /** The last few characters of a key pasted into the panel, or '' if there is none. */
  keyHint: string;
  /** Whether the pasted key is kept in this browser between visits. */
  rememberKey: boolean;
  status: 'idle' | 'running' | 'stopping';
  /** What the AI is doing this moment, for the line under the log; '' when idle. */
  activity: string;
  model: string;
  effort: Effort;
  maxCostUsd: number;
  speed: number;
  follow: boolean;
  /** Whether placements are acted out with the hand, or just appear. */
  animate: boolean;
  usage: AgentUsage | null;
  log: LogEntry[];
}

const MAX_LOG = 400;
/** How often text that is streaming in is put on screen, in milliseconds. */
const FLUSH_MS = 60;
const KEY_STORE = 'shiftworks-anthropic-key';

function storedKey(): string {
  try {
    return window.localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}

function summarise(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
}

export class AiSession {
  private readonly game: Game;
  // A key pasted into the panel. It is held here, not in the published state,
  // and goes nowhere except straight to the Claude API.
  private apiKey = storedKey();
  private state: AiState = {
    available: null, keyHint: this.apiKey.slice(-4), rememberKey: this.apiKey !== '', status: 'idle', activity: '', model: DEFAULT_MODEL, effort: 'medium', maxCostUsd: 5, speed: 8, follow: true, animate: true, usage: null, log: [],
  };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private nextId = 0;
  // Entries for the reply being received, by the block's place in that reply.
  private live = new Map<number, number>();
  // Text that has arrived for an entry but is not on screen yet. Pieces come
  // many times a second, so they are gathered and shown a few at a time.
  private buffered = new Map<number, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(game: Game) {
    this.game = game;
    void this.checkAvailable();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AiState => this.state;

  private set(patch: Partial<AiState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private add(kind: LogEntry['kind'], title: string, body: string, error = false, pending = false): number {
    const entry: LogEntry = { id: ++this.nextId, kind, seconds: this.game.getState().seconds, title, body, error, pending };
    this.set({ log: [...this.state.log, entry].slice(-MAX_LOG) });
    return entry.id;
  }

  private patch(id: number, change: Partial<LogEntry>): void {
    this.set({ log: this.state.log.map((e) => (e.id === id ? { ...e, ...change } : e)) });
  }

  /** Finishes the entry begun for this block of the reply, or adds one if nothing of it was shown. */
  private finish(index: number, kind: LogEntry['kind'], title: string, body: string, error = false): void {
    this.flush();
    const id = this.live.get(index);
    if (id === undefined) this.add(kind, title, body, error);
    else this.patch(id, { title, body, error, pending: false });
  }

  /** Puts the text gathered since the last flush on screen. */
  private flush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.buffered.size === 0) return;
    const buffered = this.buffered;
    this.buffered = new Map();
    this.set({ log: this.state.log.map((e) => (buffered.has(e.id) ? { ...e, body: (e.body + buffered.get(e.id)).trimStart() } : e)) });
  }

  /** Nothing more will arrive for the entries still pending: drop them, or keep what there is of them. */
  private settle(keep: boolean): void {
    this.flush();
    this.live.clear();
    if (!this.state.log.some((e) => e.pending)) return;
    const kept = keep ? this.state.log.filter((e) => !e.pending || e.kind === 'tool' || e.body.trim() !== '') : this.state.log.filter((e) => !e.pending);
    this.set({ log: kept.map((e) => (e.pending ? { ...e, pending: false } : e)) });
  }

  private setActivity(activity: string): void {
    if (activity !== this.state.activity) this.set({ activity });
  }

  async checkAvailable(): Promise<void> {
    try {
      const response = await fetch('/api/ai-status');
      const data = (await response.json()) as { available?: boolean };
      this.set({ available: data.available === true });
    } catch {
      this.set({ available: false });
    }
  }

  /** Uses a pasted key from now on. With `remember` it is also kept in this browser's storage. */
  setKey(key: string, remember: boolean): void {
    this.apiKey = key.trim();
    try {
      if (remember && this.apiKey) window.localStorage.setItem(KEY_STORE, this.apiKey);
      else window.localStorage.removeItem(KEY_STORE);
    } catch {
      // Storage can be unavailable (private windows); the key still works until the page closes.
    }
    this.set({ keyHint: this.apiKey.slice(-4), rememberKey: remember && this.apiKey !== '' });
  }

  clearKey(): void {
    this.setKey('', false);
  }

  /** Whether there is any key to play with: one pasted here, or the dev server's. */
  canStart(): boolean {
    return this.apiKey !== '' || this.state.available === true;
  }

  configure(patch: Partial<Pick<AiState, 'model' | 'effort' | 'maxCostUsd' | 'speed' | 'follow' | 'animate'>>): void {
    this.set(patch);
    this.game.setAiOptions(this.state.speed, this.state.follow, this.state.animate);
  }

  async start(): Promise<void> {
    if (this.state.status !== 'idle' || !this.canStart()) return;
    this.controller = new AbortController();
    this.flush();
    this.live.clear();
    this.set({ status: 'running', activity: 'Starting…', usage: null, log: [] });
    this.game.setAiOptions(this.state.speed, this.state.follow, this.state.animate);
    this.game.setAiActive(true);
    // With a key pasted into the panel the page calls the Claude API directly:
    // the person chose to put their own key in their own browser, which is the
    // case the SDK's browser switch exists for. Otherwise requests go to this
    // page's dev server, which adds its key and forwards them, and the key
    // given here is only a placeholder.
    const client = this.apiKey
      ? new Anthropic({ apiKey: this.apiKey, dangerouslyAllowBrowser: true, maxRetries: 4 })
      : new Anthropic({
          apiKey: 'added-by-the-dev-server',
          baseURL: `${window.location.origin}/api/anthropic`,
          dangerouslyAllowBrowser: true,
          maxRetries: 4,
        });
    try {
      const result = await runAgent({
        client,
        host: this.game.agentHost(),
        model: this.state.model,
        effort: this.state.effort,
        maxCostUsd: this.state.maxCostUsd,
        signal: this.controller.signal,
        onEvent: (event) => this.onEvent(event),
      });
      this.settle(true);
      this.add('end', result.reason === 'won' ? 'Finished' : 'Stopped', result.detail, result.reason === 'error' || result.reason === 'refused');
    } catch (error) {
      this.settle(true);
      this.add('end', 'Crashed', (error as Error).message, true);
    } finally {
      this.game.setAiActive(false);
      this.controller = null;
      this.set({ status: 'idle', activity: '' });
    }
  }

  stop(): void {
    if (this.state.status !== 'running') return;
    this.set({ status: 'stopping' });
    this.controller?.abort();
    // Ends a wait that is in progress so the loop can notice the stop.
    this.game.setAiActive(false);
  }

  private onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'usage': this.set({ usage: event.usage }); break;
      case 'request':
        this.settle(true);
        this.setActivity('Waiting for the model…');
        break;
      case 'partial': {
        let id = this.live.get(event.index);
        // A block of prose gets its entry with its first words, so an empty one never shows.
        if (id === undefined && event.kind !== 'tool' && event.delta.trim() === '') break;
        if (id === undefined) {
          id = this.add(event.kind, event.kind === 'tool' ? `${event.name ?? 'tool'}(…)` : event.kind === 'thinking' ? 'Thinking' : '', '', false, true);
          this.live.set(event.index, id);
          this.setActivity(event.kind === 'tool' ? `Calling ${event.name ?? 'a tool'}…` : event.kind === 'thinking' ? 'Thinking…' : 'Writing…');
        }
        if (event.delta) {
          this.buffered.set(id, (this.buffered.get(id) ?? '') + event.delta);
          this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
        }
        break;
      }
      case 'discard': this.settle(false); break;
      case 'thinking': this.finish(event.index, 'thinking', 'Thinking', event.text); break;
      case 'text': this.finish(event.index, 'text', '', event.text); break;
      case 'notice': this.add('notice', '', event.text); break;
      case 'tool_start': {
        this.flush();
        const title = `${event.name}(${summarise(event.input)})`;
        const id = this.live.get(event.index);
        if (id === undefined) this.live.set(event.index, this.add('tool', title, '', false, true));
        else this.patch(id, { title, body: '' });
        this.setActivity(`Running ${event.name}…`);
        break;
      }
      case 'tool': this.finish(event.index, 'tool', `${event.name}(${summarise(event.input)})`, event.result, event.error); break;
    }
  }
}
