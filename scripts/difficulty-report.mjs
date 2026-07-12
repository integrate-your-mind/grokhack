#!/usr/bin/env node
/**
 * AGI Difficulty Director — measure bot vs human depth.
 * Reads data/fleet/bot-runs.jsonl + data/scores.json.
 * Writes data/fleet/difficulty-report.json and prints a summary table.
 *
 * Usage: node scripts/difficulty-report.mjs
 *        npm run difficulty:report
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FLEET = join(ROOT, "data", "fleet");
const BOT_RUNS = join(FLEET, "bot-runs.jsonl");
const SCORES = join(ROOT, "data", "scores.json");
const OUT = join(FLEET, "difficulty-report.json");

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadScores(path) {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function stats(depths) {
  if (!depths.length) {
    return { n: 0, max: 0, min: 0, mean: 0, p50: 0, p95: 0 };
  }
  const s = [...depths].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const pct = (p) => s[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    n,
    max: s[n - 1],
    min: s[0],
    mean: Math.round(mean * 100) / 100,
    p50: pct(50),
    p95: pct(95),
  };
}

function hist(depths) {
  const h = {};
  for (const d of depths) {
    const k = String(d);
    h[k] = (h[k] || 0) + 1;
  }
  return h;
}

function topCauses(runs, limit = 8) {
  const c = {};
  for (const r of runs) {
    const key = String(r.cause || (r.messages && r.messages[r.messages.length - 1]) || "unknown").slice(
      0,
      72
    );
    c[key] = (c[key] || 0) + 1;
  }
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cause, count]) => ({ cause, count }));
}

const botRuns = loadJsonl(BOT_RUNS);
const scores = loadScores(SCORES);

const botDepths = botRuns.map((r) => Number(r.depth) || 0);
const humanScores = scores.filter((s) => s.kind === "human");
const agentScores = scores.filter((s) => s.kind === "agent");
const humanDepths = humanScores.map((s) => Number(s.depth) || 0);
const agentScoreDepths = agentScores.map((s) => Number(s.depth) || 0);

const report = {
  at: new Date().toISOString(),
  northStar: "Harder than classic NetHack for humans AND AI agents",
  liveBots: {
    ...stats(botDepths),
    depthHist: hist(botDepths),
    outcomes: botRuns.reduce((acc, r) => {
      const o = r.outcome || "unknown";
      acc[o] = (acc[o] || 0) + 1;
      return acc;
    }, {}),
    styles: botRuns.reduce((acc, r) => {
      const o = r.style || "unset";
      acc[o] = (acc[o] || 0) + 1;
      return acc;
    }, {}),
    topCauses: topCauses(botRuns),
  },
  leaderboard: {
    humans: {
      ...stats(humanDepths),
      wins: humanScores.filter((s) => s.outcome === "won").length,
    },
    agents: {
      ...stats(agentScoreDepths),
      wins: agentScores.filter((s) => s.outcome === "won").length,
    },
  },
  gap: {
    // Positive => humans deeper than live bots (agents lagging)
    humanMaxMinusLiveBotMax:
      (stats(humanDepths).max || 0) - (stats(botDepths).max || 0),
    agentLbMaxMinusHumanMax:
      (stats(agentScoreDepths).max || 0) - (stats(humanDepths).max || 0),
    note:
      "Live bots measure real skill ceiling of current agent-bot.mjs; leaderboard may include synthetic/test wins.",
  },
  targets: {
    liveBotP50: 3,
    liveBotP95: 6,
    dragonKillRateHint: "<5% of runs that reach depth 10",
    parity: "agent win rate ≈ human win rate under shared ruleset",
  },
};

mkdirSync(FLEET, { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

function row(label, s) {
  if (!s.n) return `${label.padEnd(14)} n=0`;
  return `${label.padEnd(14)} n=${String(s.n).padStart(3)}  max=${s.max}  p50=${s.p50}  p95=${s.p95}  mean=${s.mean}`;
}

console.log("=== GrokHack difficulty report ===");
console.log(row("live bots", report.liveBots));
console.log(row("LB humans", report.leaderboard.humans));
console.log(row("LB agents", report.leaderboard.agents));
console.log(
  `gap humanMax-botMax=${report.gap.humanMaxMinusLiveBotMax}  agentLbMax-humanMax=${report.gap.agentLbMaxMinusHumanMax}`
);
if (report.liveBots.topCauses?.length) {
  console.log("top bot death causes:");
  for (const { cause, count } of report.liveBots.topCauses) {
    console.log(`  ${count}x  ${cause}`);
  }
}
console.log(`wrote ${OUT}`);
