import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPath } from "./data-paths.js";

const AUDIT_DIR = dataPath("audit");

export type AuditEventType =
  | "session_connect"
  | "session_disconnect"
  | "session_summary"
  | "player_join"
  | "player_reconnect"
  | "player_join_failed"
  | "player_input"
  | "player_chat"
  | "player_social"
  | "floor_descend"
  | "combat"
  | "player_death"
  | "player_victory"
  | "client_error"
  | "client_telemetry"
  | "server_error"
  | "ws_parse_error";

export interface AuditEvent {
  id: string;
  at: string;
  type: AuditEventType;
  sessionId: string;
  playerId?: string;
  playerName?: string;
  transport?: string;
  detail?: Record<string, unknown>;
}

export interface AuditStats {
  windowDays: number;
  totalEvents: number;
  sessions: number;
  joins: number;
  deaths: number;
  victories: number;
  clientErrors: number;
  chatMessages: number;
  socialActions: number;
  avgSessionSec: number;
  topErrors: { message: string; count: number }[];
  deathsByDepth: Record<string, number>;
  inputsByKey: Record<string, number>;
}

function auditFile(day?: string): string {
  const d = day ?? new Date().toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `${d}.jsonl`);
}

function ensureDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

export function logEvent(
  type: AuditEventType,
  sessionId: string,
  fields: Omit<AuditEvent, "id" | "at" | "type" | "sessionId"> = {}
): void {
  try {
    ensureDir();
    const event: AuditEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      sessionId,
      ...fields,
    };
    fs.appendFileSync(auditFile(), JSON.stringify(event) + "\n");
  } catch (err) {
    console.error("[audit] write failed:", err);
  }
}

function listAuditFiles(days: number): string[] {
  ensureDir();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days + 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return fs
    .readdirSync(AUDIT_DIR)
    .filter((f) => f.endsWith(".jsonl") && f.slice(0, 10) >= cutoffStr)
    .sort();
}

function readEventsFromFiles(files: string[], max = 50_000): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(AUDIT_DIR, file), "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      if (events.length >= max) return events;
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return events;
}

export function getRecentEvents(limit = 100): AuditEvent[] {
  const files = fs.readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const events: AuditEvent[] = [];
  for (const file of files) {
    if (events.length >= limit) break;
    const lines = fs.readFileSync(path.join(AUDIT_DIR, file), "utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      try {
        events.push(JSON.parse(lines[i]) as AuditEvent);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return events;
}

export function getSessionTrace(sessionId: string): AuditEvent[] {
  ensureDir();
  const files = fs.readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const events: AuditEvent[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(AUDIT_DIR, file), "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (e.sessionId === sessionId) events.push(e);
      } catch {
        /* skip */
      }
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

export function ingestClientTelemetry(
  sessionId: string,
  events: { event: string; detail?: Record<string, unknown>; at?: string }[]
): number {
  let n = 0;
  for (const ev of events.slice(0, 50)) {
    logEvent("client_telemetry", sessionId, {
      detail: {
        event: String(ev.event || "unknown").slice(0, 64),
        clientAt: ev.at,
        ...(ev.detail || {}),
      },
    });
    n++;
  }
  return n;
}

export function getAuditStats(days = 7): AuditStats {
  ensureDir();
  const files = listAuditFiles(days);
  const events = readEventsFromFiles(files);

  const sessionIds = new Set<string>();
  const errorCounts = new Map<string, number>();
  const deathsByDepth: Record<string, number> = {};
  const inputsByKey: Record<string, number> = {};
  let joins = 0;
  let deaths = 0;
  let victories = 0;
  let clientErrors = 0;
  let chatMessages = 0;
  let socialActions = 0;
  const sessionDurations: number[] = [];

  for (const e of events) {
    sessionIds.add(e.sessionId);
    switch (e.type) {
      case "player_join":
        joins++;
        break;
      case "player_death":
        deaths++;
        if (e.detail?.depth != null) {
          const d = String(e.detail.depth);
          deathsByDepth[d] = (deathsByDepth[d] || 0) + 1;
        }
        break;
      case "player_victory":
        victories++;
        break;
      case "client_error": {
        clientErrors++;
        const msg = String(e.detail?.message || "unknown").slice(0, 120);
        errorCounts.set(msg, (errorCounts.get(msg) || 0) + 1);
        break;
      }
      case "player_chat":
        chatMessages++;
        break;
      case "player_social":
        socialActions++;
        break;
      case "player_input": {
        const key = String(e.detail?.key || e.detail?.cmd || "?");
        inputsByKey[key] = (inputsByKey[key] || 0) + 1;
        break;
      }
      case "session_summary":
        if (typeof e.detail?.durationSec === "number") sessionDurations.push(e.detail.durationSec);
        break;
      default:
        break;
    }
  }

  const topErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([message, count]) => ({ message, count }));

  const avgSessionSec =
    sessionDurations.length > 0
      ? Math.round(sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length)
      : 0;

  return {
    windowDays: days,
    totalEvents: events.length,
    sessions: sessionIds.size,
    joins,
    deaths,
    victories,
    clientErrors,
    chatMessages,
    socialActions,
    avgSessionSec,
    topErrors,
    deathsByDepth,
    inputsByKey,
  };
}
