import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** Default: localhost only — Cloudflare tunnel reaches 127.0.0.1:8080 */
export const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
export const ADMIN_TOKEN = process.env.GROKHACK_ADMIN_TOKEN || "";
export const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || "65536", 10);
export const MAX_WS_MESSAGE_BYTES = parseInt(process.env.MAX_WS_MESSAGE_BYTES || "8192", 10);
export const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "120", 10);

const buckets = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string") return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

export function rateLimit(req: IncomingMessage): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 60_000 };
    buckets.set(ip, b);
  }
  b.count++;
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (now > v.resetAt) buckets.delete(k);
    }
  }
  return b.count <= RATE_LIMIT_PER_MIN;
}

export function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!ADMIN_TOKEN) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Admin API disabled. Set GROKHACK_ADMIN_TOKEN." }));
    return false;
  }
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== ADMIN_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' wss: ws:; img-src 'self' data:;",
    ...extra,
  };
}

export function safePublicPath(publicDir: string, urlPath: string): string | null {
  const safe = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  if (safe.includes("..") || safe.includes("\0")) return null;
  const resolved = path.resolve(publicDir, safe);
  if (!resolved.startsWith(path.resolve(publicDir) + path.sep) && resolved !== path.resolve(publicDir)) {
    return null;
  }
  return resolved;
}

export function sanitizePlayerName(name: string): string | null {
  const trimmed = name.trim().slice(0, 16);
  if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeChatText(text: string, max = 280): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max);
}