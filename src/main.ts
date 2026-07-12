import { newGame } from "./game";
import {
  Renderer,
  renderHUD,
  renderInventory,
  renderMessages,
  showEndOverlay,
  hideOverlay,
  hideHelp,
} from "./render";
import { setupInput } from "./input";
import type { GameState } from "./types";

let state: GameState;
let endShown = false;

function refresh(): void {
  renderer.render(state);
  renderHUD(state);
  renderInventory(state);
  renderMessages(state);

  if (state.phase === "dead" || state.phase === "won") {
    if (!endShown) {
      endShown = true;
      hideHelp();
      showEndOverlay(state, state.phase === "won" ? "won" : "dead", startGame);
    }
  } else {
    endShown = false;
  }
}

const canvas = document.getElementById("dungeon") as HTMLCanvasElement;
const renderer = new Renderer(canvas);

function startGame(): void {
  hideOverlay();
  hideHelp();
  endShown = false;
  state = newGame();
  refresh();
}

setupInput(refresh, () => state);
startGame();

// Click backdrop / outside help box closes help
document.getElementById("help-panel")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "help-panel") hideHelp();
});

// Responsive canvas: re-fit tiles when the panel size changes
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state) renderer.render(state);
  }, 80);
});
