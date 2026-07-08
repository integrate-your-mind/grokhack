import { newGame } from "./game";
import {
  Renderer,
  renderHUD,
  renderInventory,
  renderMessages,
  showOverlay,
  hideOverlay,
} from "./render";
import { setupInput } from "./input";
import type { GameState } from "./types";

let state: GameState;

function refresh(): void {
  renderer.render(state);
  renderHUD(state);
  renderInventory(state);
  renderMessages(state);

  if (state.phase === "dead") {
    const p = state.player;
    showOverlay(
      "You Died",
      `The dungeon claims another soul.<br><br>
       Depth reached: ${p.depth}<br>
       Level: ${p.level}<br>
       Gold: ${p.gold}<br>
       Turns: ${p.turns}<br>
       Seed: ${state.seed}`,
      startGame
    );
  } else if (state.phase === "won") {
    const p = state.player;
    showOverlay(
      "Victory!",
      `You have conquered the depths!<br><br>
       Level: ${p.level}<br>
       Gold: ${p.gold}<br>
       Turns: ${p.turns}<br>
       Seed: ${state.seed}`,
      startGame
    );
  }
}

const canvas = document.getElementById("dungeon") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

function startGame(): void {
  hideOverlay();
  state = newGame();
  refresh();
}

setupInput(refresh, () => state);
startGame();