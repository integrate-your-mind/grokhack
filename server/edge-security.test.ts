import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

describe("edge / deploy security invariants", () => {
  it("TELNET_BIND_HOST defaults to loopback independent of BIND_HOST", async () => {
    const prevBind = process.env.BIND_HOST;
    const prevTelnet = process.env.TELNET_BIND_HOST;
    try {
      process.env.BIND_HOST = "0.0.0.0";
      delete process.env.TELNET_BIND_HOST;
      // Re-import is cached — assert source contract + env fallback shape.
      const src = readFileSync(resolve(root, "server/security.ts"), "utf8");
      expect(src).toMatch(/TELNET_BIND_HOST\s*=\s*process\.env\.TELNET_BIND_HOST\s*\|\|\s*"127\.0\.0\.1"/);
      expect(src).toMatch(/export const BIND_HOST/);
    } finally {
      if (prevBind === undefined) delete process.env.BIND_HOST;
      else process.env.BIND_HOST = prevBind;
      if (prevTelnet === undefined) delete process.env.TELNET_BIND_HOST;
      else process.env.TELNET_BIND_HOST = prevTelnet;
    }
  });

  it("host tunnel config pins 127.0.0.1 and never telnet", () => {
    const yml = readFileSync(resolve(root, "cloudflare/grokhack-tunnel.yml"), "utf8");
    expect(yml).toMatch(/service:\s*http:\/\/127\.0\.0\.1:8080/);
    // service lines only — comments may mention localhost as the anti-pattern
    const services = yml.split("\n").filter((l) => /^\s*service:/.test(l)).join("\n");
    expect(services).not.toMatch(/localhost/);
    expect(services).not.toMatch(/:4000/);
  });

  it("docker tunnel config does not expose telnet", () => {
    const yml = readFileSync(resolve(root, "cloudflare/grokhack-tunnel.docker.yml"), "utf8");
    expect(yml).not.toMatch(/:4000/);
    expect(yml).toMatch(/service:\s*http:\/\//);
  });

  it(".dockerignore excludes secrets and local data", () => {
    const ig = readFileSync(resolve(root, ".dockerignore"), "utf8");
    expect(ig).toMatch(/\.env/);
    expect(ig).toMatch(/credentials/);
    expect(ig).toMatch(/^data\//m);
  });

  it("Dockerfile does not EXPOSE telnet and sets TELNET_BIND_HOST", () => {
    const df = readFileSync(resolve(root, "Dockerfile"), "utf8");
    expect(df).toMatch(/TELNET_BIND_HOST=127\.0\.0\.1/);
    const expose = df.split("\n").filter((l) => /^\s*EXPOSE\b/.test(l)).join("\n");
    expect(expose).not.toMatch(/\b4000\b/);
    expect(expose).toMatch(/\b8080\b/);
  });

  it("compose publishes only loopback :8080", () => {
    const c = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    expect(c).toMatch(/127\.0\.0\.1:8080:8080/);
    expect(c).not.toMatch(/4000:4000/);
    expect(c).toMatch(/TELNET_BIND_HOST:\s*"127\.0\.0\.1"/);
  });

  it("k8s game forces TELNET_BIND_HOST loopback", () => {
    const ss = readFileSync(resolve(root, "deploy/k8s/40-game-statefulset.yaml"), "utf8");
    expect(ss).toMatch(/name:\s*TELNET_BIND_HOST/);
    expect(ss).toMatch(/value:\s*"127\.0\.0\.1"/);
    expect(ss).toMatch(/replicas:\s*1/);
  });

  it("deprecated multi-replica deployment is no longer replicas:2", () => {
    const d = readFileSync(resolve(root, "deploy/k8s/deployment.yaml"), "utf8");
    expect(d).toMatch(/DEPRECATED/);
    expect(d).not.toMatch(/replicas:\s*2/);
  });

  it("supervisor free_port refuses foreign PIDs and gates tunnel origin", () => {
    const sh = readFileSync(resolve(root, "scripts/grokhack-supervisor.sh"), "utf8");
    expect(sh).toMatch(/is_our_server_pid/);
    expect(sh).toMatch(/tunnel_config_safe/);
    expect(sh).toMatch(/k8s_tunnel_conflict/);
    expect(sh).toMatch(/refusing tunnel start/);
    expect(sh).toMatch(/FREE_PORT_FORCE/);
  });

  it("k8s-deploy refuses dual-origin by default", () => {
    const sh = readFileSync(resolve(root, "scripts/k8s-deploy.sh"), "utf8");
    expect(sh).toMatch(/ALLOW_DUAL_ORIGIN/);
    expect(sh).toMatch(/SKIP_TUNNEL/);
    expect(sh).toMatch(/host cloudflared already running/);
    expect(sh).toMatch(/values not logged/);
  });

  it("gitignore covers k8s secret materialization", () => {
    const g = readFileSync(resolve(root, ".gitignore"), "utf8");
    expect(g).toMatch(/30-secret\.yaml/);
    expect(g).toMatch(/credentials/);
  });

  it("optional network policy file exists", () => {
    expect(existsSync(resolve(root, "deploy/k8s/70-network-policy.yaml"))).toBe(true);
  });
});
