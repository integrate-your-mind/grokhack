import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const supervisor = readFileSync(join(import.meta.dirname, "grokhack-supervisor.sh"), "utf8");
const deploy = readFileSync(join(import.meta.dirname, "deploy.sh"), "utf8");
const installer = readFileSync(join(import.meta.dirname, "install-service.sh"), "utf8");
const isolatedTestRunner = readFileSync(
  join(import.meta.dirname, "run-tests-isolated.mjs"),
  "utf8",
);
const serverIndex = readFileSync(join(import.meta.dirname, "..", "server", "index.ts"), "utf8");
const supervisorPath = join(import.meta.dirname, "grokhack-supervisor.sh");

describe("production supervisor credential boundary", () => {
  it("uses the locked local runtime without an npm-exec parent", () => {
    expect(supervisor).toContain('"$ROOT/node_modules/.bin/tsx" server/index.ts');
    expect(supervisor).not.toMatch(/\bnpx\s+tsx\s+server\/index\.ts/);
  });

  it("idles behind a verified listener and exponentially backs off fast exits", () => {
    const output = execFileSync(
      "bash",
      [
        "-c",
        `source "$1"
printf 'backoff=%s,%s,%s,%s,%s,%s\n' \
  "$(server_restart_backoff_seconds 1)" \
  "$(server_restart_backoff_seconds 2)" \
  "$(server_restart_backoff_seconds 3)" \
  "$(server_restart_backoff_seconds 4)" \
  "$(server_restart_backoff_seconds 5)" \
  "$(server_restart_backoff_seconds 6)"
server_healthy() { return 0; }
if server_process_needed; then printf 'healthy=boot\n'; else printf 'healthy=idle\n'; fi
server_healthy() { return 1; }
if server_process_needed; then printf 'unhealthy=boot\n'; else printf 'unhealthy=idle\n'; fi`,
        "bash",
        supervisorPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GROKHACK_SUPERVISOR_LIBRARY_ONLY: "1",
          SERVER_RESTART_DELAY: "3",
          SERVER_RESTART_MAX_DELAY: "60",
        },
      },
    );

    expect(output).toBe("backoff=3,6,12,24,48,60\nhealthy=idle\nunhealthy=boot\n");
    expect(supervisor).toContain("if ! server_process_needed; then");
  });

  it("drops unrelated workstation provider credentials before spawning services", () => {
    for (const name of [
      "ARISTOTLE_API_KEY",
      "BANKR_API_KEY",
      "GROQ_GATEWAY_TOKEN",
      "HONCHO_API_KEY",
      "KIMI_API_KEY",
      "MINIMAX_API_KEY",
      "TENDERLY_API_KEY",
    ]) {
      expect(supervisor).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(supervisor).toMatch(/unset "\$inherited_secret"/);
  });

  it("forces production mode and adopts only origins reporting the payment guard", () => {
    expect(supervisor).toContain("export NODE_ENV=production");
    expect(supervisor).toContain("export GROKHACK_ENV=production");
    expect(supervisor).toContain("export X402_FORCE_PROD=1");
    expect(supervisor).not.toContain("export X402_DEV_BYPASS=");
    expect(supervisor).not.toContain("export X402_DEV_SECRET=");
    expect(supervisor).toContain('"productionSafe":true');
    expect(supervisor).toContain('"ready":true');
    expect(deploy).toContain('"productionSafe":true');
    expect(installer).toContain('"productionSafe":true');
  });

  it("allows the application durability budget before hard-killing the server", () => {
    expect(supervisor).toContain('SERVER_STOP_GRACE_SECONDS="${SERVER_STOP_GRACE_SECONDS:-100}"');
    expect(supervisor).toContain(
      'stop_pid_file "$SERVER_PID_FILE" "server" "$SERVER_STOP_GRACE_SECONDS"',
    );
  });

  it("checks the payment safety invariant before persistence or listeners start", () => {
    expect(serverIndex.indexOf("loadEnvFile();")).toBeLessThan(
      serverIndex.indexOf('import("./x402.js")'),
    );
    expect(serverIndex.indexOf('import("./x402.js")')).toBeLessThan(
      serverIndex.indexOf("assertX402RuntimeSafety();"),
    );
    expect(serverIndex.indexOf("assertX402RuntimeSafety();")).toBeLessThan(
      serverIndex.indexOf("initPersistence()"),
    );
  });

  it("loads .env before importing modules that capture runtime configuration", () => {
    const source = ts.createSourceFile(
      "server/index.ts",
      serverIndex,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const runtimeImports = source.statements
      .filter(ts.isImportDeclaration)
      .filter((statement) => !statement.importClause?.isTypeOnly)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    expect(runtimeImports).toEqual(["./load-env.js"]);

    const assertAt = serverIndex.indexOf("assertX402RuntimeSafety();");
    for (const match of serverIndex.matchAll(/import\("([^"]+)"\)/g)) {
      if (match[1] === "./x402.js" || match[1] === "./release.js") continue;
      expect(match.index).toBeGreaterThan(assertAt);
    }
    expect(serverIndex.indexOf('import("./release.js")')).toBeLessThan(assertAt);
    expect(serverIndex.indexOf("resolveReleaseSha()")).toBeLessThan(assertAt);
    expect(serverIndex.indexOf("loadEnvFile();")).toBeLessThan(
      serverIndex.indexOf('import("./security.js")'),
    );
    expect(serverIndex.indexOf("loadEnvFile();")).toBeLessThan(
      serverIndex.indexOf('import("./bridge.js")'),
    );
    expect(serverIndex.indexOf("loadEnvFile();")).toBeLessThan(
      serverIndex.indexOf('import("./persistence.js")'),
    );
  });

  it("never prints full process arguments from status commands", () => {
    for (const script of [deploy, installer]) {
      expect(script).not.toMatch(/pgrep\s+-fl/);
      expect(script).toContain("safe_process_list");
    }
  });

  it("does not recursively copy nested dependency or generated trees into test sandboxes", () => {
    for (const directory of ["node_modules", "coverage", "dist", ".wrangler"]) {
      expect(isolatedTestRunner).toContain(`"${directory}",`);
    }
    expect(isolatedTestRunner).toContain(
      "parts.some((part) => excludedDirectoryNames.has(part))",
    );
  });

  it("makes deploys fail closed behind all release gates and the pinned Wrangler", () => {
    for (const command of [
      "npm run lint",
      "npm run test:coverage",
      "npm test -- --sequence.shuffle --sequence.seed=20260710",
      "npm run build",
      "npm run check:server-types",
      "npm run mcp:build",
      "npm run edge:verify",
    ]) {
      expect(deploy).toContain(command);
    }
    expect(deploy).toContain('local wrangler="$ROOT/edge/node_modules/.bin/wrangler"');
    expect(deploy).not.toContain("npx wrangler pages deploy");
    expect(deploy).toContain('git ls-remote --exit-code origin "refs/heads/$PAGES_PRODUCTION_BRANCH"');
    expect(deploy).toContain('git archive "$sha" public | tar -x -C "$archive_dir"');
    expect(deploy).toContain('--branch "$PAGES_PRODUCTION_BRANCH"');
    expect(deploy).toContain('--commit-hash "$sha"');
    expect(deploy).toContain("--commit-dirty=false");
    expect(deploy).not.toMatch(/soft_reload_server\s*\|\|\s*true/);
    expect(deploy).not.toMatch(/pages deploy failed \(continuing\)/);
    expect(deploy).toContain('RELOAD_RECOVERY_TIMEOUT_SEC="${RELOAD_RECOVERY_TIMEOUT_SEC:-130}"');
    expect(deploy).toContain("origin_local_responding");
    expect(deploy).toContain("online_players");
    const fullBranch = deploy.match(/ {2}full\)([\s\S]*?)\n {4};;/)?.[1] ?? "";
    expect(fullBranch.indexOf("guard_soft_reload")).toBeLessThan(
      fullBranch.indexOf("run_release_gates"),
    );
    expect(fullBranch.indexOf("run_release_gates")).toBeLessThan(
      fullBranch.indexOf("soft_reload_server"),
    );
    expect(fullBranch.indexOf("soft_reload_server")).toBeLessThan(
      fullBranch.indexOf("deploy_pages"),
    );
    expect(installer).toContain("origin_responding");
    expect(installer).toContain("refusing implicit replacement");
  });

  it("keeps the player guard active when a live origin is an older release", () => {
    const deployPath = join(import.meta.dirname, "deploy.sh");
    const output = execFileSync(
      "bash",
      [
        "-c",
        `source "$1"
status_json() { printf '{"onlinePlayers":2}\n'; }
if guard_soft_reload; then printf 'allowed\n'; else printf 'blocked\n'; fi`,
        "bash",
        deployPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FORCE: "0",
          GROKHACK_DEPLOY_LIBRARY_ONLY: "1",
        },
      },
    );
    expect(output).toContain("BLOCKED: onlinePlayers=2");
    expect(output).toMatch(/blocked\s*$/);
  });

  it.each([
    ["the status request fails", "return 1"],
    ["the status payload omits onlinePlayers", `printf '{"ok":true}\\n'`],
  ])("fails closed when %s", (_scenario, statusBody) => {
    const deployPath = join(import.meta.dirname, "deploy.sh");
    const output = execFileSync(
      "bash",
      [
        "-c",
        `source "$1"
status_json() { ${statusBody}; }
if guard_soft_reload; then printf 'allowed\\n'; else printf 'blocked\\n'; fi`,
        "bash",
        deployPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FORCE: "0",
          GROKHACK_DEPLOY_LIBRARY_ONLY: "1",
        },
      },
    );
    expect(output).toContain("BLOCKED: online player count unavailable");
    expect(output).toMatch(/blocked\s*$/);
  });
});
