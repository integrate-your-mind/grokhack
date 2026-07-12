#!/usr/bin/env node
/** Render public/og-card.html → public/og.png (1200×630 Twitter card). */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = path.join(root, "public", "og-card.html");
const out = path.join(root, "public", "og.png");

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.goto(`file://${html}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
// Fonts may 404 offline; layout still works with monospace fallback
await page.waitForTimeout(400);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
