#!/usr/bin/env node
/**
 * Render public/death-card.html → PNG for X media posts.
 *
 * Usage:
 *   node scripts/render-death-card.mjs
 *   node scripts/render-death-card.mjs --name Romy --depth 4 --cause "Starved to death" --out public/promo-death-run.png
 */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = path.join(root, "public", "death-card.html");

function arg(flag, fallback = "") {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const params = new URLSearchParams({
  name: arg("--name", "Adventurer"),
  depth: arg("--depth", "3"),
  turns: arg("--turns", "128"),
  level: arg("--level", "4"),
  gold: arg("--gold", "42"),
  cause: arg("--cause", "Slain by a kobold"),
  won: arg("--won", "0"),
});

const out = path.resolve(arg("--out", path.join(root, "public", "promo-death-card.png")));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.goto(`file://${html}?${params}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
await page.waitForTimeout(350);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
console.log(`params: ${params.toString()}`);
