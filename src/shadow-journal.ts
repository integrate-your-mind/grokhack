import {
  gameplayStateHash,
  reduceGameplay,
  type GameplayCommand,
  type GameplayState,
} from "./gameplay-reducer.js";

export const SHADOW_JOURNAL_VERSION = 1 as const;
export const MAX_SHADOW_BATCH_ENTRIES = 64;
export const MAX_SHADOW_BATCH_BYTES = 256 * 1024;

export interface ShadowRoute {
  realmId: string;
  floorInstanceId: string;
  depth: number;
  floorEpoch: number;
}

export interface ShadowJournalEntry {
  v: typeof SHADOW_JOURNAL_VERSION;
  streamId: string;
  cursor: number;
  command: GameplayCommand;
  beforeState: GameplayState;
  beforeStateHash: string;
  afterStateHash: string;
  terminal: boolean;
  previousEntryHash: string | null;
  entryHash: string;
}

export interface ShadowCatchupBatch {
  v: typeof SHADOW_JOURNAL_VERSION;
  route: ShadowRoute;
  entries: readonly ShadowJournalEntry[];
}

function fnv64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function shadowEntryHash(entry: Omit<ShadowJournalEntry, "entryHash">): string {
  return fnv64([
    entry.v,
    entry.streamId,
    entry.cursor,
    entry.command.type,
    entry.command.action,
    entry.beforeStateHash,
    entry.afterStateHash,
    entry.terminal ? 1 : 0,
    entry.previousEntryHash ?? "genesis",
  ].join("|"));
}

export function createShadowJournalEntry(input: {
  streamId: string;
  cursor: number;
  command: GameplayCommand;
  beforeState: GameplayState;
  previousEntryHash?: string | null;
}): ShadowJournalEntry {
  const transition = reduceGameplay(input.beforeState, input.command);
  const unsigned = {
    v: SHADOW_JOURNAL_VERSION,
    streamId: input.streamId,
    cursor: input.cursor,
    command: input.command,
    beforeState: { ...input.beforeState },
    beforeStateHash: gameplayStateHash(input.beforeState),
    afterStateHash: gameplayStateHash(transition.state),
    terminal: !transition.state.alive,
    previousEntryHash: input.previousEntryHash ?? null,
  } satisfies Omit<ShadowJournalEntry, "entryHash">;
  return { ...unsigned, entryHash: shadowEntryHash(unsigned) };
}

export function validateShadowJournalEntry(value: unknown): ShadowJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_entry");
  const entry = value as Partial<ShadowJournalEntry>;
  if (entry.v !== SHADOW_JOURNAL_VERSION ||
      typeof entry.streamId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(entry.streamId) ||
      !Number.isSafeInteger(entry.cursor) || Number(entry.cursor) < 1 ||
      !entry.command || entry.command.type !== "advance_turn" ||
      (entry.command.action !== "wait" && entry.command.action !== "other") ||
      !entry.beforeState || typeof entry.beforeState !== "object" ||
      typeof entry.beforeStateHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.beforeStateHash) ||
      typeof entry.afterStateHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.afterStateHash) ||
      typeof entry.terminal !== "boolean" ||
      (entry.previousEntryHash !== null && (typeof entry.previousEntryHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.previousEntryHash))) ||
      typeof entry.entryHash !== "string" || !/^[0-9a-f]{16}$/u.test(entry.entryHash)) {
    throw new Error("invalid_entry");
  }
  const state = entry.beforeState as Partial<GameplayState>;
  const hungerStates = new Set(["satiated", "normal", "hungry", "weak", "fainting", "starving"]);
  if (!Number.isSafeInteger(state.turns) || Number(state.turns) < 0 ||
      !Number.isSafeInteger(state.depth) || Number(state.depth) < 1 || Number(state.depth) > 64 ||
      !Number.isSafeInteger(state.hunger) || Number(state.hunger) < 0 ||
      !Number.isSafeInteger(state.maxHunger) || Number(state.maxHunger) < 1 ||
      typeof state.hungerState !== "string" || !hungerStates.has(state.hungerState) ||
      !Number.isSafeInteger(state.hp) || typeof state.alive !== "boolean") {
    throw new Error("invalid_gameplay_state");
  }
  if (entry.beforeStateHash !== gameplayStateHash(entry.beforeState)) throw new Error("before_state_hash_mismatch");
  const unsigned = { ...entry } as Partial<ShadowJournalEntry>;
  delete unsigned.entryHash;
  if (entry.entryHash !== shadowEntryHash(unsigned as Omit<ShadowJournalEntry, "entryHash">)) {
    throw new Error("entry_hash_mismatch");
  }
  // The declared after hash is intentionally not recomputed here. The isolated
  // edge replay must do that independently so divergence is visible evidence.
  return entry as ShadowJournalEntry;
}

export function validateShadowRoute(value: unknown): ShadowRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_route");
  const route = value as Partial<ShadowRoute>;
  if (typeof route.realmId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(route.realmId) ||
      typeof route.floorInstanceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(route.floorInstanceId) ||
      !Number.isSafeInteger(route.depth) || Number(route.depth) < 1 || Number(route.depth) > 64 ||
      !Number.isSafeInteger(route.floorEpoch) || Number(route.floorEpoch) < 1) {
    throw new Error("invalid_route");
  }
  return route as ShadowRoute;
}
