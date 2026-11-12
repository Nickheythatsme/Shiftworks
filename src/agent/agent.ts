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
  // A reply as it arrives. `index` is the block's place in the reply, and ties
  // the pieces of one block to each other and to the finished event below.
  /** A request has gone to the model and nothing has come back yet. */
  | { type: 'request' }
  /** The next piece of a block that is still being written. For a tool call the pieces are its input, as raw JSON. */
  | { type: 'partial'; kind: 'thinking' | 'text' | 'tool'; index: number; delta: string; name?: string }
  /** Whatever was shown of the current reply and never finished is void. */
  | { type: 'discard' }
  /** A tool call is complete and is about to run. */
  | { type: 'tool_start'; index: number; name: string; input: unknown }
  // Finished pieces of a reply.
  | { type: 'thinking'; text: string; index: number }
  | { type: 'text'; text: string; index: number }
  | { type: 'tool'; name: string; input: unknown; result: string; error: boolean; index: number }
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
  'Play Shiftworks. Grow the town through its gates until the last one is passed. Start by reading the state and looking at the map around the hub.';
const NUDGE =
  'The game is not finished: the town has gates left to pass. Keep playing with the tools. If you are stuck, call get_state and look at the problems it lists.';

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

  if (won(host)) return done('won', 'The town had already passed its last gate.');

  // The history is only ever appended to. Thinking blocks are tied to the
  // conversation they were produced in, so nothing earlier is edited or cut;
  // the API compacts old turns itself when the context grows large.
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: KICKOFF }];
  let idleReplies = 0;
  let truncated = 0;
  let dropped = 0;

  while (true) {
    if (signal?.aborted) return done('stopped', 'Stopped.');
    if (usage.turns >= maxTurns) return done('turn_limit', `Reached the limit of ${maxTurns} turns.`);
    if (usage.costUsd >= maxCost) return done('budget', `Reached the spending limit of $${maxCost.toFixed(2)}.`);

    let response: Anthropic.Beta.BetaMessage;
    let received = false;
    emit({ type: 'request' });
    try {
      const stream = client.beta.messages.stream(
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
      // The reply is reported piece by piece as it is written; the loop below
      // still works from the whole message once it has all arrived.
      for await (const event of stream) {
        received = true;
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            emit({ type: 'partial', kind: 'tool', index: event.index, delta: '', name: event.content_block.name });
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'thinking_delta') emit({ type: 'partial', kind: 'thinking', index: event.index, delta: delta.thinking });
          else if (delta.type === 'text_delta') emit({ type: 'partial', kind: 'text', index: event.index, delta: delta.text });
          else if (delta.type === 'input_json_delta') emit({ type: 'partial', kind: 'tool', index: event.index, delta: delta.partial_json });
        }
      }
      response = await stream.finalMessage();
      dropped = 0;
    } catch (error) {
      emit({ type: 'discard' });
      if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return done('stopped', 'Stopped.');
      // The client retries a request that fails outright, but not one that
      // breaks off part-way through the reply, so that case is retried here.
      if (received && error instanceof Anthropic.APIError && (error.status === undefined || error.status >= 500) && ++dropped <= 2) {
        emit({ type: 'notice', text: 'The reply broke off part-way; asking again.' });
        continue;
      }
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

    for (const [index, block] of response.content.entries()) {
      if (block.type === 'thinking' && block.thinking.trim()) emit({ type: 'thinking', text: block.thinking.trim(), index });
      else if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text.trim(), index });
      else if (block.type === 'compaction') emit({ type: 'notice', text: 'Earlier turns were summarised to keep the context small.' });
    }

    if (response.stop_reason === 'refusal') {
      return done('refused', `The model declined to continue${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`);
    }
    if (response.stop_reason === 'max_tokens') {
      // The reply was cut off, so any tool call in it may be incomplete. Ask again rather than run it.
      emit({ type: 'discard' });
      if (++truncated > 2) return done('error', 'The model\'s replies kept running out of room.');
      emit({ type: 'notice', text: 'A reply was cut off; asking again.' });
      continue;
    }
    truncated = 0;

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.flatMap((block, index) => (block.type === 'tool_use' ? [{ ...block, index }] : []));
    if (calls.length === 0) {
      if (won(host)) return done('won', 'The town passed its last gate.');
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
        emit({ type: 'tool_start', index: call.index, name: call.name, input: call.input });
        try {
          result = await runTool(host, call.name, call.input, () => signal?.aborted === true);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          result = error.message;
          failed = true;
        }
      }
      emit({ type: 'tool', name: call.name, input: call.input, result, error: failed, index: call.index });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: result, is_error: failed });
    }
    messages.push({ role: 'user', content: results });
    if (won(host)) return done('won', 'The town passed its last gate.');
  }
}
