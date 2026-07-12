import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { dataPath } from "./data-paths.js";
import {
  createShadowJournalEntry,
  validateShadowJournalEntry,
  type GameplayJournalInput,
  type MovementJournalInput,
  type ShadowJournalEntry,
  type ShadowJournalInput,
} from "../src/shadow-journal.js";

export type JournalAppendResult =
  | { status: "appended"; entry: ShadowJournalEntry }
  | { status: "duplicate"; entry: ShadowJournalEntry };

interface StreamHead {
  cursor: number;
  entryHash: string;
  terminal: boolean;
}

const SEGMENT_ENTRIES = 64;

export function movementJournalStreamId(playerId: string, depth: number): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(playerId) || !Number.isSafeInteger(depth) || depth < 1 || depth > 64) {
    throw new Error("invalid_movement_stream");
  }
  return `${playerId}_movement_d${depth}`;
}

export type OriginTransitionInput =
  | Omit<GameplayJournalInput, "cursor" | "previousEntryHash">
  | Omit<MovementJournalInput, "cursor" | "previousEntryHash">;

export interface OriginGameplayJournalOptions {
  /** Fault-injection seam used to prove pre/post-rename fsync recovery. */
  fsyncSync?: (descriptor: number) => void;
}

export class OriginGameplayJournal {
  private readonly directory: string;
  private readonly heads = new Map<string, StreamHead>();
  private readonly fsyncSync: (descriptor: number) => void;

  constructor(directory = dataPath("shadow-journal"), options: OriginGameplayJournalOptions = {}) {
    this.directory = directory;
    this.fsyncSync = options.fsyncSync ?? fs.fsyncSync;
  }

  appendTransition(input: OriginTransitionInput): JournalAppendResult {
    const head = this.head(input.streamId);
    if (head.cursor > 0) {
      const last = this.entryAt(input.streamId, head.cursor);
      const retry = createShadowJournalEntry({
        ...input,
        cursor: head.cursor,
        previousEntryHash: last?.previousEntryHash ?? null,
      } as ShadowJournalInput);
      if (last?.entryHash === retry.entryHash) return { status: "duplicate", entry: last };
    }
    return this.append(createShadowJournalEntry({
      ...input,
      cursor: head.cursor + 1,
      previousEntryHash: head.cursor === 0 ? null : head.entryHash,
    } as ShadowJournalInput));
  }

  append(entry: ShadowJournalEntry): JournalAppendResult {
    const validated = validateShadowJournalEntry(entry);
    const head = this.head(validated.streamId);
    if (head.terminal) throw new Error("journal_terminal_stream");
    if (validated.cursor <= head.cursor) {
      const existing = this.entryAt(validated.streamId, validated.cursor);
      if (existing?.entryHash === validated.entryHash) return { status: "duplicate", entry: existing };
      throw new Error("journal_cursor_conflict");
    }
    if (validated.cursor !== head.cursor + 1) throw new Error("journal_cursor_gap");
    if (validated.previousEntryHash !== (head.cursor === 0 ? null : head.entryHash)) throw new Error("journal_hash_chain_mismatch");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.fileFor(validated.streamId, this.segmentFor(validated.cursor));
    const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(descriptor, `${previous}${JSON.stringify(validated)}\n`);
      this.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      const directoryDescriptor = fs.openSync(this.directory, fs.constants.O_RDONLY);
      try {
        this.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
      // Rename may have committed even when the directory fsync response was
      // lost. Re-read canonical state on retry instead of trusting stale memory.
      this.heads.delete(validated.streamId);
      throw error;
    }
    this.heads.set(validated.streamId, { cursor: validated.cursor, entryHash: validated.entryHash, terminal: validated.terminal });
    return { status: "appended", entry: validated };
  }

  readAfter(streamId: string, cursor: number, limit: number): ShadowJournalEntry[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("invalid cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new RangeError("invalid limit");
    this.assertStreamId(streamId);
    const head = this.head(streamId);
    if (cursor >= head.cursor) return [];
    const result: ShadowJournalEntry[] = [];
    let segment = this.segmentFor(cursor + 1);
    while (result.length < limit) {
      const entries = this.readSegment(streamId, segment);
      for (const entry of entries) {
        if (entry.cursor > cursor) result.push(entry);
        if (result.length === limit) return result;
      }
      if (entries.length < SEGMENT_ENTRIES) break;
      segment++;
    }
    const expected = Math.min(limit, head.cursor - cursor);
    if (result.length !== expected) throw new Error("journal_missing_segment");
    return result;
  }

  private head(streamId: string): StreamHead {
    this.assertStreamId(streamId);
    const cached = this.heads.get(streamId);
    if (cached) return cached;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const prefix = `${streamId}.`;
    const segments = fs.readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && /^.+\.[0-9]{8}\.jsonl$/u.test(name))
      .map((name) => Number(name.slice(prefix.length, prefix.length + 8)))
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b);
    if (!segments.length) {
      const empty = { cursor: 0, entryHash: "", terminal: false };
      this.heads.set(streamId, empty);
      return empty;
    }
    const latestSegment = segments.at(-1)!;
    if (segments.some((value, index) => value !== index)) throw new Error("journal_missing_segment");
    const entries = this.readSegment(streamId, latestSegment);
    if (!entries.length) throw new Error("journal_empty_segment");
    const firstExpected = latestSegment * SEGMENT_ENTRIES + 1;
    if (entries[0]!.cursor !== firstExpected) throw new Error("journal_corrupt_sequence");
    for (let index = 1; index < entries.length; index++) {
      if (entries[index]!.cursor !== entries[index - 1]!.cursor + 1 ||
          entries[index]!.previousEntryHash !== entries[index - 1]!.entryHash ||
          entries[index - 1]!.terminal) throw new Error("journal_corrupt_sequence");
    }
    if (latestSegment > 0) {
      const previous = this.readSegment(streamId, latestSegment - 1).at(-1);
      if (!previous || entries[0]!.previousEntryHash !== previous.entryHash || previous.terminal) throw new Error("journal_hash_chain_mismatch");
    } else if (entries[0]!.previousEntryHash !== null) {
      throw new Error("journal_hash_chain_mismatch");
    }
    const last = entries.at(-1)!;
    const cursor = last.cursor;
    const entryHash = last.entryHash;
    const terminal = last.terminal;
    const head = { cursor, entryHash, terminal };
    this.heads.set(streamId, head);
    return head;
  }

  private entryAt(streamId: string, cursor: number): ShadowJournalEntry | undefined {
    return this.readSegment(streamId, this.segmentFor(cursor)).find((entry) => entry.cursor === cursor);
  }

  private readSegment(streamId: string, segment: number): ShadowJournalEntry[] {
    const file = this.fileFor(streamId, segment);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.map((line) => validateShadowJournalEntry(JSON.parse(line) as unknown));
  }

  private fileFor(streamId: string, segment: number): string {
    this.assertStreamId(streamId);
    if (!Number.isSafeInteger(segment) || segment < 0) throw new Error("invalid_segment");
    return path.join(this.directory, `${streamId}.${String(segment).padStart(8, "0")}.jsonl`);
  }

  private segmentFor(cursor: number): number {
    return Math.floor((Math.max(1, cursor) - 1) / SEGMENT_ENTRIES);
  }

  private assertStreamId(streamId: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(streamId)) throw new Error("invalid_stream_id");
  }
}
