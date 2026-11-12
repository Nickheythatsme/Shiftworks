// Runs an AI player against a headless game, as fast as the model answers.
//
//   npm run ai -- --model claude-sonnet-5-5 --max-cost 3 --seed 7
//
// Writes the finished factory as a .shft save (load it in the game with
// Menu > Import from file) and a transcript of the session to ai-runs/.

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, runAgent, type Effort } from '../src/agent/agent';
import { headlessHost } from '../src/agent/tools';
import { GOALS, TICKS_PER_SECOND } from '../src/content/content';
import { Sim, saveSim } from '../src/sim';
import { DEFAULT_KEY_FILE, loadApiKey } from './apiKey';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error(`No API key. Set ANTHROPIC_API_KEY or put a key in ${DEFAULT_KEY_FILE}.`);
  process.exit(1);
}

const model = flag('model') ?? DEFAULT_MODEL;
const seed = Number(flag('seed') ?? 1);
const maxTurns = Number(flag('max-turns') ?? 400);
const maxCostUsd = Number(flag('max-cost') ?? 5);
const effort = (flag('effort') ?? 'medium') as Effort;

const sim = new Sim({ seed });
const client = new Anthropic({ apiKey, maxRetries: 4 });

const dir = 'ai-runs';
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const transcript = join(dir, `${stamp}.jsonl`);
const savePath = join(dir, `${stamp}.shft`);

const controller = new AbortController();
process.on('SIGINT', () => {
  console.log('\nStopping after the current step...');
  controller.abort();
});

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s*\n\s*/g, ' | ');
  return flat.length > max ? flat.slice(0, max) + '...' : flat;
}

console.log(`Model ${model}, effort ${effort}, seed ${seed}, limits: ${maxTurns} turns, $${maxCostUsd}.`);
let goalSeen = 0;
const result = await runAgent({
  client,
  host: headlessHost(sim),
  model,
  effort,
  maxTurns,
  maxCostUsd,
  signal: controller.signal,
  onEvent: (event) => {
    appendFileSync(transcript, JSON.stringify({ gameSeconds: Math.floor(sim.tick / TICKS_PER_SECOND), ...event }) + '\n');
    switch (event.type) {
      case 'thinking': console.log(`\x1b[2m  (thinking) ${oneLine(event.text, 300)}\x1b[0m`); break;
      case 'text': console.log(`\n${event.text}`); break;
      case 'notice': console.log(`  [${event.text}]`); break;
      case 'tool':
        console.log(`  ${event.error ? '\x1b[31m✗\x1b[0m' : '>'} ${event.name} ${JSON.stringify(event.input)}`);
        console.log(`\x1b[2m    ${oneLine(event.result)}\x1b[0m`);
        break;
      case 'usage':
        if (sim.goalIndex !== goalSeen || event.usage.turns % 10 === 0) {
          goalSeen = sim.goalIndex;
          console.log(`  [turn ${event.usage.turns}, list ${Math.min(sim.goalIndex + 1, GOALS.length)}/${GOALS.length}, game ${(sim.tick / TICKS_PER_SECOND / 60).toFixed(1)}m, ~$${event.usage.costUsd.toFixed(2)}]`);
        }
        break;
    }
  },
});

writeFileSync(savePath, saveSim(sim));
const u = result.usage;
console.log(`\n${result.reason}: ${result.detail}`);
console.log(`Delivery lists complete: ${sim.goalIndex} of ${GOALS.length}. Game time ${(sim.tick / TICKS_PER_SECOND / 60).toFixed(1)} minutes. Buildings: ${sim.count - sim.freeCount - 1}.`);
console.log(`Turns ${u.turns}. Tokens: ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadTokens} cache read, ${u.cacheWriteTokens} cache write. Estimated cost $${u.costUsd.toFixed(2)}.`);
console.log(`Save: ${savePath}\nTranscript: ${transcript}`);
