/**
 * Run unit tests + batch simulations without vitest.
 * Usage: node scripts/test-and-simulate.mjs [simCount]
 */
import { runUnitTests, runBatchSimulation } from "../dist-test/test-harness.js";

const simCount = parseInt(process.argv[2] ?? "100", 10);

console.log("=== UNIT TESTS ===\n");
const tests = runUnitTests();
let passed = 0;
let failed = 0;
for (const t of tests) {
  if (t.pass) {
    passed++;
    console.log(`  ✓ ${t.name}`);
  } else {
    failed++;
    console.log(`  ✗ ${t.name}${t.detail ? ` — ${t.detail}` : ""}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed\n`);

console.log(`=== SIMULATION (${simCount} games, greedy bot) ===\n`);
const results = runBatchSimulation(simCount);

const won = results.filter((r) => r.outcome === "won");
const dead = results.filter((r) => r.outcome === "dead");
const timeout = results.filter((r) => r.outcome === "timeout");

const avgDepth = (arr) =>
  arr.length ? (arr.reduce((s, r) => s + r.depth, 0) / arr.length).toFixed(1) : "n/a";

const deathReasons = {};
for (const r of dead) {
  const key = r.reason.includes("starv") ? "starvation" :
    r.reason.includes("Game over") ? "combat" :
    r.reason.includes("Hunger") ? "hunger damage" : "other";
  deathReasons[key] = (deathReasons[key] ?? 0) + 1;
}

console.log(`  Won:     ${won.length} (${((won.length / simCount) * 100).toFixed(1)}%)`);
console.log(`  Died:    ${dead.length} (${((dead.length / simCount) * 100).toFixed(1)}%)`);
console.log(`  Timeout: ${timeout.length} (${((timeout.length / simCount) * 100).toFixed(1)}%)`);
console.log(`  Avg depth reached (all):   ${avgDepth(results)}`);
console.log(`  Avg depth reached (dead):  ${avgDepth(dead)}`);
console.log(`  Avg depth reached (won):   ${avgDepth(won)}`);
console.log(`  Death reasons:`, deathReasons);

if (won.length > 0) {
  const w = won[0];
  console.log(`\n  Sample win: seed=${w.seed} depth=${w.depth} level=${w.level} turns=${w.turns}`);
}
if (dead.length > 0) {
  const worst = [...dead].sort((a, b) => a.depth - b.depth)[0];
  const best = [...dead].sort((a, b) => b.depth - a.depth)[0];
  console.log(`  Deepest death: seed=${best.seed} depth=${best.depth} level=${best.level} — ${best.reason}`);
  console.log(`  Shallowest death: seed=${worst.seed} depth=${worst.depth} — ${worst.reason}`);
}

process.exit(failed > 0 ? 1 : 0);