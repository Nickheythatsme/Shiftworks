import { createRoot } from 'react-dom/client';
import { Game } from './game';
import { App } from './ui/App';
import './ui/styles.css';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
// Handy when poking at the game from the browser console.
(window as unknown as { game: Game }).game = game;
createRoot(document.getElementById('ui')!).render(<App game={game} />);
void game.start();
