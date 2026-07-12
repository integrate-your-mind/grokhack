import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { submitFeedback, checkFeedbackRateLimit } from "./feedback.js";
import { dataPath } from "./data-paths.js";
import type { IncomingMessage } from "node:http";

const FEEDBACK_DIR = dataPath("feedback");

function mockReq(ip = "203.0.113.1"): IncomingMessage {
  return {
    headers: { "cf-connecting-ip": ip, "user-agent": "test" },
    socket: { remoteAddress: ip },
  } as IncomingMessage;
}

describe("feedback", () => {
  const testDay = new Date().toISOString().slice(0, 10);
  const testFile = path.join(FEEDBACK_DIR, `${testDay}.jsonl`);

  beforeEach(() => {
    if (!fs.existsSync(FEEDBACK_DIR)) fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
    fs.writeFileSync(testFile, "");
  });

  afterEach(() => {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  it("accepts valid feedback", () => {
    const r = submitFeedback(mockReq(), {
      category: "bug",
      message: "The chat panel closes when I send a message",
      _ts: Date.now() - 5000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects honeypot", () => {
    const r = submitFeedback(mockReq("203.0.113.2"), {
      message: "This is spam content here",
      website: "http://spam.com",
      _ts: Date.now() - 5000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("spam");
  });

  it("rejects too-fast submissions", () => {
    const r = submitFeedback(mockReq("203.0.113.3"), {
      message: "Bot filled this instantly",
      _ts: Date.now(),
    });
    expect(r.ok).toBe(false);
  });

  it("rate limits per IP", () => {
    const req = mockReq("203.0.113.99");
    for (let i = 0; i < 5; i++) {
      const r = submitFeedback(req, {
        message: `Unique feedback message number ${i} for rate test`,
        _ts: Date.now() - 5000,
      });
      expect(r.ok).toBe(true);
    }
    const blocked = checkFeedbackRateLimit(req);
    expect(blocked?.ok).toBe(false);
  });
});
