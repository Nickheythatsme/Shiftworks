// The interface sits over the canvas. It reads a small summary of the game a
// few times a second and never touches the simulation directly.

import { useRef, useState, useSyncExternalStore } from 'react';
import type { Game, UiState } from '../game';

const ARROWS = ['→', '↓', '←', '↑'];
const SPEEDS = [1, 2, 4];

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

function TownPanel({ state }: { state: UiState }) {
  return (
    <section className="panel town">
      <header>
        <span className="stage">{state.stage}</span>
        <span className="muted">Delivery {state.goalNumber} of {state.goalCount}</span>
      </header>
      <h2>{state.goalTitle}</h2>
      <p className="muted">{state.goalText}</p>
      {state.needs.map((need) => (
        <div className="need" key={need.name}>
          <div className="need-row">
            <span><i className="swatch" style={{ background: need.color }} />{need.name}</span>
            <span className={need.have >= need.need ? 'done' : ''}>{need.have} / {need.need}</span>
          </div>
          <div className="bar"><div style={{ width: `${(100 * need.have) / need.need}%`, background: need.color }} /></div>
        </div>
      ))}
      {state.rewards.length > 0 && <p className="reward">Unlocks: {state.rewards.join(', ')}</p>}
      <div className="stock">
        <span className="muted">Building materials in the hub</span>
        {state.stock.length === 0 && <span className="short">None. Deliver goods, or remove a building to get its materials back.</span>}
        {state.stock.map((s) => (
          <span key={s.name} title={s.name}><i className="swatch" style={{ background: s.color }} />{s.name} {s.count}</span>
        ))}
      </div>
    </section>
  );
}

function Selected({ game, state }: { game: Game; state: UiState }) {
  const sel = state.selected;
  if (!sel) return null;
  return (
    <section className="panel selected">
      <header>
        <h2>{sel.name}</h2>
        <button className="ghost" onClick={() => game.setTool({ mode: 'none' })} aria-label="Close">×</button>
      </header>
      {sel.status && <p className={`status ${sel.statusKind}`}>{sel.status}</p>}
      {sel.detail.map((line) => <p className="muted" key={line}>{line}</p>)}
      {sel.recipes.length > 0 && (
        <div className="recipes">
          <span className="muted">Recipe</span>
          {sel.recipes.map((r) => (
            <button key={r.id} className={r.id === sel.recipe ? 'active' : ''} onClick={() => game.setRecipe(r.id)}>
              <strong>{r.name}</strong>
              <small>{r.text}</small>
            </button>
          ))}
        </div>
      )}
      {sel.name !== 'Town hub' && (
        <div className="row">
          <button onClick={() => game.rotateSelected()}>Rotate</button>
          <button onClick={() => game.removeSelected()}>Remove</button>
        </div>
      )}
    </section>
  );
}

function TopRight({ game, state }: { game: Game; state: UiState }) {
  const [menu, setMenu] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [perf, setPerf] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="top-right">
      <section className="panel controls">
        <span className="clock">{clock(state.seconds)}</span>
        <button className={state.paused ? 'active' : ''} onClick={() => game.togglePause()} title="Pause (Space)">
          {state.paused ? 'Paused' : 'Pause'}
        </button>
        {SPEEDS.map((s) => (
          <button key={s} className={!state.paused && state.speed === s ? 'active' : ''} onClick={() => game.setSpeed(s)}>
            {s}x
          </button>
        ))}
        <button className={menu ? 'active' : ''} onClick={() => { setMenu(!menu); setConfirmNew(false); }}>Menu</button>
      </section>
      {menu && (
        <section className="panel menu">
          <button onClick={() => void game.save()}>Save</button>
          <button onClick={() => void game.load()}>Load</button>
          <button onClick={() => game.exportSave()}>Export to file</button>
          <button onClick={() => file.current?.click()}>Import from file</button>
          <input
            ref={file} type="file" accept=".shft" hidden
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void game.importSave(picked);
              e.target.value = '';
            }}
          />
          <button onClick={() => setPerf(!perf)}>{perf ? 'Hide' : 'Show'} performance</button>
          {confirmNew ? (
            <button className="danger" onClick={() => { game.newGame(); setConfirmNew(false); setMenu(false); }}>
              Really start over?
            </button>
          ) : (
            <button onClick={() => setConfirmNew(true)}>New map</button>
          )}
          <p className="muted small">The game saves itself every 30 seconds.</p>
        </section>
      )}
      {perf && (
        <section className="panel perf">
          <span>{state.perf.fps.toFixed(0)} frames/s</span>
          <span>tick {state.perf.tickMs.toFixed(3)} ms</span>
          <span>frame {state.perf.frameMs.toFixed(2)} ms</span>
          <span>{state.perf.drawCalls} draw calls</span>
          <span>{state.perf.items} items on belts</span>
          <span>{state.perf.buildings} buildings</span>
        </section>
      )}
    </div>
  );
}

function BuildBar({ game, state }: { game: Game; state: UiState }) {
  const tool = state.tool;
  const active = tool.mode === 'build' ? state.buildBar.find((b) => b.id === tool.building) : undefined;
  return (
    <div className="bottom">
      {state.message && <div className="message">{state.message}</div>}
      <div className="hint">
        {active
          ? `${active.hint} Costs ${active.cost.map((c) => `${c.count} ${c.name.toLowerCase()}`).join(' + ')}. Facing ${ARROWS[state.toolDir]}, R turns it.`
          : tool.mode === 'delete'
            ? 'Click or drag to remove buildings. Their materials go back to the hub.'
            : state.hover || 'Pick something to build, or click a building to inspect it.'}
      </div>
      <section className="panel build-bar">
        {state.buildBar.map((b) => (
          <button
            key={b.id}
            className={(tool.mode === 'build' && tool.building === b.id ? 'active' : '') + (b.affordable ? '' : ' poor')}
            onClick={() => game.setTool(tool.mode === 'build' && tool.building === b.id ? { mode: 'none' } : { mode: 'build', building: b.id })}
            title={`${b.hint} Costs ${b.cost.map((c) => `${c.count} ${c.name.toLowerCase()}`).join(', ')}.`}
          >
            <span className="build-name">
              <i className="chip" style={{ background: b.color }} />
              <span>{b.name}</span>
              <kbd>{b.hotkey}</kbd>
            </span>
            <span className="cost">
              {b.cost.map((c) => (
                <span key={c.name} className={c.enough ? '' : 'short'}>
                  <i className="swatch" style={{ background: c.color }} />{c.count}
                </span>
              ))}
            </span>
          </button>
        ))}
        <button
          className={tool.mode === 'delete' ? 'active danger' : ''}
          onClick={() => game.setTool(tool.mode === 'delete' ? { mode: 'none' } : { mode: 'delete' })}
          title="Remove buildings. Right-click also removes."
        >
          <span className="build-name">
            <i className="chip remove" />
            <span>Remove</span>
            <kbd>X</kbd>
          </span>
          <span className="cost">materials back</span>
        </button>
      </section>
      <div className="keys">
        WASD move · wheel zoom · Q/E turn view · R rotate · F copy building · right-click remove · Esc cancel · Space pause
      </div>
    </div>
  );
}

export function App({ game }: { game: Game }) {
  const state = useSyncExternalStore(game.subscribe, game.getState);
  if (!state.ready) return null;
  return (
    <>
      <div className="top-left">
        <TownPanel state={state} />
        <Selected game={game} state={state} />
      </div>
      <TopRight game={game} state={state} />
      <div className="toasts">
        {state.toasts.map((t) => <div className="toast" key={t.id}>{t.text}</div>)}
      </div>
      <BuildBar game={game} state={state} />
      {state.won && (
        <div className="win">
          <section className="panel">
            <h1>The hamlet thrives</h1>
            <p>Every delivery list is complete, in {clock(state.seconds)} of game time.</p>
            <p className="muted">This is the end of the first version. The factory keeps running if you want to keep building.</p>
            <button className="active" onClick={() => game.dismissWin()}>Keep building</button>
          </section>
        </div>
      )}
    </>
  );
}
