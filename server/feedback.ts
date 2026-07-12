import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { clientIp, rateLimitScoped, sanitizeChatText } from "./security.js";
import { logEvent } from "./audit.js";
import { dataPath } from "./data-paths.js";

const FEEDBACK_DIR = dataPath("feedback");

export const FEEDBACK_CATEGORIES = ["bug", "gameplay", "ui", "feature", "security", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export interface FeedbackEntry {
  id: string;
  at: string;
  category: FeedbackCategory;
  message: string;
  contact?: string;
  playerName?: string;
  sessionId?: string;
  page?: string;
  ipHash: string;
  userAgent?: string;
}

const HOURLY_LIMIT = parseInt(process.env.FEEDBACK_RATE_HOURLY || "5", 10);
const DAILY_LIMIT = parseInt(process.env.FEEDBACK_RATE_DAILY || "20", 10);
const MIN_MESSAGE_LEN = 10;
const MAX_MESSAGE_LEN = 2000;

function ensureDir(): void {
  if (!fs.existsSync(FEEDBACK_DIR)) fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
}

function feedbackFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(FEEDBACK_DIR, `${day}.jsonl`);
}

function hashIp(ip: string): string {
  return createHash("sha256").update(ip + (process.env.FEEDBACK_IP_SALT || "grokhack")).digest("hex").slice(0, 16);
}

function messageHash(text: string): string {
  return createHash("sha256").update(text.toLowerCase().trim()).digest("hex").slice(0, 16);
}

function readRecent(limit = 500): FeedbackEntry[] {
  ensureDir();
  const files = fs.readdirSync(FEEDBACK_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const entries: FeedbackEntry[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(FEEDBACK_DIR, file), "utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        entries.push(JSON.parse(lines[i]) as FeedbackEntry);
      } catch {
        /* skip */
      }
    }
  }
  return entries;
}

function isDuplicate(ip: string, text: string, withinMs = 86_400_000): boolean {
  const ipH = hashIp(ip);
  const mh = messageHash(text);
  const cutoff = Date.now() - withinMs;
  for (const e of readRecent(200)) {
    if (e.ipHash !== ipH) continue;
    if (new Date(e.at).getTime() < cutoff) continue;
    if (messageHash(e.message) === mh) return true;
  }
  return false;
}

function sanitizeContact(raw: string): string | undefined {
  const c = raw.trim().slice(0, 120);
  if (!c) return undefined;
  if (c.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return undefined;
  return c.replace(/[\x00-\x1f\x7f]/g, "");
}

export type FeedbackResult =
  | { ok: true; id: string }
  | { ok: false; code: "rate_limit" | "invalid" | "duplicate" | "spam"; message: string };

export function checkFeedbackRateLimit(req: IncomingMessage): FeedbackResult | null {
  if (!rateLimitScoped("feedback-hour", req, HOURLY_LIMIT, 3_600_000)) {
    return { ok: false, code: "rate_limit", message: "Too many submissions. Try again later." };
  }
  if (!rateLimitScoped("feedback-day", req, DAILY_LIMIT, 86_400_000)) {
    return { ok: false, code: "rate_limit", message: "Daily feedback limit reached." };
  }
  return null;
}

export function submitFeedback(
  req: IncomingMessage,
  body: {
    category?: string;
    message?: string;
    contact?: string;
    playerName?: string;
    sessionId?: string;
    page?: string;
    website?: string;
    _ts?: number;
  }
): FeedbackResult {
  const rateErr = checkFeedbackRateLimit(req);
  if (rateErr) return rateErr;

  if (body.website) {
    return { ok: false, code: "spam", message: "Rejected." };
  }

  const elapsed = body._ts ? Date.now() - body._ts : 9999;
  if (elapsed < 1500) {
    return { ok: false, code: "spam", message: "Rejected." };
  }

  const category = FEEDBACK_CATEGORIES.includes(body.category as FeedbackCategory)
    ? (body.category as FeedbackCategory)
    : "other";

  const message = sanitizeChatText(String(body.message || ""), MAX_MESSAGE_LEN);
  if (message.length < MIN_MESSAGE_LEN) {
    return { ok: false, code: "invalid", message: `Message must be at least ${MIN_MESSAGE_LEN} characters.` };
  }

  const ip = clientIp(req);
  if (isDuplicate(ip, message)) {
    return { ok: false, code: "duplicate", message: "You already sent this feedback recently." };
  }

  const entry: FeedbackEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    category,
    message,
    contact: sanitizeContact(String(body.contact || "")),
    playerName: body.playerName?.trim().slice(0, 16) || undefined,
    sessionId: body.sessionId?.slice(0, 64) || undefined,
    page: body.page?.slice(0, 200) || undefined,
    ipHash: hashIp(ip),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 200) || undefined,
  };

  ensureDir();
  fs.appendFileSync(feedbackFile(), JSON.stringify(entry) + "\n");

  logEvent("client_telemetry", entry.sessionId || "feedback", {
    detail: { event: "feedback_submitted", category, id: entry.id, ipHash: entry.ipHash },
  });

  return { ok: true, id: entry.id };
}

export function listFeedback(limit = 100): FeedbackEntry[] {
  return readRecent(Math.min(500, limit));
}
