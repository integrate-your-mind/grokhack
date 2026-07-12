import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  createXLinkCode,
  redeemXLinkCode,
  getLinkedXHandle,
  getLinkedGameNameForX,
  normalizeXHandle,
  formatXHandle,
  getXLinkStatus,
  _setXLinksFileForTests,
  _resetXLinksForTests,
  _restoreXLinksFileDefault,
} from "./x-links.js";
import { dataPath } from "./data-paths.js";

const TEST_FILE = dataPath("x", "links.test.json");

describe("x-links", () => {
  beforeEach(() => {
    _setXLinksFileForTests(TEST_FILE);
    _resetXLinksForTests();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
    _restoreXLinksFileDefault();
  });

  describe("normalizeXHandle", () => {
    it("strips @ and accepts valid handles", () => {
      expect(normalizeXHandle("@0xBunny")).toBe("0xBunny");
      expect(normalizeXHandle("GrokHack")).toBe("GrokHack");
    });

    it("parses profile URLs", () => {
      expect(normalizeXHandle("https://x.com/0xBunny")).toBe("0xBunny");
      expect(normalizeXHandle("https://twitter.com/0xBunny/status/123")).toBe("0xBunny");
    });

    it("rejects invalid handles", () => {
      expect(normalizeXHandle("")).toBeNull();
      expect(normalizeXHandle("has space")).toBeNull();
      expect(normalizeXHandle("way_too_long_handle_xx")).toBeNull();
      expect(normalizeXHandle("bad-dash")).toBeNull();
    });
  });

  it("formatXHandle adds @", () => {
    expect(formatXHandle("0xBunny")).toBe("@0xBunny");
    expect(formatXHandle("@x")).toBe("@x");
  });

  it("create + redeem links X handle to game name", () => {
    const created = createXLinkCode("@0xBunny", "Romy");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.entry.code).toMatch(/^[0-9A-F]{6}$/);
    expect(created.entry.xHandle).toBe("0xBunny");
    expect(created.entry.gameName).toBe("Romy");

    expect(getLinkedXHandle("Romy")).toBeNull();

    const redeemed = redeemXLinkCode(created.entry.code, "Romy");
    expect(redeemed.ok).toBe(true);
    expect(redeemed.message).toMatch(/@0xBunny/);
    expect(getLinkedXHandle("Romy")).toBe("0xBunny");
    expect(getLinkedXHandle("romy")).toBe("0xBunny");
    expect(getLinkedGameNameForX("@0xBunny")).toBe("Romy");
  });

  it("rejects wrong game name on redeem", () => {
    const created = createXLinkCode("alice", "Hero");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const bad = redeemXLinkCode(created.entry.code, "Other");
    expect(bad.ok).toBe(false);
    expect(getLinkedXHandle("Hero")).toBeNull();
  });

  it("rejects invalid code", () => {
    const r = redeemXLinkCode("DEADBEEF", "Hero");
    expect(r.ok).toBe(false);
  });

  it("rejects bad handle / game name on create", () => {
    expect(createXLinkCode("no spaces!", "Hero").ok).toBe(false);
    expect(createXLinkCode("ok", "1bad").ok).toBe(false);
    expect(createXLinkCode("ok", "").ok).toBe(false);
  });

  it("replaces pending for same handle", () => {
    const a = createXLinkCode("same", "A");
    const b = createXLinkCode("same", "B");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // First code for handle same should be gone; A's pending was dropped
    expect(redeemXLinkCode(a.entry.code, "A").ok).toBe(false);
    expect(redeemXLinkCode(b.entry.code, "B").ok).toBe(true);
  });

  it("one handle per character after link (re-link moves)", () => {
    const c1 = createXLinkCode("h1", "P1");
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    expect(redeemXLinkCode(c1.entry.code, "P1").ok).toBe(true);

    const c2 = createXLinkCode("h2", "P1");
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    expect(redeemXLinkCode(c2.entry.code, "P1").ok).toBe(true);
    expect(getLinkedXHandle("P1")).toBe("h2");
    expect(getLinkedGameNameForX("h1")).toBeNull();
  });

  it("getXLinkStatus reports linked display", () => {
    const c = createXLinkCode("StatusMe", "Stat");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    redeemXLinkCode(c.entry.code, "Stat");
    const st = getXLinkStatus("Stat");
    expect(st.mode).toBe("code");
    expect(st.linked?.display).toBe("@StatusMe");
    expect(st.onboarding.length).toBeGreaterThan(0);
  });
});
