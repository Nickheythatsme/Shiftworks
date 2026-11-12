import { createRoot } from 'react-dom/client';
import { AiSession } from './agent/session';
import { Game } from './game';
import { App } from './ui/App';
import './ui/styles.css';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
// Handy when poking at the game from the browser console.
(window as unknown as { game: Game }).game = game;
const ai = new AiSession(game);
createRoot(document.getElementById('ui')!).render(<App game={game} ai={ai} />);
void game.start();
