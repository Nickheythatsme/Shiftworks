// The "AI plays" panel: start and stop an AI player and watch what it is
// thinking and doing. The factory it builds appears on the map as it goes.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MODELS, type Effort } from '../agent/agent';
import type { AiSession, AiState, LogEntry } from '../agent/session';

const SPEEDS = [2, 4, 8, 16, 32];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const BUDGETS = [1, 2, 5, 10, 20];

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

function Entry({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === 'text') return <div className="ai-entry say">{entry.body}</div>;
  if (entry.kind === 'notice') return <div className="ai-entry note">{entry.body}</div>;
  if (entry.kind === 'end') return <div className={`ai-entry end${entry.error ? ' bad' : ''}`}><strong>{entry.title}.</strong> {entry.body}</div>;
  if (entry.kind === 'thinking') return <div className="ai-entry think">{entry.body}</div>;
  const firstLine = entry.body.split('\n')[0];
  const long = entry.body.length > firstLine.length || firstLine.length > 110;
  return (
    <div className={`ai-entry tool${entry.error ? ' bad' : ''}`}>
      <button className="ai-call" onClick={() => setOpen(!open)} disabled={!long} title={long ? 'Show the full result' : undefined}>
        <span className="ai-time">{clock(entry.seconds)}</span>
        <code>{entry.title}</code>
      </button>
      <pre className={open ? 'open' : ''}>{open ? entry.body : firstLine}</pre>
    </div>
  );
}

/** Where the API key comes from: one pasted here, or the dev server's own. */
function KeyRow({ session, state, running }: { session: AiSession; state: AiState; running: boolean }) {
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(false);
  const [editing, setEditing] = useState(false);
  if (state.keyHint && !editing) {
    return (
      <div className="ai-key set">
        <span>Using your API key ending in <code>{state.keyHint}</code>{state.rememberKey ? ', saved in this browser' : ''}.</span>
        <button disabled={running} onClick={() => session.clearKey()}>Remove</button>
      </div>
    );
  }
  if (state.available && !editing) {
    return (
      <div className="ai-key set">
        <span className="muted">Using the API key from the dev server.</span>
        <button disabled={running} onClick={() => setEditing(true)}>Use my own</button>
      </div>
    );
  }
  const save = () => {
    if (!draft.trim()) return;
    session.setKey(draft, remember);
    setDraft('');
    setEditing(false);
  };
  return (
    <form className="ai-key" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label htmlFor="ai-key-input">Anthropic API key</label>
      <div className="ai-key-row">
        <input
          id="ai-key-input" type="password" value={draft} placeholder="sk-ant-..." autoComplete="off" spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className={draft.trim() ? 'active' : ''} disabled={!draft.trim()}>Use key</button>
        {editing && <button type="button" onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>}
      </div>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember it in this browser
      </label>
      <p className="muted small">The key is sent only to the Claude API, straight from this page. Playing spends on that key, up to the limit below.</p>
    </form>
  );
}

export function AiPanel({ session, onClose }: { session: AiSession; onClose: () => void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const running = state.status !== 'idle';
  const canStart = state.keyHint !== '' || state.available === true;

  // Keep the newest entry in view unless the reader has scrolled up to look back.
  useEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.log]);

  return (
    <section className="panel ai">
      <header>
        <h2>AI plays</h2>
        <button className="ghost" onClick={onClose} aria-label="Close">×</button>
      </header>
      <KeyRow session={session} state={state} running={running} />
      <div className="ai-options">
        <label>Model
          <select value={state.model} disabled={running} onChange={(e) => session.configure({ model: e.target.value })}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label>Effort
          <select value={state.effort} disabled={running} onChange={(e) => session.configure({ effort: e.target.value as Effort })}>
            {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
        <label>Spend up to
          <select value={state.maxCostUsd} disabled={running} onChange={(e) => session.configure({ maxCostUsd: Number(e.target.value) })}>
            {BUDGETS.map((b) => <option key={b} value={b}>${b}</option>)}
          </select>
        </label>
        <label>Wait speed
          <select value={state.speed} onChange={(e) => session.configure({ speed: Number(e.target.value) })}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={state.follow} onChange={(e) => session.configure({ follow: e.target.checked })} />
          Camera follows
        </label>
      </div>
      <div className="row">
        {state.status === 'idle' ? (
          <button className="active" disabled={!canStart} onClick={() => void session.start()}>
            {state.log.length ? 'Start again' : 'Start'}
          </button>
        ) : (
          <button className="danger" disabled={state.status === 'stopping'} onClick={() => session.stop()}>
            {state.status === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {state.usage && (
          <span className="muted small ai-usage">
            {state.usage.turns} turns · {tokens(state.usage.inputTokens + state.usage.cacheReadTokens + state.usage.cacheWriteTokens)} in · {tokens(state.usage.outputTokens)} out · about ${state.usage.costUsd.toFixed(2)}
          </span>
        )}
      </div>
      {state.log.length === 0 && !running && (
        <p className="muted small">
          The AI plays the map you have open, with the same buildings and costs you have. Time stands still while it thinks and runs fast while it waits for the factory.
        </p>
      )}
      {(state.log.length > 0 || running) && (
        <div
          className="ai-log"
          ref={log}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {state.log.map((entry) => <Entry key={entry.id} entry={entry} />)}
          {state.status === 'running' && <div className="ai-entry note">Working…</div>}
        </div>
      )}
    </section>
  );
}
