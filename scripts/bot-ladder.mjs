#!/usr/bin/env node
/**
 * Careful-style bot depth ladder.
 * Spawns N careful agent bots (via agent-bot.mjs), collects finished runs into
 * data/fleet/bot-runs.jsonl, prints depth stats, then exits.
 *
 * Usage:
 *   node scripts/bot-ladder.mjs
 *   BOT_LADDER_RUNS=12 BOT_LADDER_BOTS=3 node scripts/bot-ladder.mjs
 *   npm run agent:ladder
 *
 * Env:
 *   BOT_LADDER_RUNS   — finished runs to collect (default 10)
 *   BOT_LADDER_BOTS   — concurrent careful bots (default 3)
 *   BOT_LADDER_SEC    — hard timeout seconds (default 180)
 *   BOT_COMPUTE       — default 0 (compute jobs starve play turns)
 *   BOT_URL / QA_URL  — optional WS override (else agent-bot local-prefer)
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RUN_LOG = join(ROOT, "data", "fleet", "bot-runs.jsonl");
const AGENT_BOT = join(__dirname, "agent-bot.mjs");

const TARGET_RUNS = Math.max(1, parseInt(process.env.BOT_LADDER_RUNS || "10", 10));
const BOTS = Math.max(1, Math.min(6, parseInt(process.env.BOT_LADDER_BOTS || "3", 10)));
const MAX_SEC = Math.max(30, parseInt(process.env.BOT_LADDER_SEC || "180", 10));
const TICK_MS = Math.max(120, parseInt(process.env.BOT_TICK_MS || "280", 10));

function countLines(path) {
  if (!existsSync(path)) return 0;
  const t = readFileSync(path, "utf8");
  return t.split("\n").filter((l) => l.trim()).length;
}

function loadRecentRuns(path, sinceCount) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  return lines.slice(sinceCount).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function stats(depths) {
  if (!depths.length) return { n: 0, max: 0, min: 0, mean: 0, p50: 0, p95: 0 };
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

function main() {
  const baseline = countLines(RUN_LOG);
  const name = `Care${Math.random().toString(36).slice(2, 5)}`;
  console.log(
    `[ladder] careful ladder runs=${TARGET_RUNS} bots=${BOTS} timeout=${MAX_SEC}s baseline_lines=${baseline}`
  );

  const env = {
    ...process.env,
    BOT_STYLE: "careful",
    BOT_COUNT: String(BOTS),
    BOT_NAME: name,
    BOT_MAX_RUNS: String(TARGET_RUNS),
    BOT_MAX_SECONDS: String(MAX_SEC),
    BOT_TICK_MS: String(TICK_MS),
    BOT_RESPAWN_MS: process.env.BOT_RESPAWN_MS || "800",
    // Compute jobs flood the WS and starve turns — ladder measures play skill only
    BOT_COMPUTE: process.env.BOT_COMPUTE || "0",
  };
  // Prefer local unless forced remote
  if (!env.BOT_URL && !env.BOT_FORCE_REMOTE) {
    // agent-bot will auto-detect local :8080
  }

  const child = spawn(process.execPath, [AGENT_BOT], {
    env,
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = (buf, tag) => {
    for (const line of buf.toString().split("\n")) {
      if (line.trim()) console.log(`[ladder:${tag}] ${line}`);
    }
  };
  child.stdout.on("data", (d) => prefix(d, "out"));
  child.stderr.on("data", (d) => prefix(d, "err"));

  const started = Date.now();
  const poll = setInterval(() => {
    const runs = loadRecentRuns(RUN_LOG, baseline).filter(
      (r) => r.style === "careful" && String(r.bot || "").startsWith(name)
    );
    const got = runs.length;
    if (got >= TARGET_RUNS) {
      console.log(`[ladder] collected ${got} careful runs — stopping`);
      clearInterval(poll);
      child.kill("SIGTERM");
    } else if ((Date.now() - started) / 1000 > MAX_SEC) {
      console.log(`[ladder] timeout with ${got}/${TARGET_RUNS} careful runs`);
      clearInterval(poll);
      child.kill("SIGTERM");
    }
  }, 1500);

  child.on("exit", (code) => {
    clearInterval(poll);
    const careful = loadRecentRuns(RUN_LOG, baseline).filter(
      (r) => r.style === "careful" && String(r.bot || "").startsWith(name)
    );
    const depths = careful.map((r) => Number(r.depth) || 0);
    const levels = careful.map((r) => Number(r.level) || 0);
    const s = stats(depths);
    const lvl = stats(levels);
    const causes = {};
    for (const r of careful) {
      const c = String(r.cause || "unknown").slice(0, 60);
      causes[c] = (causes[c] || 0) + 1;
    }
    const topCauses = Object.entries(causes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([cause, count]) => ({ cause, count }));

    console.log("=== careful ladder summary ===");
    console.log(
      `n=${s.n}  max=${s.max}  p50=${s.p50}  p95=${s.p95}  mean=${s.mean}  target_p50>=3 ${s.p50 >= 3 ? "PASS" : "FAIL"}`
    );
    console.log(`levels p50=${lvl.p50} max=${lvl.max} mean=${lvl.mean}`);
    console.log("depths:", depths.join(", ") || "(none)");
    console.log("top causes:", JSON.stringify(topCauses));
    console.log(`child exit=${code} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
    process.exit(s.n > 0 ? 0 : 1);
  });
}

main();
