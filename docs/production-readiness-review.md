# GrokHack production-readiness review

Status: materially hardened locally; **not production-ready for million-user or
99.99% claims**.

## Executive verdict

| Surface | Current verdict | Evidence / blocker |
|---|---|---|
| Legacy origin safety | Improved locally, still a single failure domain | Version-aware readiness, mutation-fenced graceful drain, parser/queue bounds, payment and character authorization, coalesced metadata persistence, privacy-safe reads, atomic joins |
| Cloudflare edge data plane | Strong undeployed substrate | Signed direct DO routing, PlayerSession route binding, full local authority fences, SQLite dedupe, alarms, hibernation, token buckets, bounded storage |
| Gameplay parity at edge | Partial undeployed parity | Shared deterministic wait/vitals plus movement-decision replay exist; no-turn carried-state continuity is fenced, while turn-consuming effect boundaries remain explicit because authoritative position, combat, monsters, item mutation, trap/room effects, and transfers are still origin-only |
| Global single-session ownership | Strong undeployed substrate | `PlayerSessionDO` now proves source-bound transfer/takeover, durable target prepare, commit/activation, abort/cleanup alarms, and 256-command handoff; external issuer/adoption remains |
| Million-user capacity | Unproven | No distributed load test, account-limit approval, cost curve, or hot-shard/reconnect-storm evidence |
| 99.99% application SLO | Unproven | No deployed end-to-end edge path, independent probes, 30-day SLI window, restore drill, or burn-rate paging |
| Delivery controls | Locally proven, not hosted | Locked CI workflow, clean installs, lint, coverage floors, builds, audits, and exact server type-debt baseline; no immutable commit/hosted run yet |
| Recovery | Blocked | Durable Object PITR design exists, but independent snapshots and random restore drills do not |

The current public service remains a Node/DuckDB process reached through one
Cloudflare Tunnel. That can be kept safer, but it cannot satisfy the target
availability or horizontal scale. The Cloudflare runtime must become the
authority through a fenced migration; adding more proxies to the origin is not
a scale solution.

## Highest-return work completed locally

- Removed unbounded dead-monster growth and added a 100,000-cycle invariant soak.
- Made malformed URI input return a bounded 400 instead of crashing a request.
- Separated owner and observer serialization so secrets/private state do not fan out.
- Isolated all tests from repository and production data, including fleet tests.
- Reproduced and fixed duplicate/ghost joins with a no-I/O atomic commit gate.
- Added parser, queue, per-IP/global connection, join-deadline, and outbound-byte bounds.
- Retired the alternate unhardened WebSocket entry point fail-closed.
- Added an undeployed sharded Cloudflare Worker/Durable Object package with
  direct hibernating sockets and SQLite-backed command dedupe.
- Fixed full 1-15 depth routing, pending-upgrade recovery, alarm cleanup,
  active/previous key verification, per-socket/floor token buckets, and a hard
  floor-session tombstone ceiling.
- Added locked CI, production dependency audits, correctness lint, full-source
  coverage floors, deterministic shuffled tests, builds, Wrangler dry runs, and
  an exact baseline for the remaining server TypeScript debt.
- Removed `npx` from the service child path and stripped unrelated inherited
  provider credentials; any credential exposed by a pre-fix process still needs
  external rotation and an approved restart.
- Made the public launcher force production semantics, reject an enabled x402
  development bypass at boot, require successful settlement receipts before a
  grant, and require character proof before spending credits.
- Made missing/corrupt resume-token state fail closed and tightened `.env`, data
  directory, and bearer-token vault permissions to owner-only.
- Re-keyed sticky WebSocket metrics without leaking provisional records, made
  world-meta persistence latest-wins/single-flight, and separated public social
  reads from owner-only pending/unread state without read-triggered writes.
- Added protocol-v4 `PlayerSessionDO` route authorization with opaque
  ticket-bound proof grants. Different floors and higher login epochs fail closed
  until a durable transfer/takeover saga is committed.
- Added source-bound freeze, durable destination preparation, irreversible
  commit, target activation, automatic source finalization, alarm-recovered abort,
  exact phase retries, full dedupe handoff, UUID canonicalization, adjacent-schema
  coverage, and bounded transfer receipts/artifacts.
- Fixed the ESM bootstrap boundary so `.env` is loaded before any module-scope
  security, bridge, limit, or data-path capture; `.env` is owner-only in every mode.
- Split origin liveness from readiness and exposed process age, world age,
  schema, release, runtime, persistence, drain, and payment-safety state.
- Added a synchronous shutdown mutation fence, post-I/O join revalidation,
  HTTP/WebSocket/Telnet drains, bounded transport/durability budgets, non-zero
  failure exits, and Kubernetes/supervisor grace aligned with those budgets.
- Reproduced a detached-wrapper DuckDB retry loop and added healthy-listener
  idling plus exponential fast-exit backoff. Deploy/install paths now distinguish
  a responding old release from a dead origin and cannot bypass the online-player guard.
- Repaired the edge lockfile from a clean npm 10 tree; npm 10 and npm 11 clean
  installs now agree instead of hiding optional WASM dependencies in `node_modules`.

## Verified local release evidence (2026-07-11)

- Node `22.23.1` parity: 51 test files and 570 tests pass normally, with coverage,
  and in deterministic shuffled order.
- Root coverage: 67.81% statements, 61.45% branches, 76.63% functions, 69.71% lines.
- Edge Workers runtime: 6 test files and 58 tests pass with 80.48% statements,
  75.94% branches, 96.39% functions, and 83.33% lines.
- Development, staging, and production Worker bundles pass Wrangler dry runs;
  the browser client and MCP package build.
- Root, edge, and MCP clean installs pass under Node 22/npm 10; the edge clean
  tree also passes its complete verify command. npm 11 accepts the same edge lock.
- Root, edge, and MCP report zero known npm audit findings, including dev dependencies.
- The exact server baseline remains 319 TypeScript 5.9.3 diagnostics. It did not
  grow, but `npm run build:server` is intentionally not green and remains release debt.
- A sealed Codex Security scoped scan reviewed all 11 edge transfer/auth files.
  It reproduced and fixed a UUID case-alias authority bypass; validation confirms
  the current snapshot has zero surviving reportable findings.

These are local correctness/reproducibility gates, not deployment, capacity,
availability, hosted-CI, or restore evidence.

## Current live rollout blocker (observed 2026-07-11)

The local and public legacy health endpoints returned HTTP 200 with two online
players, but their payload omitted the new `ready` and `productionSafe` fields.
The serving process is therefore still the prior Node 26 release, not this source.

The live process tree also contains a detached replacement wrapper that tries to
boot every three seconds and fails on the DuckDB lock held by the serving process.
That is an active resource/log-pressure defect. The source fix is locally proven,
but it cannot affect the already-running Bash supervisor or Node process.

No automatic replacement was performed. The guarded adoption path correctly
refuses a normal reload while players are online. A controlled drain/restart and
post-restart synthetic verification require explicit operational approval; after
that, the supervisor itself must be reloaded or deliberately adopted so its new
idling/backoff policy is active.

## P0 path to the target

1. Extract a pure deterministic gameplay reducer and run identical golden
   command traces in Node and Workers. Do not maintain two game engines.
2. **Implemented locally in the undeployed edge substrate:** opaque proof-bound
   route grants and the idempotent freeze/prepare/commit/activate transfer saga,
   including response-loss retry, abort-before-commit, stale fencing,
   sequence/dedupe handoff, concurrency races, and phase eviction. A real issuer,
   internal deployment, and canary evidence remain later gates.
3. **Implemented locally in the edge substrate:** sharded allocation/control
   objects and an explicit alarm-recoverable floor-epoch retirement path. The
   gateway reaches a directory only for new assignment/retirement; direct Floor
   WebSockets and commands do not. Issuer adoption, deployment, and measured
   capacity remain later gates.
4. Add the transactional outbox, partitioned Queues/DLQ, D1 read projections,
   and independent R2 restore artifacts. None may be synchronous gameplay dependencies.
5. Extend the now-proven immutable, bounded shadow replay path from shared
   turn/vitals and movement-decision transitions to combat, monsters, item
   mutation, trap/room effects, durable position, and every remaining gameplay
   transition; require byte-stable state and behavioral-event hashes before any
   authority transfer.
6. Deploy an internal environment only after explicit approval for resources,
   secrets, DNS, and traffic. Run external synthetic transactions from multiple providers.
7. Measure object saturation, fanout, storage growth, hot-shard skew, 10x reconnect
   storms, deploy-under-load, and fault injection. Keep admission below 40% of the
   measured knee.
8. Prove random PITR plus independent restore, then canary through fenced cohorts.
   Start the 30-day SLO evidence window only after the complete path is authoritative.

## Non-negotiable claim gate

Do not market “millions of concurrent users” or “99.99% uptime” from unit tests,
dry-run bundles, one Durable Object, a Tunnel health check, or a platform SLA.
Those targets become defensible only after the distributed peak, full application
SLI, failure injection, restore, and measured-time gates in
[`production-slo.md`](production-slo.md) and
[`edge-migration-plan.md`](edge-migration-plan.md) pass.

## Change authority

This work intentionally did not deploy, restart the live server, create paid
Cloudflare resources, upload secrets, change DNS/routes, alter gameplay data, or
run high-volume external load. Local host flags and sensitive-file permissions
were hardened, but the running process does not inherit source/config changes
until a controlled release. Deployment and restart still require an explicit decision.
