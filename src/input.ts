import type { GameState } from "./types";
import { DIRECTIONS } from "./types";
import {
  tryMove,
  waitTurn,
  tryDescend,
  trySearch,
  trySpecialInteract,
  openInventory,
  closeInventory,
  selectInventoryItem,
} from "./game";
import { toggleHelp, isHelpOpen, hideHelp } from "./render";

export type InputHandler = (state: GameState) => void;

export function handleKeydown(
  state: GameState,
  key: string,
  onUpdate: InputHandler
): void {
  // Help is always available (even on death screen, for learning)
  if (key === "?" || key === "SlashHelp") {
    toggleHelp();
    return;
  }

  if (key === "Escape" && isHelpOpen()) {
    hideHelp();
    return;
  }

  if (state.phase === "dead" || state.phase === "won") return;

  // Close help on any real game action
  if (isHelpOpen() && key !== "?" && key !== "SlashHelp") {
    hideHelp();
  }

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

  if (key === ".") {
    waitTurn(state);
    onUpdate(state);
    return;
  }

  // trap-pressure handoff — NetHack-style search reveals hidden traps
  if (key === "s") {
    trySearch(state);
    onUpdate(state);
    return;
  }

  // TICKET-DP-01 — shrine sacrifice / throne sit
  if (key === "a" || key === "A") {
    trySpecialInteract(state);
    onUpdate(state);
    return;
  }

  if (key === ">" || key === "G" || key === "g") {
    tryDescend(state);
    onUpdate(state);
    return;
  }

  if (key === "Q") {
    if (confirm("Really quit? Your progress will be lost.")) {
      state.phase = "dead";
      state.player.alive = false;
      if (!state.player.deathCause) state.player.deathCause = "Quit";
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
    // ? help (Shift+/ on most layouts)
    if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      e.preventDefault();
      handleKeydown(getState(), "?", onUpdate);
      return;
    }

    const keys = [
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "h", "j", "k", "l", "y", "u", "b", "n",
      "i", ".", "s", "a", "A", ">", "G", "g", "Q", "Escape",
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    handleKeydown(getState(), e.key, onUpdate);
  });
}
