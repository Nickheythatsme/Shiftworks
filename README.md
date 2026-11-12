# Shiftworks

A single-player factory builder that runs in a browser tab. Mine resources,
move them on belts, turn them into parts, and deliver them to the town to
unlock the next step.

This build covers milestones 1 to 4 of the design: the map and camera, belts and
miners, machines and recipes, and the town with unlocks and saves. The moving
map (milestone 5) is not built yet.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Controls

| Action | Input |
| --- | --- |
| Move the view | W A S D, arrow keys, or drag with the middle mouse button |
| Zoom | Mouse wheel |
| Turn the view a quarter turn | Q and E |
| Pick a building | Click the build bar, or keys 1 to 6 |
| Place | Left click. Drag to lay belts; they turn to follow the drag |
| Turn the building you are placing | R (Shift+R the other way) |
| Turn a placed building | Hover it and press R with no tool selected |
| Remove | Right click or drag, or X for the remove tool |
| Copy the building under the cursor | F |
| Inspect a building, choose a recipe | Left click it with no tool selected |
| Cancel | Esc |
| Pause | Space. You can build while paused |

## How the factory works

- A **miner** goes on a deposit and pushes the resource out of its front (the
  yellow chute).
- A **belt** carries items forward. Point a belt into the side of another belt
  to merge two lines.
- A **machine** takes inputs from any belt that points into it and pushes its
  product out of its front. There are no inserters: orientation is the puzzle.
- A **splitter** takes items from behind and shares them between its front,
  left and right.
- **Every building costs materials**, taken from what has been delivered to the
  hub. Belts and miners take raw timber and stone; kilns, splitters and
  assemblers take parts the factory has to make first. Removing a building
  returns its materials in full. A new game starts with 60 timber and 20 stone.
- Belts that point into the **town hub** deliver. Deliveries count toward the
  current list and also become building materials. Each delivery list unlocks
  the next building, recipe or resource.
- **Blue means in, orange means out.** Every building has glowing blue arrows
  on the sides it takes items from and an orange arrow where it pushes them
  out. Larger floating arrows show the same thing on the building you are
  placing, pointing at, or have selected.
- Each machine has a status lamp: green when working, amber when waiting for
  inputs, red when nothing in front of it takes its output, grey with no recipe.
  A starved or blocked machine also takes on an amber or red wash and its
  moving parts stop.

The game saves itself every 30 seconds and picks up where you left off. The
menu also has save, load, export to a file and import from a file.

## AI plays

An AI player can play the game for you. It works through the delivery lists
with the same buildings, costs and rules you have, and it sees the game as
text: it reads the state, looks at a character map, places buildings, routes
belts and then waits to see what the factory delivers.

**In the game.** Run `npm run dev`, click **AI plays** at the top right, paste
an Anthropic API key into the panel, and press Start. The AI takes over the map
you have open, wherever you have got to. Time stands still while it thinks and
runs fast while it waits for the factory; the panel shows its reasoning, each
action and what came back, and a running cost estimate. Stop hands the game
back to you.

A pasted key is sent only to the Claude API, straight from the page. It is
forgotten when the page closes unless you tick "Remember it in this browser",
which keeps it in the browser's local storage. Playing spends on that key, up
to the limit set in the panel.

You can skip the pasting when running the dev server: if `ANTHROPIC_API_KEY` is
set, or a key is in `~/shiftworks-api-key.txt` (set `SHIFTWORKS_API_KEY_FILE`
to use another file), the dev server adds that key to the requests it forwards
and the panel uses it without the key ever reaching the browser.

**From the command line.** This plays a fresh map with no window, as fast as
the model answers. It reads the key from the same environment variable or file:

```bash
npm run ai -- --seed 7 --max-cost 3
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model` | `claude-opus-5-5` | Any Claude model id |
| `--effort` | `medium` | How hard the model thinks: `low`, `medium`, `high`, `xhigh` |
| `--seed` | `1` | Map seed |
| `--max-cost` | `5` | Stop once the estimated spend passes this many dollars |
| `--max-turns` | `400` | Stop after this many model calls |

Each run writes two files to `ai-runs/`: the finished factory as a `.shft` save
you can open with Menu, Import from file, and a transcript of everything the
AI thought, did and was told.

The AI's tools are `get_state`, `view_map`, `find_deposits`, `inspect`,
`build`, `build_belt`, `connect` (routes a belt between two buildings),
`set_recipe`, `remove` and `wait`. Game time only passes inside `wait`, so a
slow model is not punished for thinking.

## Development

```bash
npm test          # simulation tests, a full scripted playthrough, AI tool tests, tick benchmark
npm run ai        # an AI plays a headless game (uses the API, costs money)
npm run bench     # tick benchmark only
npm run typecheck
npm run build
```

| Folder | Holds |
| --- | --- |
| `src/sim/` | The simulation: map, buildings, belts, machines, town, commands, save format. Imports nothing from the other folders |
| `src/content/` | Items, recipes, buildings, delivery lists and balance numbers as data |
| `src/render/` | Three.js scene, camera, procedural models, terrain, water, scenery, belt items. All motion runs in shaders |
| `src/ui/` | React interface over the canvas |
| `src/agent/` | The AI player: its tools over the simulation, the model loop, the browser session |
| `src/tools/` | Benchmark factory generator |
| `scripts/` | Command-line AI runner and API key lookup |
| `src/game.ts` | Input to commands, the fixed-rate loop, the summary the interface reads |
| `tests/` | Headless Vitest suites |

The simulation is deterministic: integer math only, a fixed order of steps in
every tick, and every player action is a command. The tests check that the same
seed and commands give the same state, that a save reloaded halfway gives the
same state, and that a game replays exactly from its command log.
