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
- Belts that point into the **town hub** deliver. Each delivery list unlocks
  the next building, recipe or resource.
- Machines are tinted amber when they are waiting for inputs and red when
  nothing in front of them takes their output.

The game saves itself every 30 seconds and picks up where you left off. The
menu also has save, load, export to a file and import from a file.

## Development

```bash
npm test          # simulation tests, a full scripted playthrough, tick benchmark
npm run bench     # tick benchmark only
npm run typecheck
npm run build
```

| Folder | Holds |
| --- | --- |
| `src/sim/` | The simulation: map, buildings, belts, machines, town, commands, save format. Imports nothing from the other folders |
| `src/content/` | Items, recipes, buildings, delivery lists and balance numbers as data |
| `src/render/` | Three.js scene, camera, procedural models, instanced buildings, belt items |
| `src/ui/` | React interface over the canvas |
| `src/tools/` | Benchmark factory generator |
| `src/game.ts` | Input to commands, the fixed-rate loop, the summary the interface reads |
| `tests/` | Headless Vitest suites |

The simulation is deterministic: integer math only, a fixed order of steps in
every tick, and every player action is a command. The tests check that the same
seed and commands give the same state, that a save reloaded halfway gives the
same state, and that a game replays exactly from its command log.
