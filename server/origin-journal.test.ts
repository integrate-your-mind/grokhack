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
  movementTurnJournalStreamId,
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

const movementBefore = (overrides: Partial<MovementState> = {}): MovementState => ({
  authority: movementAuthority,
  x: 8,
  y: 4,
  phase: "playing",
  alive: true,
  immobilizedTurns: 0,
  destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
  ...overrides,
});

function movementTurnInput(operationId = "00000000-0000-4000-8000-000000000001") {
  return {
    streamId: movementTurnJournalStreamId("player-1", movementRunId, movementAuthority),
    operationId,
    command: { type: "move", dx: 1, dy: 0 } as const,
    beforeState: movementBefore(),
    turn: {
      command: { type: "advance_turn", action: "other" } as const,
      beforeState: initial(),
    },
  };
}

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
    expect(movementTurnJournalStreamId("player-1", movementRunId, movementAuthority))
      .toMatch(/^turn_[0-9a-f]{48}$/u);
  });

  it("atomically appends, pages, restarts, deduplicates, and conflicts movement-turn envelopes", () => {
    const { directory, value } = journal();
    const firstInput = movementTurnInput();
    const first = value.appendMovementTurn(firstInput);
    expect(first.status).toBe("appended");
    const committed = value.readMovementTurnsAfter(firstInput.streamId, 0, 1);
    expect(committed).toEqual([
      expect.objectContaining({
        cursor: 1,
        operationId: firstInput.operationId,
        movement: expect.objectContaining({ v: 2 }),
        turn: expect.objectContaining({ v: 1 }),
      }),
    ]);
    expect(new OriginGameplayJournal(directory).readMovementTurnsAfter(firstInput.streamId, 0, 64))
      .toEqual(committed);
    expect(value.appendMovementTurn(firstInput).status).toBe("duplicate");
    expect(() => value.appendMovementTurn({
      ...firstInput,
      beforeState: movementBefore({ x: 99 }),
    })).toThrow("movement_turn_operation_conflict");

    const secondInput = {
      ...movementTurnInput("00000000-0000-4000-8000-000000000002"),
      beforeState: movementBefore({ x: 9 }),
      turn: {
        command: { type: "advance_turn", action: "other" } as const,
        beforeState: initial({ turns: 1, hunger: 798 }),
      },
    };
    expect(value.appendMovementTurn(secondInput).status).toBe("appended");
    expect(value.readMovementTurnsAfter(firstInput.streamId, 1, 1).map((entry) => entry.cursor)).toEqual([2]);
    expect(new OriginGameplayJournal(directory).readMovementTurnsAfter(firstInput.streamId, 0, 64)
      .map((entry) => entry.cursor)).toEqual([1, 2]);
  });

  it("keeps one preparation durable and clears it only after matching envelope and persistence commit", () => {
    const { directory, value } = journal();
    const input = movementTurnInput("00000000-0000-4000-8000-000000000009");
    expect(value.hasPendingMovementTurn()).toBe(false);

    value.prepareMovementTurn(input);
    value.prepareMovementTurn(input);
    expect(value.hasPendingMovementTurn()).toBe(true);
    const preparationFile = path.join(directory, "movement-turn-v1", ".movement-turn-preparation-v1.json");
    expect(fs.readdirSync(path.dirname(preparationFile)).filter((name) => name.includes("preparation")))
      .toEqual([path.basename(preparationFile)]);
    expect(fs.statSync(preparationFile).mode & 0o077).toBe(0);

    const restarted = new OriginGameplayJournal(directory);
    expect(restarted.hasPendingMovementTurn()).toBe(true);
    expect(() => restarted.completeMovementTurnPreparation(input))
      .toThrow("movement_turn_preparation_uncommitted");
    expect(() => restarted.prepareMovementTurn({
      ...input,
      operationId: "00000000-0000-4000-8000-00000000000a",
    })).toThrow("movement_turn_preparation_exists");

    expect(restarted.appendMovementTurn(input).status).toBe("appended");
    const unrelated = {
      ...movementTurnInput("00000000-0000-4000-8000-00000000000a"),
      beforeState: movementBefore({ x: 9 }),
      turn: {
        command: { type: "advance_turn", action: "other" } as const,
        beforeState: initial({ turns: 1, hunger: 798 }),
      },
    };
    expect(restarted.appendMovementTurn(unrelated).status).toBe("appended");
    expect(() => restarted.completeMovementTurnPreparation(unrelated))
      .toThrow("movement_turn_preparation_conflict");
    expect(restarted.hasPendingMovementTurn()).toBe(true);
    expect(() => restarted.completeMovementTurnPreparation(input))
      .toThrow("movement_turn_origin_not_applied");
    restarted.markMovementTurnApplied(input);
    expect(() => restarted.completeMovementTurnPreparation(input))
      .toThrow("movement_turn_persistence_not_committed");
    restarted.markMovementTurnPersistenceCommitted(input);
    restarted.completeMovementTurnPreparation(input);
    expect(restarted.hasPendingMovementTurn()).toBe(false);
    expect(new OriginGameplayJournal(directory).hasPendingMovementTurn()).toBe(false);
  });

  it("does not rescan every movement-turn segment while recovering the fixed preparation temp", () => {
    const { directory, value } = journal();
    const movementTurnDirectory = path.join(directory, "movement-turn-v1");
    const originalReaddirSync = fs.readdirSync;
    let preparationDirectoryScans = 0;
    fs.readdirSync = ((...args: unknown[]) => {
      if (path.resolve(String(args[0])) === movementTurnDirectory) preparationDirectoryScans++;
      return Reflect.apply(originalReaddirSync, fs, args) as ReturnType<typeof fs.readdirSync>;
    }) as typeof fs.readdirSync;

    try {
      const first = movementTurnInput("00000000-0000-4000-8000-000000000101");
      value.prepareMovementTurn(first);
      expect(value.appendMovementTurn(first).status).toBe("appended");
      value.markMovementTurnApplied(first);
      value.markMovementTurnPersistenceCommitted(first);
      value.completeMovementTurnPreparation(first);
      const scansAfterFirstTurn = preparationDirectoryScans;

      const second = {
        ...movementTurnInput("00000000-0000-4000-8000-000000000102"),
        beforeState: movementBefore({ x: 9 }),
        turn: {
          command: { type: "advance_turn", action: "other" } as const,
          beforeState: initial({ turns: 1, hunger: 798 }),
        },
      };
      value.prepareMovementTurn(second);
      expect(value.appendMovementTurn(second).status).toBe("appended");
      value.markMovementTurnApplied(second);
      value.markMovementTurnPersistenceCommitted(second);
      value.completeMovementTurnPreparation(second);

      expect(scansAfterFirstTurn).toBeLessThanOrEqual(1);
      expect(preparationDirectoryScans - scansAfterFirstTurn).toBe(0);
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });

  it("keeps cold origin-applied and earlier crash preparations fenced", () => {
    const committedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-reconcile-"));
    directories.push(committedDirectory);
    const committedInput = movementTurnInput("00000000-0000-4000-8000-000000000013");
    const committed = new OriginGameplayJournal(committedDirectory);
    committed.prepareMovementTurn(committedInput);
    expect(committed.appendMovementTurn(committedInput).status).toBe("appended");

    const committedRestart = new OriginGameplayJournal(committedDirectory);
    expect(committedRestart.hasPendingMovementTurn()).toBe(true);
    committedRestart.markMovementTurnApplied(committedInput);
    const appliedRestart = new OriginGameplayJournal(committedDirectory);
    expect(appliedRestart.hasPendingMovementTurn()).toBe(true);
    expect(fs.existsSync(path.join(
      committedDirectory,
      "movement-turn-v1",
      ".movement-turn-preparation-v1.json",
    ))).toBe(true);
    expect(committedRestart.readMovementTurnsAfter(committedInput.streamId, 0, 64)).toHaveLength(1);
    committedRestart.markMovementTurnPersistenceCommitted(committedInput);
    expect(new OriginGameplayJournal(committedDirectory).hasPendingMovementTurn()).toBe(false);

    const uncommittedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-uncommitted-"));
    directories.push(uncommittedDirectory);
    const uncommittedInput = movementTurnInput("00000000-0000-4000-8000-000000000014");
    const uncommitted = new OriginGameplayJournal(uncommittedDirectory);
    uncommitted.prepareMovementTurn(uncommittedInput);
    expect(new OriginGameplayJournal(uncommittedDirectory).hasPendingMovementTurn()).toBe(true);
  });

  it("removes bounded preparation temp files left by a crash before rename", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-temp-recovery-"));
    directories.push(directory);
    const turnDirectory = path.join(directory, "movement-turn-v1");
    fs.mkdirSync(turnDirectory, { recursive: true, mode: 0o700 });
    const legacyTemp = path.join(
      turnDirectory,
      ".movement-turn-preparation-v1.json.999.00000000-0000-4000-8000-000000000015.tmp",
    );
    const fixedTemp = path.join(turnDirectory, ".movement-turn-preparation-v1.tmp");
    fs.writeFileSync(legacyTemp, "prepared\n", { mode: 0o600 });
    fs.writeFileSync(fixedTemp, "prepared\n", { mode: 0o600 });

    expect(new OriginGameplayJournal(directory).hasPendingMovementTurn()).toBe(false);
    expect(fs.readdirSync(turnDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed without unlink amplification when the legacy temp inventory is excessive", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-temp-inventory-"));
    directories.push(directory);
    const turnDirectory = path.join(directory, "movement-turn-v1");
    fs.mkdirSync(turnDirectory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 65; index++) {
      fs.writeFileSync(
        path.join(
          turnDirectory,
          `.movement-turn-preparation-v1.json.${index + 1}.${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000015.tmp`,
        ),
        "prepared\n",
        { mode: 0o600 },
      );
    }

    const value = new OriginGameplayJournal(directory);
    expect(value.hasPendingMovementTurn()).toBe(true);
    expect(() => value.prepareMovementTurn(movementTurnInput()))
      .toThrow("movement_turn_preparation_temp_inventory_too_large");
    expect(fs.readdirSync(turnDirectory).filter((name) => name.endsWith(".tmp"))).toHaveLength(65);
  });

  it("recovers a real process death after fixed-temp fsync without admitting a marker", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-temp-crash-"));
    directories.push(directory);
    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        import fs from "node:fs";
        import {
          movementJournalRunId,
          movementTurnJournalStreamId,
          OriginGameplayJournal,
        } from "./server/origin-journal.ts";
        const directory = process.argv[1];
        const authority = {
          realmId: "legacy-1",
          floorInstanceId: "floor-instance-1",
          depth: 1,
          floorEpoch: 1,
          rulesetVersion: 1,
        };
        const beforeState = {
          authority,
          x: 8,
          y: 4,
          phase: "playing",
          alive: true,
          immobilizedTurns: 0,
          destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
        };
        let markerWritten = false;
        const journal = new OriginGameplayJournal(directory, {
          writeSync(descriptor, buffer, offset, length) {
            const count = fs.writeSync(descriptor, buffer, offset, length);
            if (Buffer.from(buffer).toString("utf8").includes('"streamId":"turn_')) {
              markerWritten = true;
            }
            return count;
          },
          fsyncSync(descriptor) {
            fs.fsyncSync(descriptor);
            const metadata = fs.fstatSync(descriptor);
            if (markerWritten && metadata.isFile() && metadata.size > 0 && metadata.size <= 512) {
              process.exit(91);
            }
          },
        });
        const runId = movementJournalRunId("a".repeat(64));
        journal.prepareMovementTurn({
          streamId: movementTurnJournalStreamId("player-1", runId, authority),
          operationId: "00000000-0000-4000-8000-000000000016",
          command: { type: "move", dx: 1, dy: 0 },
          beforeState,
        });
      `,
      directory,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(child.status, child.stderr).toBe(91);

    const turnDirectory = path.join(directory, "movement-turn-v1");
    expect(fs.existsSync(path.join(turnDirectory, ".movement-turn-preparation-v1.json"))).toBe(false);
    expect(fs.readdirSync(turnDirectory).filter((name) => name.endsWith(".tmp")))
      .toEqual([".movement-turn-preparation-v1.tmp"]);
    expect(new OriginGameplayJournal(directory).hasPendingMovementTurn()).toBe(false);
    expect(fs.readdirSync(turnDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("recovers real process death across origin, persistence, and cleanup durability boundaries", () => {
    const scenarios = [
      { name: "applied_temp_fsync", status: 92, pending: true },
      { name: "applied_rename", status: 93, pending: true },
      { name: "applied_directory_fsync", status: 94, pending: true },
      { name: "after_applied", status: 95, pending: true },
      { name: "persisted_temp_fsync", status: 98, pending: true },
      { name: "persisted_rename", status: 99, pending: false },
      { name: "persisted_directory_fsync", status: 100, pending: false },
      { name: "after_persisted", status: 101, pending: false },
      { name: "after_unlink", status: 96, pending: false },
      { name: "cleanup_directory_fsync", status: 97, pending: false },
    ] as const;
    for (const scenario of scenarios) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `grokhack-${scenario.name}-`));
      directories.push(directory);
      const child = spawnSync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import {
            movementJournalRunId,
            movementTurnJournalStreamId,
            OriginGameplayJournal,
          } from "./server/origin-journal.ts";
          const directory = process.argv[1];
          const scenario = process.argv[2];
          const authority = {
            realmId: "legacy-1",
            floorInstanceId: "floor-instance-1",
            depth: 1,
            floorEpoch: 1,
            rulesetVersion: 1,
          };
          const beforeState = {
            authority,
            x: 8,
            y: 4,
            phase: "playing",
            alive: true,
            immobilizedTurns: 0,
            destination: { tile: ".", occupant: "none", trap: false, stairsDown: false },
          };
          let appliedPayloadWritten = false;
          let persistedPayloadWritten = false;
          let preparationRenames = 0;
          let appliedRenamed = false;
          let persistedRenamed = false;
          let cleanupUnlinked = false;
          const journal = new OriginGameplayJournal(directory, {
            writeSync(descriptor, buffer, offset, length) {
              const count = fs.writeSync(descriptor, buffer, offset, length);
              if (Buffer.from(buffer).toString("utf8").includes('"state":"origin_applied"')) {
                appliedPayloadWritten = true;
              }
              if (Buffer.from(buffer).toString("utf8").includes('"state":"persistence_committed"')) {
                persistedPayloadWritten = true;
              }
              return count;
            },
            fsyncSync(descriptor) {
              fs.fsyncSync(descriptor);
              const metadata = fs.fstatSync(descriptor);
              if (scenario === "applied_temp_fsync" && appliedPayloadWritten && metadata.isFile()) {
                process.exit(92);
              }
              if (scenario === "applied_directory_fsync" && appliedRenamed && metadata.isDirectory()) {
                process.exit(94);
              }
              if (scenario === "persisted_temp_fsync" && persistedPayloadWritten && metadata.isFile()) {
                process.exit(98);
              }
              if (scenario === "persisted_directory_fsync" && persistedRenamed && metadata.isDirectory()) {
                process.exit(100);
              }
              if (scenario === "cleanup_directory_fsync" && cleanupUnlinked && metadata.isDirectory()) {
                process.exit(97);
              }
            },
            renameMovementTurnPreparationSync(from, to) {
              fs.renameSync(from, to);
              preparationRenames++;
              if (preparationRenames === 2 && scenario === "applied_rename") process.exit(93);
              if (preparationRenames === 2 && scenario === "applied_directory_fsync") appliedRenamed = true;
              if (preparationRenames === 3 && scenario === "persisted_rename") process.exit(99);
              if (preparationRenames === 3 && scenario === "persisted_directory_fsync") persistedRenamed = true;
            },
            unlinkMovementTurnPreparationSync(file) {
              fs.unlinkSync(file);
              if (scenario === "after_unlink") process.exit(96);
              if (scenario === "cleanup_directory_fsync") cleanupUnlinked = true;
            },
          });
          const input = {
            streamId: movementTurnJournalStreamId(
              "player-1",
              movementJournalRunId("a".repeat(64)),
              authority,
            ),
            operationId: "00000000-0000-4000-8000-000000000018",
            command: { type: "move", dx: 1, dy: 0 },
            beforeState,
            turn: {
              command: { type: "advance_turn", action: "other" },
              beforeState: {
                turns: 0,
                depth: 1,
                hunger: 800,
                maxHunger: 1000,
                hungerState: "normal",
                hp: 20,
                alive: true,
              },
            },
          };
          journal.prepareMovementTurn(input);
          journal.appendMovementTurn(input);
          journal.markMovementTurnApplied(input);
          if (scenario === "after_applied") process.exit(95);
          journal.markMovementTurnPersistenceCommitted(input);
          if (scenario === "after_persisted") process.exit(101);
          journal.completeMovementTurnPreparation(input);
          throw new Error("scenario did not terminate at its crash boundary");
        `,
        directory,
        scenario.name,
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(child.status, `${scenario.name}: ${child.stderr}`).toBe(scenario.status);

      const restarted = new OriginGameplayJournal(directory);
      expect(restarted.hasPendingMovementTurn(), scenario.name).toBe(scenario.pending);
      const turnDirectory = path.join(directory, "movement-turn-v1");
      expect(fs.readdirSync(turnDirectory).filter((name) => name.endsWith(".tmp")), scenario.name)
        .toEqual([]);
      expect(fs.existsSync(path.join(turnDirectory, ".movement-turn-preparation-v1.json")), scenario.name)
        .toBe(scenario.pending);
    }
  }, 30_000);

  it("fails closed on insecure preparation temp state and preserves the survivor", () => {
    if (process.platform === "win32") return;
    const cases = [
      { name: "oversized", create: (file: string) => fs.writeFileSync(file, "x".repeat(513), { mode: 0o600 }) },
      { name: "permissive", create: (file: string) => fs.writeFileSync(file, "prepared\n", { mode: 0o644 }) },
      { name: "symlink", create: (file: string) => fs.symlinkSync(path.join(path.dirname(file), "missing"), file) },
    ];
    for (const candidate of cases) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `grokhack-preparation-temp-${candidate.name}-`));
      directories.push(directory);
      const turnDirectory = path.join(directory, "movement-turn-v1");
      fs.mkdirSync(turnDirectory, { recursive: true, mode: 0o700 });
      const temporary = path.join(turnDirectory, ".movement-turn-preparation-v1.tmp");
      candidate.create(temporary);
      const value = new OriginGameplayJournal(directory);
      expect(value.hasPendingMovementTurn()).toBe(true);
      expect(() => value.prepareMovementTurn(movementTurnInput()))
        .toThrow("movement_turn_preparation_temp_corrupt");
      expect(fs.lstatSync(temporary)).toBeDefined();
    }
  });

  it("fails closed on malformed, oversized, insecure, and symlinked preparation markers", () => {
    const cases = [
      { name: "malformed", payload: "not-json\n", mode: 0o600 },
      { name: "oversized", payload: "x".repeat(513), mode: 0o600 },
      ...(process.platform === "win32"
        ? []
        : [{ name: "permissive", payload: "{}\n", mode: 0o644 }]),
    ];
    for (const candidate of cases) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `grokhack-preparation-${candidate.name}-`));
      directories.push(directory);
      const turnDirectory = path.join(directory, "movement-turn-v1");
      fs.mkdirSync(turnDirectory, { mode: 0o700 });
      fs.writeFileSync(path.join(turnDirectory, ".movement-turn-preparation-v1.json"), candidate.payload, {
        mode: candidate.mode,
      });
      const value = new OriginGameplayJournal(directory);
      expect(value.hasPendingMovementTurn()).toBe(true);
      expect(() => value.prepareMovementTurn(movementTurnInput()))
        .toThrow("movement_turn_preparation_corrupt");
    }

    if (process.platform !== "win32") {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-symlink-"));
      directories.push(directory);
      const turnDirectory = path.join(directory, "movement-turn-v1");
      fs.mkdirSync(turnDirectory, { mode: 0o700 });
      const marker = path.join(turnDirectory, ".movement-turn-preparation-v1.json");
      fs.symlinkSync(path.join(directory, "missing-marker-target"), marker);
      const value = new OriginGameplayJournal(directory);
      expect(value.hasPendingMovementTurn()).toBe(true);
      expect(() => value.prepareMovementTurn(movementTurnInput()))
        .toThrow("movement_turn_preparation_corrupt");
      expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
    }
  });

  it("fails closed at preparation write/fsync boundaries and retries unlink acknowledgement loss", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-preparation-faults-"));
    directories.push(directory);
    let failPreparationWrite = false;
    let failPreparationFsync = false;
    let failDirectoryFsyncAfterCommit = false;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        const payload = Buffer.from(buffer).toString("utf8");
        if (failPreparationWrite && payload.includes('"streamId":"turn_')) {
          failPreparationWrite = false;
          throw new Error("injected preparation write failure");
        }
        return fs.writeSync(descriptor, buffer, offset, length);
      },
      fsyncSync: (descriptor) => {
        const metadata = fs.fstatSync(descriptor);
        if (failPreparationFsync && metadata.isFile() && metadata.size > 0 &&
            metadata.size <= 512) {
          failPreparationFsync = false;
          throw new Error("injected preparation fsync failure");
        }
        fs.fsyncSync(descriptor);
        if (failDirectoryFsyncAfterCommit && metadata.isDirectory()) {
          failDirectoryFsyncAfterCommit = false;
          throw new Error("injected preparation directory fsync acknowledgement loss");
        }
      },
    });
    const prime = movementTurnInput("00000000-0000-4000-8000-00000000000b");
    value.prepareMovementTurn(prime);
    expect(value.appendMovementTurn(prime).status).toBe("appended");
    value.markMovementTurnApplied(prime);
    value.markMovementTurnPersistenceCommitted(prime);
    value.completeMovementTurnPreparation(prime);

    const writeFailure = movementTurnInput("00000000-0000-4000-8000-00000000000c");
    failPreparationWrite = true;
    expect(() => value.prepareMovementTurn(writeFailure)).toThrow("injected preparation write failure");
    expect(value.hasPendingMovementTurn()).toBe(false);

    const fsyncFailure = movementTurnInput("00000000-0000-4000-8000-00000000000d");
    failPreparationFsync = true;
    expect(() => value.prepareMovementTurn(fsyncFailure)).toThrow("injected preparation fsync failure");
    expect(value.hasPendingMovementTurn()).toBe(false);

    const prepareAckLoss = movementTurnInput("00000000-0000-4000-8000-00000000000e");
    failDirectoryFsyncAfterCommit = true;
    expect(() => value.prepareMovementTurn(prepareAckLoss))
      .toThrow("injected preparation directory fsync acknowledgement loss");
    expect(value.hasPendingMovementTurn()).toBe(true);
    value.prepareMovementTurn(prepareAckLoss);
    expect(value.appendMovementTurn(prepareAckLoss).status).toBe("appended");
    value.markMovementTurnApplied(prepareAckLoss);
    value.markMovementTurnPersistenceCommitted(prepareAckLoss);

    failDirectoryFsyncAfterCommit = true;
    expect(() => value.completeMovementTurnPreparation(prepareAckLoss))
      .toThrow("injected preparation directory fsync acknowledgement loss");
    expect(value.hasPendingMovementTurn()).toBe(false);
    value.completeMovementTurnPreparation(prepareAckLoss);
  });

  it("keeps the prepared fence when the origin-applied phase write fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-applied-write-"));
    directories.push(directory);
    let failAppliedWrite = false;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        const payload = Buffer.from(buffer).toString("utf8");
        if (failAppliedWrite && payload.includes('"state":"origin_applied"')) {
          failAppliedWrite = false;
          throw new Error("injected origin-applied marker write failure");
        }
        return fs.writeSync(descriptor, buffer, offset, length);
      },
    });
    const input = movementTurnInput("00000000-0000-4000-8000-000000000017");
    value.prepareMovementTurn(input);
    expect(value.appendMovementTurn(input).status).toBe("appended");

    failAppliedWrite = true;
    expect(() => value.markMovementTurnApplied(input))
      .toThrow("injected origin-applied marker write failure");
    expect(value.hasPendingMovementTurn()).toBe(true);
    expect(() => value.completeMovementTurnPreparation(input))
      .toThrow("movement_turn_origin_not_applied");

    value.markMovementTurnApplied(input);
    value.markMovementTurnPersistenceCommitted(input);
    value.completeMovementTurnPreparation(input);
    expect(new OriginGameplayJournal(directory).hasPendingMovementTurn()).toBe(false);
  });

  it("fails closed across preparation rename and unlink acknowledgement boundaries", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-preparation-rename-unlink-"));
    directories.push(directory);
    let renameFailure: "before" | "after" | null = null;
    let unlinkFailure: "before" | "after" | null = null;
    const value = new OriginGameplayJournal(directory, {
      renameMovementTurnPreparationSync: (from, to) => {
        if (renameFailure === "before") {
          renameFailure = null;
          throw new Error("injected preparation rename failure");
        }
        fs.renameSync(from, to);
        if (renameFailure === "after") {
          renameFailure = null;
          throw new Error("injected preparation rename acknowledgement loss");
        }
      },
      unlinkMovementTurnPreparationSync: (file) => {
        if (unlinkFailure === "before") {
          unlinkFailure = null;
          throw new Error("injected preparation unlink failure");
        }
        fs.unlinkSync(file);
        if (unlinkFailure === "after") {
          unlinkFailure = null;
          throw new Error("injected preparation unlink acknowledgement loss");
        }
      },
    });
    const first = movementTurnInput("00000000-0000-4000-8000-000000000011");

    renameFailure = "before";
    expect(() => value.prepareMovementTurn(first)).toThrow("injected preparation rename failure");
    expect(value.hasPendingMovementTurn()).toBe(false);
    expect(fs.readdirSync(path.join(directory, "movement-turn-v1"))).toEqual([]);

    renameFailure = "after";
    expect(() => value.prepareMovementTurn(first))
      .toThrow("injected preparation rename acknowledgement loss");
    expect(value.hasPendingMovementTurn()).toBe(true);
    expect(() => value.prepareMovementTurn(first)).not.toThrow();
    expect(value.appendMovementTurn(first).status).toBe("appended");
    value.markMovementTurnApplied(first);
    value.markMovementTurnPersistenceCommitted(first);

    unlinkFailure = "before";
    expect(() => value.completeMovementTurnPreparation(first))
      .toThrow("injected preparation unlink failure");
    // The persistence-committed phase proves every bound state write
    // acknowledged, so a status/restart path may safely finish cleanup.
    expect(value.hasPendingMovementTurn()).toBe(false);
    value.completeMovementTurnPreparation(first);
    expect(value.hasPendingMovementTurn()).toBe(false);

    const second = {
      ...movementTurnInput("00000000-0000-4000-8000-000000000012"),
      beforeState: movementBefore({ x: 9 }),
      turn: {
        command: { type: "advance_turn", action: "other" } as const,
        beforeState: initial({ turns: 1, hunger: 798 }),
      },
    };
    value.prepareMovementTurn(second);
    expect(value.appendMovementTurn(second).status).toBe("appended");
    value.markMovementTurnApplied(second);
    value.markMovementTurnPersistenceCommitted(second);
    unlinkFailure = "after";
    expect(() => value.completeMovementTurnPreparation(second))
      .toThrow("injected preparation unlink acknowledgement loss");
    expect(value.hasPendingMovementTurn()).toBe(false);
    expect(() => value.completeMovementTurnPreparation(second)).not.toThrow();
  });

  it("segments movement-turn evidence without per-entry file amplification", () => {
    const { directory, value } = journal();
    const streamId = movementTurnJournalStreamId("bounded-player", movementRunId, movementAuthority);
    const blocked = movementBefore({
      destination: { tile: "#", occupant: "none", trap: false, stairsDown: false },
    });
    for (let index = 1; index <= 65; index++) {
      expect(value.appendMovementTurn({
        streamId,
        operationId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        command: { type: "move", dx: 1, dy: 0 },
        beforeState: blocked,
        turn: null,
      }).status).toBe("appended");
    }
    const movementTurnDirectory = path.join(directory, "movement-turn-v1");
    const files = fs.readdirSync(movementTurnDirectory);
    expect(files.filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
    expect(files.filter((name) => name.endsWith(".commits"))).toHaveLength(2);
    expect(files).toHaveLength(4);
    expect(files.reduce((bytes, name) => bytes + fs.statSync(path.join(movementTurnDirectory, name)).size, 0))
      .toBeLessThan(2 * 1024 * 1024);
    expect(files.every((name) => (fs.statSync(path.join(movementTurnDirectory, name)).mode & 0o077) === 0))
      .toBe(true);
    expect(value.readMovementTurnsAfter(streamId, 0, 64)).toHaveLength(64);
    expect(value.readMovementTurnsAfter(streamId, 64, 64)).toHaveLength(1);
  });

  it("repairs an uncommitted movement-turn data write without exposing either nested entry", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-commit-"));
    directories.push(directory);
    let failCommit = false;
    const value = new OriginGameplayJournal(directory, {
      writeSync: (descriptor, buffer, offset, length) => {
        if (failCommit && buffer.byteLength === 1) throw new Error("injected movement-turn commit failure");
        return fs.writeSync(descriptor, buffer, offset, length);
      },
    });
    value.appendTransition({
      streamId: "movement-turn-prime",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const input = movementTurnInput();
    failCommit = true;
    expect(() => value.appendMovementTurn(input)).toThrow("injected movement-turn commit failure");
    expect(new OriginGameplayJournal(directory).readMovementTurnsAfter(input.streamId, 0, 64)).toEqual([]);
    failCommit = false;
    expect(value.appendMovementTurn(input).status).toBe("appended");
    expect(value.readMovementTurnsAfter(input.streamId, 0, 64)).toHaveLength(1);
  });

  it("recovers movement-turn data-fsync failure and commit-fsync acknowledgement loss", () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-data-fsync-"));
    directories.push(dataDirectory);
    let failDataFsync = false;
    const dataJournal = new OriginGameplayJournal(dataDirectory, {
      fsyncSync: (descriptor) => {
        const metadata = fs.fstatSync(descriptor);
        if (failDataFsync && metadata.isFile() && metadata.size > 128) {
          failDataFsync = false;
          throw new Error("injected movement-turn data fsync failure");
        }
        fs.fsyncSync(descriptor);
      },
    });
    dataJournal.appendTransition({
      streamId: "movement-turn-data-prime",
      command: { type: "advance_turn", action: "wait" },
      beforeState: initial(),
    });
    const dataInput = movementTurnInput();
    failDataFsync = true;
    expect(() => dataJournal.appendMovementTurn(dataInput)).toThrow("injected movement-turn data fsync failure");
    expect(new OriginGameplayJournal(dataDirectory).readMovementTurnsAfter(dataInput.streamId, 0, 64)).toEqual([]);
    expect(dataJournal.appendMovementTurn(dataInput).status).toBe("appended");

    const commitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-commit-fsync-"));
    directories.push(commitDirectory);
    let failCommitFsync = false;
    const commitJournal = new OriginGameplayJournal(commitDirectory, {
      maxMovementEntries: 1,
      maxGameplayEntries: 1,
      fsyncSync: (descriptor) => {
        const metadata = fs.fstatSync(descriptor);
        fs.fsyncSync(descriptor);
        if (failCommitFsync && metadata.isFile() && metadata.size === 1) {
          failCommitFsync = false;
          throw new Error("injected movement-turn commit fsync acknowledgement loss");
        }
      },
    });
    const commitInput = movementTurnInput("00000000-0000-4000-8000-000000000003");
    failCommitFsync = true;
    expect(() => commitJournal.appendMovementTurn(commitInput))
      .toThrow("injected movement-turn commit fsync acknowledgement loss");
    expect(new OriginGameplayJournal(commitDirectory).readMovementTurnsAfter(commitInput.streamId, 0, 64))
      .toHaveLength(1);
    expect(commitJournal.appendMovementTurn(commitInput).status).toBe("duplicate");
  });

  it("recovers atomically when the writer process crashes around the movement-turn commit barrier", () => {
    const crashWriter = `
      import fs from "node:fs";
      import { OriginGameplayJournal } from "./server/origin-journal.ts";
      const crashPoint = process.env.CRASH_POINT;
      const value = new OriginGameplayJournal(process.env.JOURNAL_DIR, {
        writeSync: (descriptor, buffer, offset, length) => {
          if (crashPoint === "before_commit_write" && buffer.byteLength === 1) process.exit(81);
          return fs.writeSync(descriptor, buffer, offset, length);
        },
        fsyncSync: (descriptor) => {
          fs.fsyncSync(descriptor);
          if (crashPoint === "after_commit_fsync" && fs.fstatSync(descriptor).isFile() &&
              fs.fstatSync(descriptor).size === 1) process.exit(82);
        },
      });
      value.appendMovementTurn(JSON.parse(process.env.MOVEMENT_TURN_INPUT));
    `;
    const runCrash = (directory: string, crashPoint: string, input: ReturnType<typeof movementTurnInput>) =>
      spawnSync(process.execPath, ["--import", "tsx", "-e", crashWriter], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CRASH_POINT: crashPoint,
          JOURNAL_DIR: directory,
          MOVEMENT_TURN_INPUT: JSON.stringify(input),
        },
        encoding: "utf8",
      });

    const preCommitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-precommit-crash-"));
    directories.push(preCommitDirectory);
    const preCommitInput = movementTurnInput("00000000-0000-4000-8000-000000000006");
    const preCommitCrash = runCrash(preCommitDirectory, "before_commit_write", preCommitInput);
    expect({ status: preCommitCrash.status, stderr: preCommitCrash.stderr }).toEqual({ status: 81, stderr: "" });
    const preCommitRestart = new OriginGameplayJournal(preCommitDirectory);
    expect(preCommitRestart.appendMovementTurn(preCommitInput).status).toBe("appended");
    expect(preCommitRestart.readMovementTurnsAfter(preCommitInput.streamId, 0, 64))
      .toEqual([expect.objectContaining({ movement: expect.any(Object), turn: expect.any(Object) })]);

    const postCommitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-postcommit-crash-"));
    directories.push(postCommitDirectory);
    const postCommitInput = movementTurnInput("00000000-0000-4000-8000-000000000007");
    const postCommitCrash = runCrash(postCommitDirectory, "after_commit_fsync", postCommitInput);
    expect({ status: postCommitCrash.status, stderr: postCommitCrash.stderr }).toEqual({ status: 82, stderr: "" });
    const postCommitRestart = new OriginGameplayJournal(postCommitDirectory);
    expect(postCommitRestart.appendMovementTurn(postCommitInput).status).toBe("duplicate");
    expect(postCommitRestart.readMovementTurnsAfter(postCommitInput.streamId, 0, 64))
      .toEqual([expect.objectContaining({ movement: expect.any(Object), turn: expect.any(Object) })]);
  });

  it("keeps the preparation poison across crashes before mutation and after envelope commit", () => {
    const crashWriter = `
      import { OriginGameplayJournal } from "./server/origin-journal.ts";
      const value = new OriginGameplayJournal(process.env.JOURNAL_DIR);
      const input = JSON.parse(process.env.MOVEMENT_TURN_INPUT);
      value.prepareMovementTurn(input);
      if (process.env.CRASH_POINT === "after_prepare") process.exit(83);
      value.appendMovementTurn(input);
      if (process.env.CRASH_POINT === "after_envelope_commit") process.exit(84);
    `;
    const runCrash = (directory: string, crashPoint: string, input: ReturnType<typeof movementTurnInput>) =>
      spawnSync(process.execPath, ["--import", "tsx", "-e", crashWriter], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CRASH_POINT: crashPoint,
          JOURNAL_DIR: directory,
          MOVEMENT_TURN_INPUT: JSON.stringify(input),
        },
        encoding: "utf8",
      });

    const preMutationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-prepared-crash-"));
    directories.push(preMutationDirectory);
    const preMutationInput = movementTurnInput("00000000-0000-4000-8000-00000000000f");
    const preMutationCrash = runCrash(preMutationDirectory, "after_prepare", preMutationInput);
    expect({ status: preMutationCrash.status, stderr: preMutationCrash.stderr })
      .toEqual({ status: 83, stderr: "" });
    const preMutationRestart = new OriginGameplayJournal(preMutationDirectory);
    expect(preMutationRestart.hasPendingMovementTurn()).toBe(true);
    expect(preMutationRestart.readMovementTurnsAfter(preMutationInput.streamId, 0, 64)).toEqual([]);

    const postCommitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "grokhack-movement-turn-prepared-postcommit-"));
    directories.push(postCommitDirectory);
    const postCommitInput = movementTurnInput("00000000-0000-4000-8000-000000000010");
    const postCommitCrash = runCrash(postCommitDirectory, "after_envelope_commit", postCommitInput);
    expect({ status: postCommitCrash.status, stderr: postCommitCrash.stderr })
      .toEqual({ status: 84, stderr: "" });
    const postCommitRestart = new OriginGameplayJournal(postCommitDirectory);
    expect(postCommitRestart.hasPendingMovementTurn()).toBe(true);
    expect(postCommitRestart.readMovementTurnsAfter(postCommitInput.streamId, 0, 64)).toHaveLength(1);
  });

  it("rejects no-turn carried-state jumps while preserving the last turn hash across no-turn envelopes", () => {
    const { directory, value } = journal();
    const streamId = movementTurnJournalStreamId("blocked-player", movementRunId, movementAuthority);
    const first = value.appendMovementTurn({
      ...movementTurnInput("00000000-0000-4000-8000-000000000004"),
      streamId,
    });
    if (first.status === "dropped_capacity") throw new Error("unexpected movement-turn capacity");
    const blocked = movementBefore({
      x: 9,
      destination: { tile: "#", occupant: "none", trap: false, stairsDown: false },
    });
    expect(value.appendMovementTurn({
      streamId,
      operationId: "00000000-0000-4000-8000-000000000005",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: blocked,
      turn: null,
    }).status).toBe("appended");
    expect(value.appendMovementTurn({
      ...movementTurnInput("00000000-0000-4000-8000-000000000006"),
      streamId,
      beforeState: movementBefore({ x: 9 }),
      turn: {
        command: { type: "advance_turn", action: "other" },
        beforeState: initial({ turns: 1, hunger: 798 }),
      },
    }).status).toBe("appended");
    const restarted = new OriginGameplayJournal(directory).readMovementTurnsAfter(streamId, 0, 64);
    expect(restarted).toHaveLength(3);
    expect(restarted[1]?.turn).toBeNull();
    expect(restarted[2]?.turn?.previousEntryHash).toBe(first.envelope.turn?.entryHash);

    const jumpStreamId = movementTurnJournalStreamId("jump-player", movementRunId, movementAuthority);
    expect(() => value.appendMovementTurn({
      streamId: jumpStreamId,
      operationId: "00000000-0000-4000-8000-000000000007",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: blocked,
      turn: null,
    })).not.toThrow();
    expect(() => value.appendMovementTurn({
      streamId: jumpStreamId,
      operationId: "00000000-0000-4000-8000-000000000008",
      command: { type: "move", dx: 1, dy: 0 },
      beforeState: { ...blocked, x: 40 },
      turn: null,
    })).toThrow("movement_turn_state_continuity_mismatch");
    expect(value.readMovementTurnsAfter(jumpStreamId, 0, 64)).toHaveLength(1);
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
        "--import",
        "tsx",
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
      const appendWithReusedPid = () => new OriginGameplayJournal(reusedPidDirectory).appendTransition({
        streamId: "reused-pid-owner",
        command: { type: "advance_turn", action: "wait" } as const,
        beforeState: initial(),
      });
      const startIdentityProbe = spawnSync(
        "ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" },
      );
      const startIdentityAvailable = process.platform === "linux" ||
        (typeof startIdentityProbe.stdout === "string" && startIdentityProbe.stdout.trim().length > 0);
      if (startIdentityAvailable) expect(appendWithReusedPid().status).toBe("appended");
      else expect(appendWithReusedPid).toThrow("journal_writer_already_active");
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
