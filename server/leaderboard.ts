import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dataPath } from "./data-paths.js";

const DATA_DIR = dataPath();
const SCORES_FILE = dataPath("scores.json");

export type PlayerKind = "human" | "agent";
export type RunOutcome = "won" | "died";

export interface ScoreEntry {
  id: string;
  name: string;
  kind: PlayerKind;
  outcome: RunOutcome;
  depth: number;
  level: number;
  gold: number;
  turns: number;
  score: number;
  at: string;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadScores(): ScoreEntry[] {
  ensureDataDir();
  if (!fs.existsSync(SCORES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")) as ScoreEntry[];
  } catch {
    return [];
  }
}

function saveScores(scores: ScoreEntry[]): void {
  ensureDataDir();
  const trimmed = scores.slice(-5000);
  fs.writeFileSync(SCORES_FILE, JSON.stringify(trimmed, null, 2));
}

export function computeScore(
  outcome: RunOutcome,
  depth: number,
  level: number,
  gold: number,
  turns: number
): number {
  const base = depth * 1000 + level * 100 + gold * 10;
  const winBonus = outcome === "won" ? 10000 : 0;
  const efficiency = Math.max(0, 500 - Math.floor(turns / 10));
  return base + winBonus + efficiency;
}

export function recordRun(
  name: string,
  kind: PlayerKind,
  outcome: RunOutcome,
  depth: number,
  level: number,
  gold: number,
  turns: number
): ScoreEntry {
  const entry: ScoreEntry = {
    id: randomUUID(),
    name,
    kind,
    outcome,
    depth,
    level,
    gold,
    turns,
    score: computeScore(outcome, depth, level, gold, turns),
    at: new Date().toISOString(),
  };
  const scores = loadScores();
  scores.push(entry);
  saveScores(scores);
  return entry;
}

export function getLeaderboard(
  kind?: PlayerKind,
  limit = 50
): ScoreEntry[] {
  let scores = loadScores();
  if (kind) scores = scores.filter((s) => s.kind === kind);
  return [...scores]
    .sort((a, b) => b.score - a.score || b.depth - a.depth)
    .slice(0, limit);
}

export function getRecentRuns(limit = 20): ScoreEntry[] {
  const scores = loadScores();
  return [...scores].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
