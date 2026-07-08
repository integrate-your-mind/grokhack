import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = path.join(__dirname, "..", "data", "audit");

export type AuditEventType =
  | "session_connect"
  | "session_disconnect"
  | "player_join"
  | "player_input"
  | "combat"
  | "player_death"
  | "player_victory"
  | "client_error"
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

function auditFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `${day}.jsonl`);
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

export function getRecentEvents(limit = 100): AuditEvent[] {
  ensureDir();
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