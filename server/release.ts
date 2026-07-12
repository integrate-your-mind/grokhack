import { execFileSync } from "node:child_process";

const RELEASE_SHA_RE = /^[0-9a-f]{7,40}$/u;

export type GitRevisionReader = (cwd: string) => string;

function readGitRevision(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
    maxBuffer: 1_024,
  });
}

function normalizeReleaseSha(value: string | undefined): string | undefined {
  const candidate = value?.trim().toLowerCase();
  return candidate && RELEASE_SHA_RE.test(candidate) ? candidate : undefined;
}

export function resolveReleaseSha(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  gitRevision: GitRevisionReader = readGitRevision,
): string {
  const configured = normalizeReleaseSha(env.GROKHACK_RELEASE_SHA);
  if (configured) return configured;
  try {
    return normalizeReleaseSha(gitRevision(cwd)) ?? "local";
  } catch {
    return "local";
  }
}
