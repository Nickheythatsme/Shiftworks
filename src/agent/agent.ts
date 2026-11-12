// The AI player's loop: ask the model what to do, run the tools it calls
// against the game, hand back what happened, repeat until the last delivery
// list is complete. The same loop runs headless from the command line and in
// the browser against the live game; only the host and the client differ.

import Anthropic from '@anthropic-ai/sdk';
import { GOALS } from '../content/content';
import { SYSTEM_PROMPT } from './prompt';
import { TOOLS, ToolError, runTool, type AgentHost } from './tools';


export const DEFAULT_MODEL = 'claude-opus-5-5';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Dollars per million tokens, for the running cost estimate only. */
export const MODELS: { id: string; name: string; input: number; output: number; cacheRead: number }[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', input: 2, output: 10, cacheRead: 0.1 },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01 },
  { id: 'claude-fable-5-2', name: 'Fable 5.2', input: 8, output: 40, cacheRead: 0.2 },
];

export interface AgentUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated from list prices. */
  costUsd: number;
}

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown; result: string; error: boolean }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'notice'; text: string };

export type StopReason = 'won' | 'stopped' | 'turn_limit' | 'budget' | 'refused' | 'gave_up' | 'error';

export interface AgentResult {
  reason: StopReason;
  detail: string;
  usage: AgentUsage;
}

export interface AgentOptions {
  client: Anthropic;
  host: AgentHost;
  model?: string;
  effort?: Effort;
  /** Stop after this many model calls. */
  maxTurns?: number;
  /** Stop once the estimated spend passes this many dollars. */
  maxCostUsd?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

const KICKOFF =
  'Play Shiftworks. Work through the town\'s delivery lists until the last one is complete. Start by reading the state and looking at the map around the hub.';
const NUDGE =
  'The game is not finished: there are delivery lists left. Keep playing with the tools. If you are stuck, call get_state and look at the problems it lists.';

function won(host: AgentHost): boolean {
  return host.sim().goalIndex >= GOALS.length;
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { client, host, signal } = options;
  const model = options.model ?? DEFAULT_MODEL;
  const maxTurns = options.maxTurns ?? 400;
  const maxCost = options.maxCostUsd ?? 10;
  const emit = options.onEvent ?? (() => {});
  const price = MODELS.find((m) => m.id === model) ?? MODELS[0];
  const usage: AgentUsage = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const done = (reason: StopReason, detail: string): AgentResult => ({ reason, detail, usage });

  if (won(host)) return done('won', 'Every delivery list was already complete.');

  // The history is only ever appended to. Thinking blocks are tied to the
  // conversation they were produced in, so nothing earlier is edited or cut;
  // the API compacts old turns itself when the context grows large.
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: KICKOFF }];
  let idleReplies = 0;
  let truncated = 0;

  while (true) {
    if (signal?.aborted) return done('stopped', 'Stopped.');
    if (usage.turns >= maxTurns) return done('turn_limit', `Reached the limit of ${maxTurns} turns.`);
    if (usage.costUsd >= maxCost) return done('budget', `Reached the spending limit of $${maxCost.toFixed(2)}.`);

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: options.effort ?? 'medium' },
          // Caches everything up to the newest message, so each turn only pays
          // full price for what was added since the last one.
          cache_control: { type: 'ephemeral' },
          // If a safety classifier declines a turn, the API retries it on another model.
          fallbacks: 'default',
          context_management: { edits: [{ type: 'compact_20260112' }] },
          betas: ['server-side-fallback-2026-07-01', 'compact-2026-01-12'],
        },
        { signal },
      );
    } catch (error) {
      if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return done('stopped', 'Stopped.');
      if (error instanceof Anthropic.AuthenticationError) return done('error', 'The API key was rejected.');
      if (error instanceof Anthropic.RateLimitError) return done('error', 'Rate limited by the API, even after retries.');
      if (error instanceof Anthropic.APIConnectionError) return done('error', `Could not reach the API: ${error.message}`);
      if (error instanceof Anthropic.APIError) return done('error', `API error ${error.status ?? ''}: ${error.message}`);
      throw error;
    }

    usage.turns++;
    const u = response.usage;
    usage.inputTokens += u.input_tokens;
    usage.outputTokens += u.output_tokens;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    usage.costUsd +=
      (u.input_tokens * price.input + u.output_tokens * price.output + (u.cache_read_input_tokens ?? 0) * price.cacheRead +
        (u.cache_creation_input_tokens ?? 0) * price.input * 1.25) / 1e6;
    emit({ type: 'usage', usage: { ...usage } });

    for (const block of response.content) {
      if (block.type === 'thinking' && block.thinking.trim()) emit({ type: 'thinking', text: block.thinking.trim() });
      else if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text.trim() });
      else if (block.type === 'compaction') emit({ type: 'notice', text: 'Earlier turns were summarised to keep the context small.' });
    }

    if (response.stop_reason === 'refusal') {
      return done('refused', `The model declined to continue${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
    }
    if (response.stop_reason === 'max_tokens') {
      // The reply was cut off, so any tool call in it may be incomplete. Ask again rather than run it.
      if (++truncated > 2) return done('error', 'The model\'s replies kept running out of room.');
      emit({ type: 'notice', text: 'A reply was cut off; asking again.' });
      continue;
    }
    truncated = 0;

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) {
      if (won(host)) return done('won', 'Every delivery list is complete.');
      if (++idleReplies > 3) return done('gave_up', 'The model stopped calling tools before the game was finished.');
      messages.push({ role: 'user', content: NUDGE });
      continue;
    }
    idleReplies = 0;

    // Tool calls change the game, so they run one at a time in the order given.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      let result: string;
      let failed = false;
      if (signal?.aborted) {
        result = 'Not run: the session was stopped.';
        failed = true;
      } else {
        try {
          result = await runTool(host, call.name, call.input, () => signal?.aborted === true);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          result = error.message;
          failed = true;
        }
      }
      emit({ type: 'tool', name: call.name, input: call.input, result, error: failed });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: result, is_error: failed });
    }
    messages.push({ role: 'user', content: results });
    if (won(host)) return done('won', 'Every delivery list is complete.');
  }
}
