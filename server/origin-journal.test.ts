import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createShadowJournalEntry } from "../src/shadow-journal.js";
import type { GameplayState } from "../src/gameplay-reducer.js";
import type { MovementState } from "../src/movement-reducer.js";
import {
  movementJournalRunId,
  movementJournalStreamId,
  OriginGameplayJournal,
  type JournalAppendResult,
} from "./origin-journal.js";

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

function entryOf(result: JournalAppendResult) {
  if (result.status === "dropped_capacity") throw new Error("expected retained journal entry");
  return result.entry;
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
    let failOnFsync = Number.POSITIVE_INFINITY;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        fs.fsyncSync(descriptor);
        if (fsyncCalls === failOnFsync) throw new Error("injected authority directory fsync failure");
      },
    });
    value.movementAuthorityForFloor({
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: false,
      rotationId: "authority-base-d1",
    });
    failOnFsync = fsyncCalls + 2;
    const input = {
      realmId: "legacy-1",
      depth: 1,
      floorSeed: 1234,
      rotate: true,
      rotationId: "authority-retry-d1",
    } as const;
    expect(() => value.movementAuthorityForFloor(input)).toThrow("injected authority directory fsync failure");
    const callsAfterLostAcknowledgement = fsyncCalls;
    const recovered = value.movementAuthorityForFloor(input);
    expect(recovered).toMatchObject({ depth: 1, floorEpoch: 2, rulesetVersion: 1 });
    expect(fsyncCalls).toBe(callsAfterLostAcknowledgement + 1);
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
    expect(entryOf(one).cursor).toBe(1);

    const restarted = new OriginGameplayJournal(directory);
    const two = restarted.appendTransition({ streamId: "player_1", command: { type: "advance_turn", action: "other" }, beforeState: initial({ turns: 1, hunger: 798 }) });
    expect(entryOf(two).cursor).toBe(2);
    expect(restarted.readAfter("player_1", 0, 1)).toEqual([entryOf(one)]);
    expect(restarted.readAfter("player_1", 1, 64)).toEqual([entryOf(two)]);
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

  it("rolls back a data record when its fsync acknowledgement is lost before commit", () => {
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
    let failOnFsync = Number.POSITIVE_INFINITY;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        fs.fsyncSync(descriptor);
        if (fsyncCalls === failOnFsync) {
          throw new Error("injected file fsync failure");
        }
      },
    });
    const input = {
      streamId: "fsync-before-rename",
      command: { type: "advance_turn", action: "other" } as const,
      beforeState: initial({ turns: 1, hunger: 798 }),
    };
    expect(value.readAfter(input.streamId, 0, 64)).toHaveLength(1);
    // The data segment fsync precedes the separate visibility commit.
    failOnFsync = fsyncCalls + 1;
    expect(() => value.appendTransition(input)).toThrow("injected file fsync failure");
    expect(fs.readFileSync(canonical).byteLength).toBe(beforeFailure.byteLength);
    expect(value.appendTransition(input).status).toBe("appended");
    expect(value.readAfter(input.streamId, 0, 64)).toHaveLength(2);
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(2);
  });

  it("truncates an unacknowledged partial append before accepting a retry", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-partial-"));
    directories.push(directory);
    const initialJournal = new OriginGameplayJournal(directory);
    initialJournal.appendTransition({
      streamId: "partial-append",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    let injectPartial = false;
    let injectedCalls = 0;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        if (!injectPartial || buffer.byteLength <= 256) {
          return fs.writeSync(descriptor, buffer, offset, length);
        }
        injectedCalls++;
        if (injectedCalls === 1) {
          return fs.writeSync(descriptor, buffer, offset, Math.max(1, Math.floor(length / 3)));
        }
        throw new Error("injected partial write failure");
      },
    });
    const input = {
      streamId: "partial-append",
      command: { type: "advance_turn", action: "other" } as const,
      beforeState: initial({ turns: 1, hunger: 798 }),
    };
    expect(value.readAfter(input.streamId, 0, 64)).toHaveLength(1);
    injectPartial = true;
    expect(() => value.appendTransition(input)).toThrow("injected partial write failure");
    injectPartial = false;
    expect(value.readAfter(input.streamId, 0, 64)).toHaveLength(1);
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

  it("rolls back a new segment when its directory-fsync acknowledgement is lost", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-dir-fsync-"));
    directories.push(directory);
    let fsyncCalls = 0;
    let failOnFsync = Number.POSITIVE_INFINITY;
    const value = new OriginGameplayJournal(directory, {
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        fs.fsyncSync(descriptor);
        if (fsyncCalls === failOnFsync) throw new Error("injected directory fsync failure");
      },
    });
    value.appendTransition({
      streamId: "directory-fsync-prime",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    failOnFsync = fsyncCalls + 4;
    const input = {
      streamId: "fsync-after-rename",
      command: { type: "advance_turn", action: "wait" } as const,
      beforeState: initial(),
    };
    expect(() => value.appendTransition(input)).toThrow("injected directory fsync failure");
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(0);
    expect(value.appendTransition(input).status).toBe("appended");
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(1);
  });

  it("writes the complete segment across a permitted short write", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-short-write-"));
    directories.push(directory);
    let calls = 0;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        if (buffer.byteLength <= 256) return fs.writeSync(descriptor, buffer, offset, length);
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
    expect(new OriginGameplayJournal(directory).readAfter("short-write", 0, 64)).toEqual([entryOf(result)]);
  });

  it("rejects a zero-byte write without replacing the canonical segment", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-zero-write-"));
    directories.push(directory);
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) =>
        buffer.byteLength > 256 ? 0 : fs.writeSync(descriptor, buffer, offset, length),
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
    expect(entryOf(result).terminal).toBe(true);
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
    expect(fs.readdirSync(directory)
      .filter((name) => name.startsWith("segmented.") && name.endsWith(".jsonl"))).toHaveLength(2);
    expect(value.readAfter("segmented", 60, 64).map((entry) => entry.cursor)).toEqual([61, 62, 63, 64, 65, 66]);
    expect(value.readAfter("segmented", 64, 64).map((entry) => entry.cursor)).toEqual([65, 66]);
    fs.rmSync(path.join(directory, "segmented.00000001.jsonl"));
    expect(() => value.readAfter("segmented", 64, 64)).toThrow("journal_missing_segment");
  }, 15_000);

  it("writes only the new entry bytes instead of rewriting the current segment", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-linear-"));
    directories.push(directory);
    let bytesWritten = 0;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        const written = fs.writeSync(descriptor, buffer, offset, length);
        bytesWritten += written;
        return written;
      },
    });
    let state = initial();
    for (let index = 0; index < 64; index++) {
      value.appendTransition({
        streamId: "constant-cost",
        command: { type: "advance_turn", action: "other" },
        beforeState: state,
      });
      state = { ...state, turns: state.turns + 1, hunger: Math.max(0, state.hunger - 2) };
    }
    const retainedBytes = fs.statSync(path.join(directory, "constant-cost.00000000.jsonl")).size;
    expect(bytesWritten).toBeLessThan(retainedBytes + 128);
  });

  it("persists one global movement-evidence ceiling across streams and restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-capacity-"));
    directories.push(directory);
    const movementState = (authority: MovementState["authority"]): MovementState => ({
      authority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    });
    const stream = (playerId: string, token: string, floorEpoch: number) => movementJournalStreamId(
      playerId,
      movementJournalRunId(token.repeat(64)),
      { ...movementAuthority, floorInstanceId: `floor-${floorEpoch}`, floorEpoch },
    );
    const firstStream = stream("capacity-1", "b", 1);
    const secondStream = stream("capacity-2", "c", 2);
    const thirdStream = stream("capacity-3", "d", 3);
    const value = new OriginGameplayJournal(directory, { maxMovementEntries: 2 });
    const appendMovement = (journalValue: OriginGameplayJournal, streamId: string, floorEpoch: number) =>
      journalValue.appendTransition({
        streamId,
        command: { type: "move", dx: 1, dy: 0 },
        beforeState: movementState({ ...movementAuthority, floorInstanceId: `floor-${floorEpoch}`, floorEpoch }),
      });

    expect(appendMovement(value, firstStream, 1).status).toBe("appended");
    expect(appendMovement(value, secondStream, 2).status).toBe("appended");
    expect(appendMovement(value, firstStream, 1).status).toBe("duplicate");

    const restarted = new OriginGameplayJournal(directory, { maxMovementEntries: 2 });
    expect(appendMovement(restarted, thirdStream, 3).status).toBe("dropped_capacity");
    expect(restarted.readAfter(thirdStream, 0, 64)).toEqual([]);
    expect(restarted.appendTransition({
      streamId: "v1-remains-available",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("appended");
  });

  it("bootstraps V1 and V2 capacity from canonical evidence without counter sidecars", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-bootstrap-"));
    directories.push(directory);
    const movementDirectory = path.join(directory, "movement-v2");
    fs.mkdirSync(movementDirectory, { mode: 0o700 });
    const vitals = createShadowJournalEntry({
      streamId: "bootstrap-vitals",
      cursor: 1,
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const movementState: MovementState = {
      authority: movementAuthority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    };
    const movementStream = movementJournalStreamId("bootstrap-player", movementRunId, movementAuthority);
    const movement = createShadowJournalEntry({
      streamId: movementStream,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState,
    });
    fs.writeFileSync(
      path.join(directory, "bootstrap-vitals.00000000.jsonl"),
      `${JSON.stringify(vitals)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(movementDirectory, `${movementStream}.00000000.jsonl`),
      `${JSON.stringify(movement)}\n`,
      { mode: 0o600 },
    );

    const value = new OriginGameplayJournal(directory, {
      maxGameplayEntries: 2,
      maxMovementEntries: 2,
    });
    expect(value.appendTransition({
      streamId: "bootstrap-vitals",
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    }).status).toBe("appended");
    expect(value.appendTransition({
      streamId: movementStream,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: { ...movementState, x: 9 },
    }).status).toBe("appended");
    expect(value.appendTransition({
      streamId: "another-vitals",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("dropped_capacity");
    expect(value.appendTransition({
      streamId: "another-movement",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState,
    }).status).toBe("dropped_capacity");
    expect(fs.readdirSync(directory).some((name) => name.includes("budget"))).toBe(false);
    expect(fs.readdirSync(movementDirectory).some((name) => name.includes("budget"))).toBe(false);
  });

  it("re-syncs child sidecar directories before retrying the migration sentinel", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-migration-order-"));
    directories.push(directory);
    const movementDirectory = path.join(directory, "movement-v2");
    fs.mkdirSync(movementDirectory, { mode: 0o700 });
    const streamId = movementJournalStreamId("migration-player", movementRunId, movementAuthority);
    const movementState: MovementState = {
      authority: movementAuthority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    };
    const entry = createShadowJournalEntry({
      streamId,
      cursor: 1,
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: movementState,
    });
    const dataFile = path.join(movementDirectory, `${streamId}.00000000.jsonl`);
    fs.writeFileSync(dataFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    let fsyncCalls = 0;
    const value = new OriginGameplayJournal(directory, {
      maxMovementEntries: 1,
      fsyncSync: (descriptor) => {
        fsyncCalls++;
        fs.fsyncSync(descriptor);
        if (fsyncCalls === 2) throw new Error("injected movement sidecar directory fsync loss");
      },
    });
    const overflow = {
      streamId: movementJournalStreamId("migration-overflow", movementRunId, movementAuthority),
      command: { type: "move", dx: 1, dy: 0 } as const,
      beforeState: movementState,
    };
    expect(() => value.appendTransition(overflow))
      .toThrow("injected movement sidecar directory fsync loss");
    expect(fs.existsSync(`${dataFile}.commits`)).toBe(true);
    expect(fs.existsSync(path.join(directory, ".origin-journal-commit-sidecars-v1"))).toBe(false);

    expect(value.appendTransition(overflow).status).toBe("dropped_capacity");
    expect(fs.existsSync(path.join(directory, ".origin-journal-commit-sidecars-v1"))).toBe(true);
    expect(fsyncCalls).toBeGreaterThanOrEqual(6);
  });

  it("reconciles capacity after an append failure without leaking a reservation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-reconcile-"));
    directories.push(directory);
    let failNextFsync = true;
    const value = new OriginGameplayJournal(directory, {
      maxGameplayEntries: 2,
      fsyncSync: (descriptor) => {
        if (failNextFsync) {
          failNextFsync = false;
          throw new Error("injected journal fsync failure");
        }
        fs.fsyncSync(descriptor);
      },
    });
    const first = {
      streamId: "reconcile-capacity",
      command: { type: "advance_turn", action: "wait" } as const,
      beforeState: initial(),
    };
    expect(() => value.appendTransition(first)).toThrow("injected journal fsync failure");
    expect(() => value.readAfter(first.streamId, 0, 64)).toThrow("journal_writer_busy");
    expect(value.appendTransition(first).status).toBe("appended");
    expect(value.appendTransition({
      streamId: first.streamId,
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    }).status).toBe("appended");
    expect(value.appendTransition({
      streamId: "reconcile-overflow",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("dropped_capacity");
    expect(value.readAfter(first.streamId, 0, 64)).toHaveLength(2);
  });

  it("exposes only committed records to an online reader and repairs a failed commit", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-commit-"));
    directories.push(directory);
    let failCommit = false;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        if (failCommit && buffer.byteLength === 1) throw new Error("injected commit failure");
        return fs.writeSync(descriptor, buffer, offset, length);
      },
    });
    const first = value.appendTransition({
      streamId: "commit-visibility",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    expect(first.status).toBe("appended");
    const second = {
      streamId: "commit-visibility",
      command: { type: "advance_turn", action: "other" } as const,
      beforeState: initial({ turns: 1, hunger: 798 }),
    };
    failCommit = true;
    expect(() => value.appendTransition(second)).toThrow("injected commit failure");
    expect(new OriginGameplayJournal(directory).readAfter(second.streamId, 0, 64))
      .toEqual([entryOf(first)]);
    failCommit = false;
    expect(value.appendTransition(second).status).toBe("appended");
    expect(new OriginGameplayJournal(directory).readAfter(second.streamId, 0, 64)).toHaveLength(2);
  });

  it("keeps the reader fence active until a failed commit can be durably recovered", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-fenced-recovery-"));
    directories.push(directory);
    let failAfterCommitWrite = false;
    let commitWriteVisible = false;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        const written = fs.writeSync(descriptor, buffer, offset, length);
        if (failAfterCommitWrite && buffer.byteLength === 1) commitWriteVisible = true;
        return written;
      },
      fsyncSync: (descriptor) => {
        if (commitWriteVisible) throw new Error("persistent_commit_sync_failure");
        fs.fsyncSync(descriptor);
      },
    });
    value.appendTransition({
      streamId: "fenced-recovery",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const second = {
      streamId: "fenced-recovery",
      command: { type: "advance_turn", action: "other" } as const,
      beforeState: initial({ turns: 1, hunger: 798 }),
    };
    failAfterCommitWrite = true;
    expect(() => value.appendTransition(second)).toThrow("persistent_commit_sync_failure");
    const sequence = Number(fs.readFileSync(
      path.join(directory, ".origin-journal-write-sequence-v1"),
      "utf8",
    ).trim().split(":").at(-1));
    expect(sequence % 2).toBe(1);
    expect(() => new OriginGameplayJournal(directory).readAfter(second.streamId, 0, 64))
      .toThrow("journal_writer_busy");

    failAfterCommitWrite = false;
    commitWriteVisible = false;
    expect(value.appendTransition(second).status).toBe("duplicate");
    expect(new OriginGameplayJournal(directory).readAfter(second.streamId, 0, 64))
      .toHaveLength(2);
  });

  it("deduplicates the final retained slot after commit-fsync acknowledgement loss", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-final-ack-"));
    directories.push(directory);
    let commitWritten = false;
    let failCommitFsync = true;
    const value = new OriginGameplayJournal(directory, {
      maxGameplayEntries: 1,
      writeSync: (descriptor, buffer, offset, length) => {
        const written = fs.writeSync(descriptor, buffer, offset, length);
        if (buffer.byteLength === 1) commitWritten = true;
        return written;
      },
      fsyncSync: (descriptor) => {
        fs.fsyncSync(descriptor);
        if (commitWritten && failCommitFsync) {
          failCommitFsync = false;
          throw new Error("injected commit fsync acknowledgement loss");
        }
      },
    });
    const input = {
      streamId: "final-ack",
      command: { type: "advance_turn", action: "wait" } as const,
      beforeState: initial(),
    };
    expect(() => value.appendTransition(input)).toThrow("injected commit fsync acknowledgement loss");
    expect(new OriginGameplayJournal(directory).readAfter(input.streamId, 0, 64)).toHaveLength(1);
    expect(value.appendTransition(input).status).toBe("duplicate");
  });

  it("allows a separate online catch-up process to read without taking writer ownership", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-online-read-"));
    directories.push(directory);
    const value = new OriginGameplayJournal(directory);
    value.appendTransition({
      streamId: "online-catchup",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const child = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        "-e",
        "import { OriginGameplayJournal } from './server/origin-journal.ts'; " +
          "const rows = new OriginGameplayJournal(process.env.JOURNAL_DIR).readAfter('online-catchup', 0, 64); " +
          "process.stdout.write(JSON.stringify(rows.map((entry) => entry.cursor)));",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, JOURNAL_DIR: directory },
        encoding: "utf8",
      },
    );
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
    expect(child.stdout).toBe("[1]");
  });

  it("waits through a healthy writer fence that exceeds the old 8ms contention budget", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-reader-wait-"));
    directories.push(directory);
    const writer = new OriginGameplayJournal(directory);
    writer.appendTransition({
      streamId: "reader-wait",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const sequenceFile = path.join(directory, ".origin-journal-write-sequence-v1");
    const otherOwner = "77777777-7777-4777-8777-777777777777";
    fs.writeFileSync(sequenceFile, `${otherOwner}:1\n`, { mode: 0o600 });
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(() => require('node:fs').writeFileSync(process.env.SEQUENCE_FILE, process.env.EVEN_TOKEN, { mode: 0o600 }), 40)",
    ], {
      env: { ...process.env, SEQUENCE_FILE: sequenceFile, EVEN_TOKEN: `${otherOwner}:2\n` },
      stdio: "ignore",
    });
    expect(new OriginGameplayJournal(directory).readAfter("reader-wait", 0, 64))
      .toHaveLength(1);
    child.kill();
  });

  it("refreshes an online reader head between catch-up pages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-paged-reader-"));
    directories.push(directory);
    const writer = new OriginGameplayJournal(directory);
    writer.appendTransition({
      streamId: "paged-reader",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const reader = new OriginGameplayJournal(directory);
    expect(reader.readAfter("paged-reader", 0, 1).map((entry) => entry.cursor)).toEqual([1]);
    writer.appendTransition({
      streamId: "paged-reader",
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    });
    expect(reader.readAfter("paged-reader", 1, 1).map((entry) => entry.cursor)).toEqual([2]);
  });

  it("returns a lagging stable prefix when a writer commits during the data read", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-reader-race-"));
    directories.push(directory);
    const writer = new OriginGameplayJournal(directory);
    expect(writer.appendTransition({
      streamId: "reader-race",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("appended");
    const dataFile = path.join(directory, "reader-race.00000000.jsonl");
    let interleaved = false;
    const reader = new OriginGameplayJournal(directory, {
      readFileSync: (file) => {
        const snapshot = fs.readFileSync(file);
        if (file === dataFile && !interleaved) {
          interleaved = true;
          expect(writer.appendTransition({
            streamId: "reader-race",
            command: { type: "advance_turn", action: "other" },
            beforeState: initial({ turns: 1, hunger: 798 }),
          }).status).toBe("appended");
        }
        return snapshot;
      },
    });
    expect(reader.readAfter("reader-race", 0, 64)).toHaveLength(2);
    expect(interleaved).toBe(true);
    expect(new OriginGameplayJournal(directory).readAfter("reader-race", 0, 64)).toHaveLength(2);
  });

  it("does not publish a visible commit byte before its fsync barrier", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-prefsync-read-"));
    directories.push(directory);
    let inspectCommitWindow = false;
    let observation = "not-observed";
    const writer = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        const written = fs.writeSync(descriptor, buffer, offset, length);
        if (inspectCommitWindow && buffer.byteLength === 1) {
          inspectCommitWindow = false;
          try {
            new OriginGameplayJournal(directory).readAfter("prefsync-read", 0, 64);
            observation = "published";
          } catch (error) {
            observation = error instanceof Error ? error.message : String(error);
          }
        }
        return written;
      },
    });
    writer.appendTransition({
      streamId: "prefsync-read",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    inspectCommitWindow = true;
    writer.appendTransition({
      streamId: "prefsync-read",
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    });
    expect(observation).toBe("journal_writer_busy");
    expect(new OriginGameplayJournal(directory).readAfter("prefsync-read", 0, 64)).toHaveLength(2);
  });

  it("fsyncs the odd writer fence before opening the next evidence record", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-durable-fence-"));
    directories.push(directory);
    const writer = new OriginGameplayJournal(directory);
    writer.appendTransition({
      streamId: "durable-fence",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const sequenceInode = fs.statSync(
      path.join(directory, ".origin-journal-write-sequence-v1"),
    ).ino;
    const events: Array<"sequence" | "directory" | "evidence"> = [];
    const originalFsync = fs.fsyncSync.bind(fs);
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      const metadata = fs.fstatSync(descriptor);
      if (metadata.ino === sequenceInode) events.push("sequence");
      else if (metadata.isDirectory()) events.push("directory");
      else events.push("evidence");
      originalFsync(descriptor);
    });
    try {
      expect(new OriginGameplayJournal(directory).appendTransition({
        streamId: "durable-fence",
        command: { type: "advance_turn", action: "other" },
        beforeState: initial({ turns: 1, hunger: 798 }),
      }).status).toBe("appended");
    } finally {
      fsyncSpy.mockRestore();
    }
    const sequenceFsync = events.indexOf("sequence");
    const firstEvidenceFsync = events.indexOf("evidence");
    expect(sequenceFsync).toBeGreaterThanOrEqual(0);
    expect(firstEvidenceFsync).toBeGreaterThan(sequenceFsync);
  });

  it("shares mutable stream heads when a same-process reader becomes a writer", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-shared-head-"));
    directories.push(directory);
    const firstWriter = new OriginGameplayJournal(directory);
    firstWriter.appendTransition({
      streamId: "shared-head",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const readerThenWriter = new OriginGameplayJournal(directory);
    expect(readerThenWriter.readAfter("shared-head", 0, 64)).toHaveLength(1);
    firstWriter.appendTransition({
      streamId: "shared-head",
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 1, hunger: 798 }),
    });
    expect(readerThenWriter.appendTransition({
      streamId: "shared-head",
      command: { type: "advance_turn", action: "other" },
      beforeState: initial({ turns: 2, hunger: 796 }),
    }).status).toBe("appended");
    expect(new OriginGameplayJournal(directory).readAfter("shared-head", 0, 64)
      .map((entry) => entry.cursor)).toEqual([1, 2, 3]);
  });

  it("rejects structurally corrupt canonical evidence before capacity can mask it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-structure-"));
    directories.push(directory);
    const misplaced = createShadowJournalEntry({
      streamId: "misplaced",
      cursor: 2,
      previousEntryHash: "1111111111111111",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    fs.writeFileSync(
      path.join(directory, "misplaced.00000000.jsonl"),
      `${JSON.stringify(misplaced)}\n`,
      { mode: 0o600 },
    );
    const value = new OriginGameplayJournal(directory, { maxGameplayEntries: 1 });
    expect(() => value.appendTransition({
      streamId: "fresh",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    })).toThrow("journal_corrupt_sequence");
    expect(fs.existsSync(path.join(directory, ".origin-journal-commit-sidecars-v1"))).toBe(false);
  });

  it("drops saturated fresh streams without filesystem work or head-cache growth", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-saturated-"));
    directories.push(directory);
    const value = new OriginGameplayJournal(directory, {
      maxGameplayEntries: 1,
      maxMovementEntries: 1,
    });
    expect(value.appendTransition({
      streamId: "saturated-vitals",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("appended");
    expect(value.appendTransition({
      streamId: movementJournalStreamId("saturated-movement", movementRunId, movementAuthority),
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: {
        authority: movementAuthority,
        x: 8,
        y: 4,
        phase: "playing",
        alive: true,
        immobilizedTurns: 0,
        destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
      },
    }).status).toBe("appended");
    const mtime = fs.statSync(directory).mtimeMs;
    const spies = [
      vi.spyOn(fs, "readdirSync"),
      vi.spyOn(fs, "openSync"),
      vi.spyOn(fs, "writeSync"),
      vi.spyOn(fs, "fsyncSync"),
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "rmSync"),
    ];
    try {
      for (let index = 0; index < 100; index++) {
        expect(value.appendTransition({
          streamId: `dropped-vitals-${index}`,
          command: { type: "advance_turn", action: "wait" },
          beforeState: initial(),
        }).status).toBe("dropped_capacity");
        expect(value.appendTransition({
          streamId: `dropped-movement-${index}`,
          command: { type: "move", dx: 1, dy: 0 },
          beforeState: {
            authority: movementAuthority,
            x: 8,
            y: 4,
            phase: "playing",
            alive: true,
            immobilizedTurns: 0,
            destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
          },
        }).status).toBe("dropped_capacity");
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(fs.statSync(directory).mtimeMs).toBe(mtime);
    expect((value as unknown as { heads: Map<string, unknown> }).heads.size).toBe(2);
  });

  it("rejects a second live process owner and reclaims only a dead owner", () => {
    const activeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-active-owner-"));
    directories.push(activeDirectory);
    const activeOwner = ".origin-journal-owner-11111111-1111-4111-8111-111111111111.json";
    const activePayload = `${JSON.stringify({
      v: 1,
      pid: process.pid,
      ownerId: "11111111-1111-4111-8111-111111111111",
      ownerFileName: activeOwner,
      startedAt: new Date().toISOString(),
    })}\n`;
    fs.writeFileSync(path.join(activeDirectory, activeOwner), activePayload, { mode: 0o600 });
    fs.linkSync(
      path.join(activeDirectory, activeOwner),
      path.join(activeDirectory, ".origin-journal-writer-v1.lock"),
    );
    expect(() => new OriginGameplayJournal(activeDirectory).appendTransition({
      streamId: "active-owner",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    })).toThrow("journal_writer_already_active");

    const staleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-stale-owner-"));
    directories.push(staleDirectory);
    const staleOwner = ".origin-journal-owner-22222222-2222-4222-8222-222222222222.json";
    const stalePayload = `${JSON.stringify({
      v: 1,
      pid: 2_147_483_647,
      ownerId: "22222222-2222-4222-8222-222222222222",
      ownerFileName: staleOwner,
      startedAt: new Date(0).toISOString(),
    })}\n`;
    fs.writeFileSync(path.join(staleDirectory, staleOwner), stalePayload, { mode: 0o600 });
    fs.linkSync(
      path.join(staleDirectory, staleOwner),
      path.join(staleDirectory, ".origin-journal-writer-v1.lock"),
    );
    const abandonedRecoveryOwner = ".origin-journal-owner-55555555-5555-4555-8555-555555555555.json";
    fs.writeFileSync(path.join(staleDirectory, abandonedRecoveryOwner), `${JSON.stringify({
      v: 1,
      pid: 2_147_483_647,
      ownerId: "55555555-5555-4555-8555-555555555555",
      ownerFileName: abandonedRecoveryOwner,
      startedAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    fs.linkSync(
      path.join(staleDirectory, abandonedRecoveryOwner),
      path.join(staleDirectory, ".origin-journal-writer-recovery-v1.lock"),
    );
    expect(new OriginGameplayJournal(staleDirectory).appendTransition({
      streamId: "stale-owner",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("appended");
    const reclaimed = JSON.parse(fs.readFileSync(
      path.join(staleDirectory, ".origin-journal-writer-v1.lock"),
      "utf8",
    )) as { pid: number };
    expect(reclaimed.pid).toBe(process.pid);
    expect(fs.existsSync(path.join(staleDirectory, ".origin-journal-writer-recovery-v1.lock")))
      .toBe(false);

    if (process.platform !== "win32") {
      const reusedPidDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-reused-pid-"));
      directories.push(reusedPidDirectory);
      const reusedPidOwner = ".origin-journal-owner-66666666-6666-4666-8666-666666666666.json";
      fs.writeFileSync(path.join(reusedPidDirectory, reusedPidOwner), `${JSON.stringify({
        v: 1,
        pid: process.pid,
        ownerId: "66666666-6666-4666-8666-666666666666",
        ownerFileName: reusedPidOwner,
        startedAt: new Date(0).toISOString(),
        processStartId: "ps:definitely-not-the-current-process",
      })}\n`, { mode: 0o600 });
      fs.linkSync(
        path.join(reusedPidDirectory, reusedPidOwner),
        path.join(reusedPidDirectory, ".origin-journal-writer-v1.lock"),
      );
      expect(new OriginGameplayJournal(reusedPidDirectory).appendTransition({
        streamId: "reused-pid-owner",
        command: { type: "advance_turn", action: "wait" },
        beforeState: initial(),
      }).status).toBe("appended");
    }

    const contendedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-contended-owner-"));
    directories.push(contendedDirectory);
    const contendedOwner = ".origin-journal-owner-33333333-3333-4333-8333-333333333333.json";
    const contendedPayload = `${JSON.stringify({
      v: 1,
      pid: 2_147_483_647,
      ownerId: "33333333-3333-4333-8333-333333333333",
      ownerFileName: contendedOwner,
      startedAt: new Date(0).toISOString(),
    })}\n`;
    const contendedOwnerPath = path.join(contendedDirectory, contendedOwner);
    const contendedLock = path.join(contendedDirectory, ".origin-journal-writer-v1.lock");
    fs.writeFileSync(contendedOwnerPath, contendedPayload, { mode: 0o600 });
    fs.linkSync(contendedOwnerPath, contendedLock);
    const activeRecoveryOwner = ".origin-journal-owner-44444444-4444-4444-8444-444444444444.json";
    fs.writeFileSync(path.join(contendedDirectory, activeRecoveryOwner), `${JSON.stringify({
      v: 1,
      pid: process.pid,
      ownerId: "44444444-4444-4444-8444-444444444444",
      ownerFileName: activeRecoveryOwner,
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    fs.linkSync(
      path.join(contendedDirectory, activeRecoveryOwner),
      path.join(contendedDirectory, ".origin-journal-writer-recovery-v1.lock"),
    );
    const inodeBefore = fs.statSync(contendedLock).ino;
    expect(() => new OriginGameplayJournal(contendedDirectory).appendTransition({
      streamId: "contended-owner",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    })).toThrow("journal_writer_recovery_busy");
    expect(fs.statSync(contendedLock).ino).toBe(inodeBefore);
    expect(fs.existsSync(path.join(contendedDirectory, "contended-owner.00000000.jsonl"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked journal root", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-symlink-root-"));
    directories.push(parent);
    const canonical = path.join(parent, "canonical");
    const alias = path.join(parent, "alias");
    fs.mkdirSync(canonical, { mode: 0o700 });
    fs.symlinkSync(canonical, alias, "dir");
    expect(() => new OriginGameplayJournal(alias).appendTransition({
      streamId: "symlink-root",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    })).toThrow("journal_directory_insecure");
    expect(fs.readdirSync(canonical)).toEqual([]);
  });

  it("removes a partial first record and rejects oversized records before parsing", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-partial-first-"));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, "partial-first.00000000.jsonl"), "{partial", { mode: 0o600 });
    const value = new OriginGameplayJournal(directory);
    expect(value.readAfter("partial-first", 0, 64)).toEqual([]);
    expect(value.appendTransition({
      streamId: "partial-first",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }).status).toBe("appended");

    const oversizedEntry = createShadowJournalEntry({
      streamId: "oversized-line",
      cursor: 1,
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    fs.writeFileSync(
      path.join(directory, "oversized-line.00000000.jsonl"),
      `${JSON.stringify({ ...oversizedEntry, padding: "x".repeat(9_000) })}\n`,
      { mode: 0o600 },
    );
    expect(() => new OriginGameplayJournal(directory).readAfter("oversized-line", 0, 64))
      .toThrow("journal_entry_too_large");

    fs.writeFileSync(
      path.join(directory, "oversized-segment.00000000.jsonl"),
      "x".repeat(64 * 8 * 1024 + 1),
      { mode: 0o600 },
    );
    expect(() => new OriginGameplayJournal(directory).readAfter("oversized-segment", 0, 64))
      .toThrow("journal_segment_too_large");
  });

  it("does not rescan unrelated journal filenames for fresh V1 or V2 streams", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-origin-journal-run-scan-"));
    directories.push(directory);
    const value = new OriginGameplayJournal(directory, { maxMovementEntries: 4 });
    const movementState = (authority: MovementState["authority"]): MovementState => ({
      authority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    });
    const append = (playerId: string, token: string, floorEpoch: number) => {
      const authority = { ...movementAuthority, floorInstanceId: `scan-floor-${floorEpoch}`, floorEpoch };
      return value.appendTransition({
        streamId: movementJournalStreamId(playerId, movementJournalRunId(token.repeat(64)), authority),
        command: { type: "move", dx: 1, dy: 0 },
        beforeState: movementState(authority),
      });
    };
    expect(append("scan-1", "e", 1).status).toBe("appended");
    const readdir = vi.spyOn(fs, "readdirSync");
    try {
      expect(append("scan-2", "f", 2).status).toBe("appended");
      expect(value.appendTransition({
        streamId: "scan-vitals",
        command: { type: "advance_turn", action: "wait" },
        beforeState: initial(),
      }).status).toBe("appended");
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
    }
  });

  it("chains mixed V1 vitals and V2 movement entries across restart", () => {
    const { directory, value } = journal();
    const vitals = entryOf(value.appendTransition({
      streamId: "mixed",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    }));
    const beforeState: MovementState = {
      authority: movementAuthority,
      x: 8,
      y: 4,
      phase: "playing",
      alive: true,
      immobilizedTurns: 0,
      destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
    };
    const movement = entryOf(value.appendTransition({
      streamId: "mixed",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState,
    }));
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
    expect([entryOf(first).cursor, entryOf(second).cursor]).toEqual([1, 2]);
  });
});
