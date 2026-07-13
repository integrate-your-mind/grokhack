import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShadowJournalEntry } from "../src/shadow-journal.js";
import type { GameplayState } from "../src/gameplay-reducer.js";
import type { MovementState } from "../src/movement-reducer.js";
import { movementJournalRunId, movementJournalStreamId, OriginGameplayJournal } from "./origin-journal.js";

const directories: string[] = [];
const initial = (overrides: Partial<GameplayState> = {}): GameplayState => ({
  turns: 0, depth: 1, hunger: 800, maxHunger: 1000,
  hungerState: "normal", hp: 20, alive: true, ...overrides,
});
const movementAuthority = {
  realmId: "legacy-1",
  floorInstanceId: "legacy-seed-1234",
  depth: 1,
  floorEpoch: 1,
  rulesetVersion: 1,
} as const;
const movementRunId = movementJournalRunId("a".repeat(64));

function journal(): { directory: string; value: OriginGameplayJournal } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-"));
  directories.push(directory);
  return { directory, value: new OriginGameplayJournal(directory) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("OriginGameplayJournal", () => {
  it("creates a bounded floor-fenced movement stream identity", () => {
    const stream = movementJournalStreamId("player-1", movementRunId, movementAuthority);
    expect(stream).toMatch(/^movement_[0-9a-f]{48}$/u);
    expect(movementJournalStreamId("player-1", movementJournalRunId("b".repeat(64)), movementAuthority)).not.toBe(stream);
    expect(movementJournalStreamId("player-1", movementRunId, { ...movementAuthority, floorInstanceId: "legacy-seed-5678" })).not.toBe(stream);
    expect(movementJournalStreamId("player-1", movementRunId, { ...movementAuthority, depth: 2 })).not.toBe(stream);
    expect(movementJournalStreamId("player-1", movementRunId, { ...movementAuthority, floorEpoch: 2 })).not.toBe(stream);
    expect(movementJournalStreamId("player-1", movementRunId, { ...movementAuthority, rulesetVersion: 1 })).toBe(stream);
    expect(movementJournalRunId("A".repeat(64))).toBe(movementRunId);
    expect(() => movementJournalRunId("short")).toThrow("invalid_movement_run");
    expect(() => movementJournalStreamId("../escape", movementRunId, movementAuthority)).toThrow("invalid_movement_stream");
    expect(movementJournalStreamId("p".repeat(96), movementRunId, movementAuthority)).toHaveLength(57);
    expect(() => movementJournalStreamId("p".repeat(97), movementRunId, movementAuthority)).toThrow("invalid_movement_stream");
    expect(() => movementJournalStreamId("player-1", "0".repeat(23), movementAuthority)).toThrow("invalid_movement_stream");
    expect(() => movementJournalStreamId("player-1", movementRunId, { ...movementAuthority, floorEpoch: 0 })).toThrow("invalid_movement_stream");
    expect(() => movementJournalStreamId("player-1", movementRunId, { ...movementAuthority, rulesetVersion: 2 })).toThrow("invalid_movement_stream");
  });

  it("persists floor authority across benign restart and rotates only for regeneration", () => {
    const { directory, value } = journal();
    const first = value.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "boot-a-d1",
    });
    const registry = path.join(directory, "_movement-authority-v1.json");
    expect(fs.statSync(registry).mode & 0o777).toBe(0o600);
    const firstStream = movementJournalStreamId("player-1", movementRunId, first);
    const firstDecision = {
      streamId: firstStream,
      command: { type: "move", dx: 1, dy: 0 } as const,
      beforeState: {
        authority: first,
        x: 8,
        y: 4,
        phase: "playing" as const,
        alive: true,
        immobilizedTurns: 0,
        destination: { tile: "#" as const, occupant: "none" as const, trap: false, stairsDown: false },
      },
    };
    expect(value.appendTransition(firstDecision).status).toBe("appended");
    const restarted = new OriginGameplayJournal(directory);
    const reused = restarted.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "boot-b-d1",
    });
    expect(reused).toEqual(first);
    expect(restarted.appendTransition(firstDecision).status).toBe("duplicate");

    const regenerated = restarted.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: true,
      rotationId: "boot-b-d1",
    });
    expect(regenerated.floorEpoch).toBe(first.floorEpoch + 1);
    expect(regenerated.floorInstanceId).not.toBe(first.floorInstanceId);
    expect(movementJournalStreamId("player-1", movementRunId, regenerated)).not.toBe(firstStream);
    expect(restarted.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: true,
      rotationId: "boot-b-d1",
    })).toEqual(regenerated);
    expect(() => restarted.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 9999,
      rotate: true,
      rotationId: "boot-b-d1",
    })).toThrow("movement_authority_operation_reused");
    expect(() => restarted.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "boot-b-d1",
    })).toThrow("movement_authority_operation_reused");
    const regeneratedAgain = restarted.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: true,
      rotationId: "boot-c-d1",
    });
    expect(regeneratedAgain.floorEpoch).toBe(regenerated.floorEpoch + 1);
    expect(regeneratedAgain.floorInstanceId).not.toBe(regenerated.floorInstanceId);
  });

  it("reconciles a committed authority rotation after directory-fsync response loss", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-authority-fsync-"));
    directories.push(directory);
    let fsyncCalls = 0;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        if (fsyncCalls === 2) throw new Error("injected authority directory fsync failure");
        fs.fsyncSync(descriptor);
      },
    });
    const input = {
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: true,
      rotationId: "authority-retry-d1",
    } as const;
    expect(() => value.movementAuthorityForFloor(input)).toThrow("injected authority directory fsync failure");
    const recovered = value.movementAuthorityForFloor(input);
    expect(recovered).toMatchObject({ depth: 1, floorEpoch: 1, rulesetVersion: 1 });
    expect(fsyncCalls).toBe(3);
    expect(new OriginGameplayJournal(directory).movementAuthorityForFloor({
      ...input,
      rotate: false,
      rotationId: "benign-restart-d1",
    })).toEqual(recovered);
  });

  it("fails closed on a corrupt movement-authority registry", () => {
    const { directory, value } = journal();
    value.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "corrupt-proof-d1",
    });
    fs.writeFileSync(path.join(directory, "_movement-authority-v1.json"), "not-json\n", { mode: 0o600 });
    expect(() => new OriginGameplayJournal(directory).movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "restart-d1",
    })).toThrow("movement_authority_registry_corrupt");
  });

  it("bounds and validates every authority-registry record", () => {
    const { directory, value } = journal();
    value.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "schema-proof-d1",
    });
    const file = path.join(directory, "_movement-authority-v1.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf8")) as { floors: unknown[] };
    registry.floors.push(registry.floors[0]);
    fs.writeFileSync(file, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
    expect(() => new OriginGameplayJournal(directory).validateMovementAuthorityRegistry())
      .toThrow("movement_authority_registry_corrupt");

    fs.writeFileSync(file, "x".repeat(256 * 1024 + 1), { mode: 0o600 });
    expect(() => new OriginGameplayJournal(directory).validateMovementAuthorityRegistry())
      .toThrow("movement_authority_registry_too_large");
  });

  it("fails closed when the authority registry is group/world readable", () => {
    if (process.platform === "win32") return;
    const { directory, value } = journal();
    value.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "permission-proof-d1",
    });
    const file = path.join(directory, "_movement-authority-v1.json");
    fs.chmodSync(file, 0o644);
    expect(() => new OriginGameplayJournal(directory).validateMovementAuthorityRegistry())
      .toThrow("movement_authority_registry_insecure_permissions");
  });

  it("fails closed instead of wrapping an exhausted floor epoch", () => {
    const { directory, value } = journal();
    value.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "epoch-proof-d1",
    });
    const file = path.join(directory, "_movement-authority-v1.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf8")) as {
      floors: Array<{ floorEpoch: number }>;
    };
    registry.floors[0]!.floorEpoch = Number.MAX_SAFE_INTEGER;
    fs.writeFileSync(file, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
    expect(() => new OriginGameplayJournal(directory).movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: true,
      rotationId: "epoch-proof-rotate-d1",
    })).toThrow("movement_authority_epoch_exhausted");
  });

  it("fails closed when the bounded authority registry has no new-floor capacity", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-authority-capacity-"));
    directories.push(directory);
    const floors = Array.from({ length: 256 }, (_value, index) => ({
      realmId: `realm-${Math.floor(index / 64)}`,
      floorInstanceId: `floor-${index}`,
      depth: index % 64 + 1,
      floorEpoch: 1,
      rulesetVersion: 1,
      floorSeed: index + 1,
      rotationId: `rotation-${index}`,
      rotationMode: "reuse",
    }));
    fs.writeFileSync(
      path.join(directory, "_movement-authority-v1.json"),
      `${JSON.stringify({ v: 1, floors })}\n`,
      { mode: 0o600 },
    );
    const value = new OriginGameplayJournal(directory);
    expect(() => value.validateMovementAuthorityRegistry()).not.toThrow();
    expect(() => value.movementAuthorityForFloor({
      realmId: "overflow",
      depth: 1,
      floorSeed: 999,
      rotate: false,
      rotationId: "overflow-d1",
    })).toThrow("movement_authority_capacity");
  });

  it("appends immutable ordered entries and resumes its cursor after restart", () => {
    const { directory, value } = journal();
    const one = value.appendTransition({ streamId: "player_1", command: { type: "advance_turn", action: "wait" }, beforeState: initial() });
    expect(one.status).toBe("appended");
    expect(one.entry.cursor).toBe(1);

    const restarted = new OriginGameplayJournal(directory);
    const two = restarted.appendTransition({ streamId: "player_1", command: { type: "advance_turn", action: "other" }, beforeState: initial({ turns: 1, hunger: 798 }) });
    expect(two.entry.cursor).toBe(2);
    expect(restarted.readAfter("player_1", 0, 1)).toEqual([one.entry]);
    expect(restarted.readAfter("player_1", 1, 64)).toEqual([two.entry]);
    expect(fs.statSync(path.join(directory, "player_1.00000000.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("makes exact retry idempotent and rejects conflict, gap, traversal, and corrupt restart", () => {
    const { directory, value } = journal();
    const entry = createShadowJournalEntry({ streamId: "safe", cursor: 1, command: { type: "advance_turn", action: "wait" }, beforeState: initial() });
    expect(value.append(entry).status).toBe("appended");
    expect(value.append(entry).status).toBe("duplicate");
    const conflict = { ...entry, entryHash: "0000000000000000" };
    expect(() => value.append(conflict)).toThrow(/entry_hash_mismatch/);
    const gap = createShadowJournalEntry({ streamId: "safe", cursor: 3, previousEntryHash: entry.entryHash, command: { type: "advance_turn", action: "wait" }, beforeState: initial() });
    expect(() => value.append(gap)).toThrow("journal_cursor_gap");
    expect(() => value.readAfter("../escape", 0, 1)).toThrow("invalid_stream_id");
    fs.appendFileSync(path.join(directory, "safe.00000000.jsonl"), "not-json\n");
    expect(() => new OriginGameplayJournal(directory).readAfter("safe", 0, 64)).toThrow();
  });

  it("keeps an existing canonical segment unchanged when the next file fsync fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-fsync-"));
    directories.push(directory);
    const initialJournal = new OriginGameplayJournal(directory);
    initialJournal.appendTransition({
      streamId: "fsync-before-rename",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const canonical = path.join(directory, "fsync-before-rename.00000000.jsonl");
    const beforeFailure = fs.readFileSync(canonical);
    let fsyncCalls = 0;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        if (fsyncCalls === 1) throw new Error("injected file fsync failure");
        fs.fsyncSync(descriptor);
      },
    });
    const input = {
      streamId: "fsync-before-rename",
      command: { type: "advance_turn", action: "other" } as const,
      beforeState: initial({ turns: 1, hunger: 798 }),
    };
    expect(() => value.appendTransition(input)).toThrow("injected file fsync failure");
    expect(fs.readFileSync(canonical)).toEqual(beforeFailure);
    expect(value.readAfter(input.streamId, 0, 64)).toHaveLength(1);
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(value.appendTransition(input).status).toBe("appended");
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(2);
  });

  it("fsyncs a newly created journal directory into its existing parent before acknowledging", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-parent-"));
    directories.push(parent);
    const directory = path.join(parent, "journal");
    let fsyncCalls = 0;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        if (fsyncCalls === 1) throw new Error("injected parent fsync failure");
        fs.fsyncSync(descriptor);
      },
    });
    const input = {
      streamId: "first-use",
      command: { type: "advance_turn", action: "wait" } as const,
      beforeState: initial(),
    };
    expect(() => value.appendTransition(input)).toThrow("injected parent fsync failure");
    expect(fs.existsSync(path.join(directory, "first-use.00000000.jsonl"))).toBe(false);
    expect(value.appendTransition(input).status).toBe("appended");
    expect(fsyncCalls).toBeGreaterThanOrEqual(4);
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(1);
  });

  it("reconciles a committed rename when directory fsync acknowledgement is lost", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-dir-fsync-"));
    directories.push(directory);
    let fsyncCalls = 0;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        if (fsyncCalls === 2) throw new Error("injected directory fsync failure");
        fs.fsyncSync(descriptor);
      },
    });
    const input = {
      streamId: "fsync-after-rename",
      command: { type: "advance_turn", action: "wait" } as const,
      beforeState: initial(),
    };
    expect(() => value.appendTransition(input)).toThrow("injected directory fsync failure");
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(1);
    expect(value.appendTransition(input).status).toBe("duplicate");
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(1);
  });

  it("writes the complete segment across a permitted short write", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-short-write-"));
    directories.push(directory);
    let calls = 0;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        calls++;
        const amount = calls === 1 ? Math.max(1, Math.floor(length / 3)) : length;
        return fs.writeSync(descriptor, buffer, offset, amount);
      },
    });
    const result = value.appendTransition({
      streamId: "short-write",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    expect(calls).toBeGreaterThan(1);
    expect(new OriginGameplayJournal(directory).readAfter("short-write", 0, 64)).toEqual([result.entry]);
  });

  it("rejects a zero-byte write without replacing the canonical segment", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-zero-write-"));
    directories.push(directory);
    const value = new OriginGameplayJournal(directory, {
      writeSync: () => 0,
    });
    expect(() => value.appendTransition({
      streamId: "zero-write",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    })).toThrow("journal_short_write");
    expect(value.readAfter("zero-write", 0, 64)).toEqual([]);
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("enforces bounded reads and records terminal transitions", () => {
    const { directory, value } = journal();
    const result = value.appendTransition({
      streamId: "terminal",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial({ hunger: 1, hungerState: "starving", hp: 3 }),
    });
    expect(result.entry.terminal).toBe(true);
    expect(() => new OriginGameplayJournal(directory).appendTransition({ streamId: "terminal", command: { type: "advance_turn", action: "wait" }, beforeState: initial({ turns: 1, alive: false }) })).toThrow("journal_terminal_stream");
    expect(() => value.readAfter("terminal", 0, 65)).toThrow("invalid limit");
    expect(() => value.readAfter("terminal", -1, 1)).toThrow("invalid cursor");
  });

  it("deduplicates a logical retry without allocating another cursor", () => {
    const { value } = journal();
    const secondTurn = () => value.appendTransition({
      streamId: "gap-proof", command: { type: "advance_turn", action: "wait" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    });
    expect(() => secondTurn()).not.toThrow();
    expect(secondTurn().status).toBe("duplicate");
    expect(value.readAfter("gap-proof", 0, 64)[0]?.cursor).toBe(1);
  });

  it("segments long streams so bounded catch-up reads only small adjacent files", () => {
    const { directory, value } = journal();
    let state = initial();
    for (let index = 0; index < 66; index++) {
      value.appendTransition({ streamId: "segmented", command: { type: "advance_turn", action: "other" }, beforeState: state });
      state = { ...state, turns: state.turns + 1, hunger: Math.max(0, state.hunger - 2) };
    }
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("segmented."))).toHaveLength(2);
    expect(value.readAfter("segmented", 60, 64).map((entry) => entry.cursor)).toEqual([61, 62, 63, 64, 65, 66]);
    expect(value.readAfter("segmented", 64, 64).map((entry) => entry.cursor)).toEqual([65, 66]);
    fs.rmSync(path.join(directory, "segmented.00000001.jsonl"));
    expect(() => value.readAfter("segmented", 64, 64)).toThrow("journal_missing_segment");
  }, 15_000);

  it("chains mixed V1 vitals and V2 movement entries across restart", () => {
    const { directory, value } = journal();
    const vitals = value.appendTransition({
      streamId: "mixed",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).entry;
    const beforeState: MovementState = {
      authority: movementAuthority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    };
    const movement = value.appendTransition({
      streamId: "mixed",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState,
    }).entry;
    expect([vitals.v, movement.v]).toEqual([1, 2]);
    expect(movement.previousEntryHash).toBe(vitals.entryHash);
    expect(new OriginGameplayJournal(directory).readAfter("mixed", 0, 64)).toEqual([vitals, movement]);
    expect(() => value.appendTransition({
      streamId: "mixed",
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    })).toThrow("journal_state_domain_regression");
    expect(new OriginGameplayJournal(directory).readAfter("mixed", 0, 64)).toEqual([vitals, movement]);
  });

  it("rejects a carried-state jump after a no-turn decision but permits an origin-effect boundary", () => {
    const { value } = journal();
    const blockedState: MovementState = {
      authority: movementAuthority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: "#", occupant: "none", trap: false, stairsDown: false },
    };
    value.appendTransition({
      streamId: "continuity",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: blockedState,
    });
    expect(() => value.appendTransition({
      streamId: "continuity",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: {
        ...blockedState,
        x: 40,
        destination: { tile: ".", occupant: "player", trap: false, stairsDown: false },
      },
    })).toThrow("journal_state_continuity_mismatch");
    expect(value.readAfter("continuity", 0, 64)).toHaveLength(1);

    const effectfulState: MovementState = {
      ...blockedState,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    };
    const first = value.appendTransition({
      streamId: "effect-boundary",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: effectfulState,
    });
    const second = value.appendTransition({
      streamId: "effect-boundary",
      command: { type: "move", dx: 0, dy: 1 },
      beforeState: { ...effectfulState, x: 40, y: 20 },
    });
    expect([first.entry.cursor, second.entry.cursor]).toEqual([1, 2]);
  });
});
