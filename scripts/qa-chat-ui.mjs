#!/usr/bin/env node
/**
 * Browser QA — chat dock stays open after send, no duplicate lines.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_URL || "http://127.0.0.1:8080";
const NAME = `UI${Date.now().toString(36).slice(-6)}`;
const MSG = `qa-msg-${Date.now()}`;

const results = [];
const pass = (n) => { results.push({ n, ok: true }); console.log(`  ✓ ${n}`); };
const fail = (n, d) => { results.push({ n, ok: false, d }); console.log(`  ✗ ${n}: ${d}`); };

async function main() {
  console.log(`\nGrokHack chat UI QA → ${BASE}/play.html\n`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${BASE}/play.html`, { waitUntil: "networkidle" });
    await page.fill("#name-input", NAME);
    await page.click("#join-btn");
    await page.waitForSelector("#game:not(.hidden)", { timeout: 8000 });
    pass("join game");

    await page.keyboard.press("Enter");
    await page.waitForSelector("#chat-dock:not(.collapsed)", { timeout: 3000 });
    pass("chat opens on Enter");

    await page.fill("#chat-input", MSG);
    await page.click("#chat-form button[type=submit]");

    await page.waitForTimeout(600);

    const collapsed = await page.$eval("#chat-dock", (el) => el.classList.contains("collapsed"));
    if (!collapsed) pass("chat stays open after send");
    else fail("chat stays open after send", "dock collapsed");

    const focused = await page.evaluate(() => document.activeElement?.id === "chat-input");
    if (focused) pass("chat input keeps focus after send");
    else fail("chat input keeps focus after send", `focus on ${await page.evaluate(() => document.activeElement?.id)}`);

    const lines = await page.$$eval("#chat-feed .line", (els) => els.map((e) => e.textContent?.trim() || ""));
    const mine = lines.filter((l) => l.includes(MSG));
    if (mine.length === 1) pass("single chat line (no duplicate)");
    else fail("single chat line (no duplicate)", `found ${mine.length}: ${mine.join(" | ")}`);

    const logText = await page.$eval("#log", (el) => el.textContent || "");
    if (!logText.includes(MSG)) pass("game log excludes chat");
    else fail("game log excludes chat", "chat text appeared in #log");

    await page.keyboard.press("l");
    await page.waitForTimeout(400);
    const stillOpen = !(await page.$eval("#chat-dock", (el) => el.classList.contains("collapsed")));
    if (stillOpen) pass("chat stays open after move");
    else fail("chat stays open after move", "dock collapsed on state update");

  } catch (err) {
    fail("unexpected", err.message);
  } finally {
    await browser.close();
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  if (bad.length) {
    for (const b of bad) console.log(`  - ${b.n}: ${b.d}`);
    process.exit(1);
  }
  console.log("\nChat UI OK\n");
}

main().catch((e) => { console.error(e); process.exit(1); });