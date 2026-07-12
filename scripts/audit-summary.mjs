#!/usr/bin/env node
/**
 * Summarize play telemetry from data/audit/*.jsonl
 * Usage: npm run audit:summary [-- --days=7]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = path.join(__dirname, "..", "data", "audit");

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 7;

function listFiles() {
  if (!fs.existsSync(AUDIT_DIR)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days + 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return fs.readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl") && f.slice(0, 10) >= cutoffStr);
}

const stats = {
  events: 0,
  sessions: new Set(),
  joins: 0,
  joinFailed: 0,
  deaths: 0,
  victories: 0,
  chats: 0,
  social: 0,
  combats: 0,
  clientErrors: 0,
  clientTelemetry: 0,
  sessionSummaries: 0,
  durations: [],
  errors: new Map(),
  deathsByDepth: new Map(),
  topInputs: new Map(),
};

for (const file of listFiles()) {
  const lines = fs.readFileSync(path.join(AUDIT_DIR, file), "utf8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    stats.events++;
    stats.sessions.add(e.sessionId);
    switch (e.type) {
      case "player_join":
        stats.joins++;
        break;
      case "player_join_failed":
        stats.joinFailed++;
        break;
      case "player_death":
        stats.deaths++;
        if (e.detail?.depth != null) {
          const d = String(e.detail.depth);
          stats.deathsByDepth.set(d, (stats.deathsByDepth.get(d) || 0) + 1);
        }
        break;
      case "player_victory":
        stats.victories++;
        break;
      case "player_chat":
        stats.chats++;
        break;
      case "player_social":
        stats.social++;
        break;
      case "combat":
        stats.combats++;
        break;
      case "client_error": {
        stats.clientErrors++;
        const msg = String(e.detail?.message || "unknown").slice(0, 100);
        stats.errors.set(msg, (stats.errors.get(msg) || 0) + 1);
        break;
      }
      case "client_telemetry":
        stats.clientTelemetry++;
        break;
      case "session_summary":
        stats.sessionSummaries++;
        if (typeof e.detail?.durationSec === "number") stats.durations.push(e.detail.durationSec);
        break;
      case "player_input": {
        const k = String(e.detail?.key || e.detail?.cmd || "?");
        stats.topInputs.set(k, (stats.topInputs.get(k) || 0) + 1);
        break;
      }
      default:
        break;
    }
  }
}

const avgSec = stats.durations.length
  ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length)
  : 0;

console.log(`\nGrokHack play telemetry — last ${days} day(s)\n`);
console.log(`Events:        ${stats.events}`);
console.log(`Sessions:      ${stats.sessions.size}`);
console.log(`Joins:         ${stats.joins} (${stats.joinFailed} failed)`);
console.log(`Deaths/Wins:   ${stats.deaths} / ${stats.victories}`);
console.log(`Chat/Social:   ${stats.chats} / ${stats.social}`);
console.log(`Combat hits:   ${stats.combats}`);
console.log(`Client events: ${stats.clientTelemetry}`);
console.log(`Errors:        ${stats.clientErrors}`);
console.log(`Avg session:   ${avgSec}s (${stats.sessionSummaries} summaries)`);

if (stats.deathsByDepth.size) {
  console.log("\nDeaths by depth:");
  for (const [d, n] of [...stats.deathsByDepth.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  d${d}: ${n}`);
  }
}

if (stats.errors.size) {
  console.log("\nTop client errors:");
  for (const [msg, n] of [...stats.errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${n}× ${msg}`);
  }
}

const topKeys = [...stats.topInputs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (topKeys.length) {
  console.log("\nTop inputs:");
  for (const [k, n] of topKeys) console.log(`  ${n}× ${k}`);
}

console.log("");