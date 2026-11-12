// Finds the Anthropic API key for local runs. The key stays on this machine's
// Node side: the command-line runner uses it directly and the dev server adds
// it to requests it forwards, so it never reaches the browser.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_KEY_FILE = join(homedir(), 'shiftworks-api-key.txt');

/** ANTHROPIC_API_KEY, else the file named by SHIFTWORKS_API_KEY_FILE, else ~/shiftworks-api-key.txt. */
export function loadApiKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.SHIFTWORKS_API_KEY_FILE ?? DEFAULT_KEY_FILE;
  if (!existsSync(file)) return null;
  const key = readFileSync(file, 'utf8').trim();
  return key || null;
}
