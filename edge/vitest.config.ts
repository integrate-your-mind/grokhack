import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export const TEST_ROUTE_TICKET_SECRET =
  "local-workers-runtime-test-key-2026-07-10-change-me";
export const TEST_PREVIOUS_ROUTE_TICKET_SECRET =
  "local-workers-runtime-previous-test-key-2026-07-10";
process.env.ROUTE_TICKET_SECRET ??= TEST_ROUTE_TICKET_SECRET;
process.env.ROUTE_TICKET_PREVIOUS_SECRET ??= TEST_PREVIOUS_ROUTE_TICKET_SECRET;
export const TEST_SHADOW_INGEST_SECRET = "local-shadow-ingest-test-key-2026-07-11";
process.env.SHADOW_INGEST_SECRET ??= TEST_SHADOW_INGEST_SECRET;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          EDGE_ENVIRONMENT: "test",
          FLOOR_SOCKET_CAP: "2",
          FLOOR_MESSAGES_PER_MINUTE: "5",
          FLOOR_MESSAGE_BURST: "10",
          FLOOR_EVENTS_PER_SECOND: "10",
          FLOOR_EVENT_BURST: "15",
          FLOOR_SESSION_TOMBSTONE_CAP: "3",
          FLOOR_REPLAY_GRACE_SECONDS: "600",
          REALM_DIRECTORY_BUCKETS: "8",
          REALM_DIRECTORY_SUPPORTED_BUCKET_COUNTS: "4,8",
          REALM_DIRECTORY_FLOOR_LIMIT: "4",
          REALM_DIRECTORY_RESERVATION_SECONDS: "65",
          REALM_DIRECTORY_RECEIPT_LIMIT: "64",
          ROUTE_TICKET_TTL_SECONDS: "60",
          ROUTE_TICKET_AUDIENCE: "grokhack-edge-game",
          ROUTE_TICKET_ISSUER: "grokhack-session-control",
          ROUTE_TICKET_KEY_ID: "test-v1",
          ROUTE_TICKET_PREVIOUS_KEY_ID: "test-v0",
          ALLOWED_BROWSER_ORIGINS: "https://edge.test",
          ROUTE_TICKET_SECRET: TEST_ROUTE_TICKET_SECRET,
          ROUTE_TICKET_PREVIOUS_SECRET: TEST_PREVIOUS_ROUTE_TICKET_SECRET,
          SHADOW_INGEST_SECRET: TEST_SHADOW_INGEST_SECRET,
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
    restoreMocks: true,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: {
        statements: 80,
        branches: 74,
        functions: 94,
        lines: 82,
      },
    },
  },
});
