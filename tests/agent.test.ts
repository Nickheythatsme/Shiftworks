import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent, type AgentEvent } from '../src/agent/agent';
import { TOOLS, ToolError, headlessHost, problems, runTool } from '../src/agent/tools';
import { GOALS, itemId } from '../src/content/content';
import { HUB_X, HUB_Y, Sim } from '../src/sim';
import { BELT, KILN, MINER, SAWMILL, SOUTH, place, testSim } from './helpers';

// The AI player's tools, driven directly with no model involved, and the loop
// driven by a scripted stand-in for the model.

/** The first deposit tile of a resource near the hub on a normal map, relative to the hub. */
function depositNear(sim: Sim, resource: string): [number, number] {
  const id = itemId(resource);
  for (let r = 1; r < 40; r++) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (sim.world.depositAt(HUB_X + x, HUB_Y + y) === id) return [x, y];
      }
    }
  }
  throw new Error(`no ${resource} near the hub`);
}

describe('agent tools', () => {
  it('describes a new game', async () => {
    const host = headlessHost(new Sim({ seed: 3 }));
    const state = await runTool(host, 'get_state', {});
    expect(state).toContain('Gate 1 of 2');
    expect(state).toContain('planks 0/100 per minute SHORT');
    expect(state).toContain('sawmill (costs 80 timber; not enough stock yet)');
    expect(state).toContain('belt (1 timber)');
    expect(state).toContain('Problems: none detected.');
    expect(await runTool(host, 'find_deposits', { resource: 'timber' })).toContain('nearest tile to the hub');
    expect(await runTool(host, 'view_map', { x: 0, y: 0, radius: 3 })).toContain('H H H');
  });

  it('delivers timber with a miner and a routed belt, then buys the sawmill', async () => {
    const sim = new Sim({ seed: 3 });
    const host = headlessHost(sim);
    const [x, y] = depositNear(sim, 'timber');
    const built = await runTool(host, 'build', { building: 'miner', x, y, dir: 'E' });
    expect(built).toContain('It mines timber');
    const routed = await runTool(host, 'connect', { from: [x, y], to: [0, 0] });
    expect(routed).toContain('Its output goes to the hub');
    expect(problems(sim)).toEqual([]);
    let report = '';
    await expect(runTool(host, 'research', { tech: 'sawmill' })).rejects.toThrow('Not enough timber');
    for (let i = 0; i < 3; i++) report = await runTool(host, 'wait', { seconds: 60 });
    expect(report).toContain('sawmill (costs 80 timber; CAN BUY NOW)');
    const learned = await runTool(host, 'research', { tech: 'sawmill' });
    expect(learned).toContain('sawmill (building');
    expect(learned).toContain('planks (recipe');
    expect(sim.unlockedBuildings[SAWMILL]).toBe(1);
    await expect(runTool(host, 'research', { tech: 'sawmill' })).rejects.toThrow('already known');
  });

  it('routes around obstacles and never onto another building\'s output tile', async () => {
    const sim = testSim();
    const host = headlessHost(sim);
    // A wall of belts with one gap, between the start and the hub. The wall's
    // belts face north, so the row above it is where they push their output.
    for (let x = -6; x <= 6; x++) if (x !== 4) place(sim, BELT, HUB_X + x, HUB_Y - 5, 3);
    sim.applyQueued();
    const out = await runTool(host, 'connect', { from: [0, -9], to: [0, 0] });
    expect(out).toContain('Its output goes to the hub');
    expect(sim.isBelt(sim.world.buildingAt(HUB_X + 4, HUB_Y - 5))).toBe(true);
    for (let x = -6; x <= 6; x++) expect(sim.world.buildingAt(HUB_X + x, HUB_Y - 6) >= 0).toBe(x === 4);
  });

  it('places nothing when a belt run cannot be paid for or is blocked', async () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    const host = headlessHost(sim);
    const before = sim.count - sim.freeCount;
    await expect(runTool(host, 'build_belt', { path: [[5, 5], [80, 5]] })).rejects.toThrow(/Not enough timber/);
    await expect(runTool(host, 'build_belt', { path: [[-5, 0], [5, 0]] })).rejects.toThrow(ToolError);
    await expect(runTool(host, 'build_belt', { path: [[5, 5], [8, 9]] })).rejects.toThrow(/share an x or a y/);
    expect(sim.count - sim.freeCount).toBe(before);
    expect(sim.stock[itemId('timber')]).toBe(60);
    const ok = await runTool(host, 'build_belt', { path: [[5, 5], [5, 2], [2, 2]], end_dir: 'N' });
    expect(ok).toContain('Laid 7 belts');
    expect(sim.dir[sim.world.buildingAt(HUB_X + 2, HUB_Y + 2)]).toBe(3);
    expect(await runTool(host, 'remove', { from: [2, 2], to: [5, 5] })).toContain('Removed 7 belt');
    expect(sim.stock[itemId('timber')]).toBe(60);
  });

  it('reports dead ends, jams and unfed machines', async () => {
    const sim = testSim();
    const host = headlessHost(sim);
    const x = HUB_X - 64; // timber on the test map's deposit rows
    const y = HUB_Y - 40;
    place(sim, MINER, x, y, SOUTH);
    place(sim, BELT, x, y + 1, SOUTH);
    place(sim, KILN, x, y + 2, SOUTH); // first kiln recipe is bricks, which takes stone
    place(sim, KILN, x + 5, y + 5, SOUTH);
    sim.applyQueued();
    await runTool(host, 'wait', { seconds: 10 });
    const found = problems(sim).join('\n');
    expect(found).toMatch(/carries timber into the kiln .* does not use it/);
    expect(found).toMatch(/kiln \(-59,-35\) \(bricks\) has nothing feeding it/);
    expect(found).toMatch(/kiln \(-64,-38\) facing S points at empty ground/);
    // Switching the recipe to one that takes timber clears the jam.
    await runTool(host, 'set_recipe', { x: -64, y: -38, recipe: 'charcoal' });
    await runTool(host, 'wait', { seconds: 5 });
    expect(problems(sim).join('\n')).not.toMatch(/does not use it/);
  });

  it('hands placements and removals to a host that wants to act them out', async () => {
    const sim = new Sim({ seed: 3, worldType: 'test' });
    const staged: string[] = [];
    const host = {
      ...headlessHost(sim),
      // Applies each step only after recording it, the way the game does once the hand lands.
      stage: async (steps: { building: number; x: number; y: number }[], apply: (i: number) => void) => {
        for (let i = 0; i < steps.length; i++) {
          expect(sim.world.buildingAt(steps[i].x, steps[i].y) >= 0).toBe(steps[i].building === 0);
          staged.push(`${steps[i].building}@${steps[i].x - HUB_X},${steps[i].y - HUB_Y}`);
          apply(i);
        }
      },
    };
    expect(await runTool(host, 'build_belt', { path: [[4, 4], [6, 4]] })).toContain('Laid 3 belts');
    expect(await runTool(host, 'build', { building: 'belt', x: 7, y: 4, dir: 'E' })).toContain('Built belt');
    expect(await runTool(host, 'remove', { from: [4, 4], to: [7, 4] })).toContain('Removed 4 belt');
    expect(staged).toEqual([
      `${BELT}@4,4`, `${BELT}@5,4`, `${BELT}@6,4`, `${BELT}@7,4`,
      '0@4,4', '0@5,4', '0@6,4', '0@7,4',
    ]);
    expect(sim.count - sim.freeCount).toBe(1);
  });

  it('gives every tool a schema the API accepts', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.input_schema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});

describe('agent loop', () => {
  /** Stands in for the API client: replies with the next scripted set of tool calls. */
  function scripted(turns: { name: string; input: unknown }[][]): { client: Anthropic; requests: Anthropic.Beta.MessageCreateParams[] } {
    const requests: Anthropic.Beta.MessageCreateParams[] = [];
    let n = 0;
    // A reply arrives the way the API streams it: each block is opened, filled in pieces, and the whole message follows.
    const stream = (params: Anthropic.Beta.MessageCreateParams) => {
      requests.push(structuredClone(params));
      const calls = turns[n++] ?? [];
      const message = {
        content: calls.length
          ? calls.map((c, i) => ({ type: 'tool_use', id: `call_${n}_${i}`, name: c.name, input: c.input }))
          : [{ type: 'text', text: 'Nothing more to do.' }],
        stop_reason: calls.length ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      return {
        async *[Symbol.asyncIterator]() {
          for (const [index, block] of message.content.entries()) {
            yield { type: 'content_block_start', index, content_block: block };
            if ('input' in block) {
              const json = JSON.stringify(block.input);
              yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 3) } };
              yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(3) } };
            } else {
              yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
            }
          }
          if (failNext > 0) {
            failNext--;
            throw new Anthropic.APIConnectionError({ message: 'socket closed' });
          }
        },
        finalMessage: async () => message,
      };
    };
    return { client: { beta: { messages: { stream } } } as unknown as Anthropic, requests };
  }
  /** How many of the coming replies break off after their pieces have arrived. */
  let failNext = 0;

  it('runs tool calls against the game and feeds the results back', async () => {
    const sim = new Sim({ seed: 3 });
    const [x, y] = depositNear(sim, 'timber');
    const { client, requests } = scripted([
      [{ name: 'get_state', input: {} }],
      [{ name: 'build', input: { building: 'miner', x, y, dir: 'E' } }, { name: 'connect', input: { from: [x, y], to: [0, 0] } }],
      [{ name: 'build', input: { building: 'miner', x: 0, y: 0, dir: 'E' } }],
      [{ name: 'wait', input: { seconds: 120 } }],
    ]);
    const events: string[] = [];
    const result = await runAgent({ client, host: headlessHost(sim), maxTurns: 5, onEvent: (e) => events.push(e.type === 'tool' ? `${e.name}:${e.error}` : e.type) });
    expect(sim.delivered[itemId('timber')]).toBeGreaterThan(20);
    expect(result.reason).toBe('turn_limit');
    expect(result.usage.turns).toBe(5);
    expect(events.filter((e) => e.includes(':'))).toEqual(['get_state:false', 'build:false', 'connect:false', 'build:true', 'wait:false']);
    // Both results of the two-call turn go back in one message, and the failed build is marked as an error.
    const third = requests[2].messages;
    const results = third[third.length - 1].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['call_2_0', 'call_2_1']);
    const failed = (requests[3].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
    expect(failed.is_error).toBe(true);
    expect(failed.content).toContain('Cannot build miner');
    // The model went quiet on the last turn and was told to keep playing.
    expect(requests.length).toBe(5);
  });

  it('reports a reply as it arrives, before the turn is finished', async () => {
    const sim = new Sim({ seed: 3 });
    const { client } = scripted([[{ name: 'get_state', input: {} }, { name: 'wait', input: { seconds: 5 } }]]);
    const events: AgentEvent[] = [];
    await runAgent({ client, host: headlessHost(sim), maxTurns: 2, onEvent: (e) => events.push(e) });
    const turn = events.slice(0, events.findIndex((e, i) => i > 0 && e.type === 'request'));
    expect(turn.map((e) => (e.type === 'partial' ? `partial:${e.kind}:${e.index}` : e.type === 'tool_start' || e.type === 'tool' ? `${e.type}:${e.index}` : e.type))).toEqual([
      'request',
      'partial:tool:0', 'partial:tool:0', 'partial:tool:0',
      'partial:tool:1', 'partial:tool:1', 'partial:tool:1',
      'usage',
      'tool_start:0', 'tool:0', 'tool_start:1', 'tool:1',
    ]);
    // The call is named as soon as it starts, and its input arrives in pieces that add up to the whole.
    const second = turn.filter((e) => e.type === 'partial' && e.index === 1) as Extract<AgentEvent, { type: 'partial' }>[];
    expect(second[0].name).toBe('wait');
    expect(JSON.parse(second.map((e) => e.delta).join(''))).toEqual({ seconds: 5 });
    // The last turn was text, streamed and then given whole.
    const last = events.slice(events.length - 4).map((e) => e.type);
    expect(last).toEqual(['request', 'partial', 'usage', 'text']);
  });

  it('asks again when a reply breaks off part-way, and voids what it had shown', async () => {
    const sim = new Sim({ seed: 3 });
    const { client, requests } = scripted([[{ name: 'get_state', input: {} }], [{ name: 'get_state', input: {} }]]);
    failNext = 1;
    const events: string[] = [];
    const result = await runAgent({ client, host: headlessHost(sim), maxTurns: 1, onEvent: (e) => events.push(e.type) });
    expect(events.slice(0, 7)).toEqual(['request', 'partial', 'partial', 'partial', 'discard', 'notice', 'request']);
    // The broken reply was never run or added to the conversation.
    expect(events.filter((e) => e === 'tool')).toHaveLength(1);
    expect(requests[1].messages).toHaveLength(1);
    expect(result.usage.turns).toBe(1);
    // Three in a row is given up on.
    failNext = 3;
    const failed = await runAgent({ client, host: headlessHost(sim), maxTurns: 5 });
    expect(failed.reason).toBe('error');
    failNext = 0;
  });

  it('stops when the game is already won or the budget is spent', async () => {
    const sim = new Sim({ seed: 3 });
    const { client } = scripted(Array.from({ length: 50 }, () => [{ name: 'get_state', input: {} }]));
    const spent = await runAgent({ client, host: headlessHost(sim), maxCostUsd: 0.002 });
    expect(spent.reason).toBe('budget');
    expect(spent.usage.turns).toBeLessThan(10);
    sim.goalIndex = GOALS.length;
    expect((await runAgent({ client, host: headlessHost(sim) })).reason).toBe('won');
  });
});
