import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import { computeScore, recordRun, getLeaderboard } from "./leaderboard.js";
import { dataPath } from "./data-paths.js";

const SCORES = dataPath("scores.json");

beforeEach(() => {
  if (fs.existsSync(SCORES)) fs.unlinkSync(SCORES);
});

describe("leaderboard", () => {
  it("computes higher score for wins", () => {
    const win = computeScore("won", 10, 8, 50, 500);
    const loss = computeScore("died", 10, 8, 50, 500);
    expect(win).toBeGreaterThan(loss);
  });

  it("records and ranks runs", () => {
    recordRun("Alice", "human", "died", 5, 3, 10, 100);
    recordRun("Bot", "agent", "won", 10, 10, 100, 800);
    const top = getLeaderboard();
    expect(top[0].name).toBe("Bot");
    expect(getLeaderboard("human")[0].name).toBe("Alice");
  });
});
