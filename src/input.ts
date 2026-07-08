import type { GameState } from "./types";
import { DIRECTIONS } from "./types";
import {
  tryMove,
  waitTurn,
  tryDescend,
  openInventory,
  closeInventory,
  selectInventoryItem,
} from "./game";

export type InputHandler = (state: GameState) => void;

export function handleKeydown(
  state: GameState,
  key: string,
  onUpdate: InputHandler
): void {
  if (state.phase === "dead" || state.phase === "won") return;

  if (state.phase === "inventory") {
    if (key === "Escape" || key === "i") {
      closeInventory(state);
      onUpdate(state);
      return;
    }
    const num = parseInt(key, 10);
    if (!isNaN(num)) {
      const idx = num === 0 ? 9 : num - 1;
      selectInventoryItem(state, idx);
      onUpdate(state);
    }
    return;
  }

  if (key === "i") {
    openInventory(state);
    onUpdate(state);
    return;
  }

  if (key === "." || key === "s") {
    waitTurn(state);
    onUpdate(state);
    return;
  }

  if (key === ">" || key === "G") {
    tryDescend(state);
    onUpdate(state);
    return;
  }

  if (key === "Q") {
    if (confirm("Really quit? Your progress will be lost.")) {
      state.phase = "dead";
      state.player.alive = false;
      onUpdate(state);
    }
    return;
  }

  const dir = DIRECTIONS[key];
  if (dir) {
    tryMove(state, dir);
    onUpdate(state);
  }
}

export function setupInput(onUpdate: InputHandler, getState: () => GameState): void {
  window.addEventListener("keydown", (e) => {
    const keys = [
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "h", "j", "k", "l", "y", "u", "b", "n",
      "i", ".", "s", ">", "G", "Q", "Escape",
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    handleKeydown(getState(), e.key, onUpdate);
  });
}