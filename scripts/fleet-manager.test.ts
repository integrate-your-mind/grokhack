import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const manager = join(root, "scripts/fleet-manager.sh");
const loop = join(root, "scripts/fleet-run-loop.sh");
const tmuxTmp = join("/tmp", `grokhack-tmux-test-${process.pid}`);
const fleetDir = join(root, "data", "fleet", `state-test-${process.pid}`);

function isolatedEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TMUX: "",
    TMUX_TMPDIR: tmuxTmp,
    FLEET_DRY_RUN: "1",
    FLEET_DIR: fleetDir,
    FLEET_SKIP_GAME_STATUS: "1",
  };
}

beforeAll(() => {
  mkdirSync(tmuxTmp, { recursive: true });
  mkdirSync(fleetDir, { recursive: true });
});
afterAll(() => {
  rmSync(tmuxTmp, { recursive: true, force: true });
  rmSync(fleetDir, { recursive: true, force: true });
});

describe("fleet-manager (shipped entry path)", () => {
  it("selftest: idle/busy detection, no false idle on queued interjections, retask path, 5m interval", () => {
    const out = execFileSync("bash", [manager, "selftest"], {
      encoding: "utf8",
      cwd: root,
      env: isolatedEnv(),
      timeout: 15_000,
    });
    expect(out).toContain("PASS idle fixture → idle");
    expect(out).toContain("PASS busy fixture → busy");
    expect(out).toContain("PASS queued-interjection fixture → busy (no false idle)");
    expect(out).toContain("PASS idle→retask dry-run logged action=retasked");
    expect(out).toContain("PASS live send_goal");
    expect(out).toContain("PASS default interval is 300 (5 minutes)");
    expect(out).toMatch(/PASS worker roster size=\d+ \(>=8 CEO org/);
    expect(out).toContain("PASS freeform hire roles accepted (non-manager only)");
    expect(out).toContain("PASS CEO teams present: algorithms + database + depth");
    expect(out).toContain("SELFTEST OK");
  });

  it("run-loop sleeps 300 seconds (5-minute cadence)", () => {
    const src = readFileSync(loop, "utf8");
    expect(src).toMatch(/BASH_SOURCE\[0\]/);
    expect(src).not.toContain("/Users/");
    expect(src).toMatch(/INTERVAL_SECONDS="\$\{FLEET_INTERVAL_SECONDS:-300\}"/);
    expect(src).toMatch(/sleep "\$INTERVAL_SECONDS"/);
    expect(src).not.toMatch(/sleep 120\b/);
  });

  it("status mode reports each worker role", () => {
    const out = execFileSync("bash", [manager, "status"], {
      encoding: "utf8",
      cwd: root,
      env: isolatedEnv(),
      timeout: 30_000,
    });
    expect(out).toMatch(/fleet-manager mode=status/);
    expect(out).toMatch(/interval=300s/);
    for (const role of [
      "persistence",
      "gameplay",
      "growth",
      "qa-bots",
      "algorithms",
      "depth",
      "viral-ops",
      "database",
    ]) {
      expect(out).toMatch(new RegExp(`(BUSY|IDLE|MISS)\\s+${role}\\b`));
    }
    expect(out).toMatch(/GAME\s+/);
    // Manager must not appear as a re-tasked worker line
    expect(out).not.toMatch(/\bmanager\b.*re-task/);
  }, 35_000);

  it("once mode appends machine-readable status.jsonl rows", () => {
    const statusPath = join(fleetDir, "status.jsonl");
    const before = existsSync(statusPath) ? readFileSync(statusPath, "utf8").trimEnd() : "";
    execFileSync("bash", [manager, "once"], {
      encoding: "utf8",
      cwd: root,
      env: isolatedEnv(),
      timeout: 30_000,
    });
    const after = readFileSync(statusPath, "utf8");
    expect(after.length).toBeGreaterThan(before.length);
    const lines = after.trim().split("\n").slice(-4);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      const row = JSON.parse(line) as {
        at: string;
        socket: string;
        role: string;
        state: string;
        action: string;
      };
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(["idle", "busy", "missing"]).toContain(row.state);
      expect(typeof row.action).toBe("string");
      expect(row.socket).toMatch(/^shellbook-grok-|fleet-idle-proof-/);
    }
  });
});
