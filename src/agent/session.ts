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
}

export interface AiState {
  /** Whether the dev server has a key: null until checked. */
  available: boolean | null;
  status: 'idle' | 'running' | 'stopping';
  model: string;
  effort: Effort;
  maxCostUsd: number;
  speed: number;
  follow: boolean;
  usage: AgentUsage | null;
  log: LogEntry[];
}

const MAX_LOG = 400;

function summarise(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
}

export class AiSession {
  private readonly game: Game;
  private state: AiState = {
    available: null, status: 'idle', model: DEFAULT_MODEL, effort: 'medium', maxCostUsd: 5, speed: 8, follow: true, usage: null, log: [],
  };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private nextId = 0;

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

  private add(kind: LogEntry['kind'], title: string, body: string, error = false): void {
    const entry: LogEntry = { id: ++this.nextId, kind, seconds: this.game.getState().seconds, title, body, error };
    this.set({ log: [...this.state.log, entry].slice(-MAX_LOG) });
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

  configure(patch: Partial<Pick<AiState, 'model' | 'effort' | 'maxCostUsd' | 'speed' | 'follow'>>): void {
    this.set(patch);
    this.game.setAiOptions(this.state.speed, this.state.follow);
  }

  async start(): Promise<void> {
    if (this.state.status !== 'idle') return;
    this.controller = new AbortController();
    this.set({ status: 'running', usage: null, log: [] });
    this.game.setAiOptions(this.state.speed, this.state.follow);
    this.game.setAiActive(true);
    // Requests go to this page's own dev server, which adds the real key and
    // forwards them. The key here is a placeholder, so nothing secret is in
    // the browser and the SDK's browser check has nothing to protect.
    const client = new Anthropic({
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
      this.add('end', result.reason === 'won' ? 'Finished' : 'Stopped', result.detail, result.reason === 'error' || result.reason === 'refused');
    } catch (error) {
      this.add('end', 'Crashed', (error as Error).message, true);
    } finally {
      this.game.setAiActive(false);
      this.controller = null;
      this.set({ status: 'idle' });
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
      case 'thinking': this.add('thinking', 'Thinking', event.text); break;
      case 'text': this.add('text', '', event.text); break;
      case 'notice': this.add('notice', '', event.text); break;
      case 'tool': this.add('tool', `${event.name}(${summarise(event.input)})`, event.result, event.error); break;
    }
  }
}
