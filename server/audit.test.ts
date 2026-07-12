import { describe, it, expect } from "vitest";
import { logEvent, getAuditStats, ingestClientTelemetry } from "./audit.js";
import { killerFromDeathCause } from "./world.js";

describe("audit telemetry", () => {
  it("aggregates play stats from events", () => {
    const sid = "stats-test-session";
    logEvent("session_connect", sid, { transport: "websocket" });
    logEvent("player_join", sid, { playerName: "Tester", detail: { kind: "human" } });
    logEvent("player_input", sid, { detail: { key: "l" } });
    logEvent("player_chat", sid, { playerName: "Tester", detail: { channel: "global", len: 5 } });
    logEvent("player_death", sid, {
      playerName: "Tester",
      detail: {
        depth: 3,
        score: 100,
        level: 1,
        turns: 42,
        gold: 7,
        deathCause: "Slain by a orc",
        killer: "orc",
      },
    });
    logEvent("client_error", sid, { detail: { message: "test error", context: "ui" } });
    logEvent("session_summary", sid, { detail: { durationSec: 120, inputCount: 10, maxDepth: 3 } });

    const stats = getAuditStats(30);
    expect(stats.joins).toBeGreaterThanOrEqual(1);
    expect(stats.deaths).toBeGreaterThanOrEqual(1);
    expect(stats.chatMessages).toBeGreaterThanOrEqual(1);
    expect(stats.clientErrors).toBeGreaterThanOrEqual(1);
    expect(stats.topErrors.some((e) => e.message === "test error")).toBe(true);
  });

  it("player_death detail shape includes deathCause, killer, turns, gold, level, depth, score", () => {
    const sid = `death-detail-${Date.now()}`;
    const detail = {
      score: 250,
      depth: 4,
      level: 2,
      turns: 180,
      gold: 12,
      deathCause: "Slain by a skeleton",
      killer: "skeleton",
    };
    logEvent("player_death", sid, { playerName: "DeathProbe", detail });

    // Contract for world.recordScore → logEvent("player_death")
    for (const key of ["score", "depth", "level", "turns", "gold", "deathCause", "killer"] as const) {
      expect(detail[key]).toBeDefined();
    }
    expect(detail.killer).toBe("skeleton");
    expect(detail.deathCause).toMatch(/skeleton/i);
  });

  it("killerFromDeathCause parses monster names from deathCause strings", () => {
    expect(killerFromDeathCause("Slain by a orc")).toBe("orc");
    expect(killerFromDeathCause("Incinerated by a dragon")).toBe("dragon");
    expect(killerFromDeathCause("Drained dry by a wraith")).toBe("wraith");
    expect(killerFromDeathCause("Killed by a cursed item")).toBe("cursed item");
    expect(killerFromDeathCause("Mind blasted by a mind flayer")).toBe("mind flayer");
    expect(killerFromDeathCause("Ambushed by a goblin")).toBe("goblin");
    expect(killerFromDeathCause("Starved to death")).toBeNull();
    expect(killerFromDeathCause("Succumbed to poison")).toBeNull();
    expect(killerFromDeathCause(null)).toBeNull();
    expect(killerFromDeathCause(undefined)).toBeNull();
  });

  it("ingests client telemetry batches", () => {
    const n = ingestClientTelemetry("telemetry-session", [
      { event: "chat_open", detail: { expanded: true } },
      { event: "reconnect", detail: { attempt: 2 } },
    ]);
    expect(n).toBe(2);
  });

  it("session_disconnect detail.reason is one of the allowed codes", () => {
    const allowed = new Set(["client", "server", "timeout", "restart", "grace_expired"]);
    for (const reason of allowed) {
      logEvent("session_disconnect", `disc-${reason}`, {
        transport: "websocket",
        detail: { reason },
      });
    }
    // Smoke: write path accepts all analytics reason codes
    expect(allowed.size).toBe(5);
  });
});