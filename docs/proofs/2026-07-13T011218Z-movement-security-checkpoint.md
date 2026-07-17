# Movement shadow parity security checkpoint

Timestamp: `2026-07-13T01:12:18Z`

This receipt preserves the exact locally proven movement-shadow branch at the
requested shutdown boundary. It is a checkpoint, not a production-readiness,
security-closure, merge, deployment, capacity, or 99.99% uptime claim.

## Exact repository state before this receipt

- Repository: `/Users/romanmondello/grok-build`
- Branch: `codex/movement-shadow-parity`
- Local HEAD: `7492cec8b5c679bede30bf518e33955934526cc7`
- Remote branch: `origin/codex/movement-shadow-parity`
- Remote SHA: `92a29f679de330ecb1587de56c827c554c67769c`
- Pull request: draft PR #2, `feat: add movement shadow parity`
- PR overlap: PR #2 is the only open PR; no open issues or review comments were
  present at checkpoint recovery.
- Hosted CI: the only check did not execute repository steps because GitHub
  reported the account billing lock. Hosted CI is not used as local proof.

The local branch was one commit ahead of the remote. Five attributed follow-up
files were dirty and no untracked file existed before this receipt:

- `edge/src/index.ts`
- `edge/test/bounded-body.test.ts`
- `edge/test/shadow-replay.test.ts`
- `scripts/prove-shadow-catchup.ts`
- `server/telnet.test.ts`

## Attributed follow-up changes

- Export the real shadow catch-up route so its Durable Object failure boundary
  is tested without corrupting a live test schema.
- Prove retryable replay-object failures return structured HTTP 503 plus
  `Retry-After: 1` rather than leaking an uncaught exception.
- Correct the receipt-window fixture so 300 valid turns do not terminate from
  starvation, and include response text in a failing assertion.
- Remove invalid matcher type arguments while preserving bounded-body failure
  assertions.
- Feed the continuity proof both the immutable cursor-1 prefix and the divergent
  cursor-2 entry, matching the real copier contract.
- Wait for the actual Telnet naming prompt before exercising the admission
  failure fence.

The complete five-file diff was reviewed at the checkpoint. It contains no
generated output, dependency or lockfile change, credential, secret, production
data, or unrelated formatting churn. `git diff --check` passed.

## Exact local verification already completed

All commands below completed against the same source state represented by local
HEAD plus the five follow-up files above. No repository source changed between
these gates and this checkpoint; the later security work wrote only isolated
artifacts outside the repository.

Toolchain:

- Node: `v22.23.1` from
  `/Users/romanmondello/.npm/_npx/17355f44438e6c6e/node_modules/node/bin/node`
- npm CLI: cached npm 10 from
  `/Users/romanmondello/.npm/_npx/4b0cc92362cfffad/node_modules/npm/bin/npm-cli.js`

Root gates:

- Coverage: 56 files and 629 tests passed; 70.30% statements, 64.23%
  branches, 78.86% functions, and 72.29% lines.
- Deterministic shuffle: 56 files and 629 tests passed with seed `20260710`.
- Property suite: 3 files and 30 tests passed.
- Correctness lint passed.
- Full dependency audit reported zero known vulnerabilities.
- Shadow catch-up E2E passed with checkpoint 396, 332 accepted entries, 64
  duplicates, explicit state/event/continuity divergence, and terminal parity.
- Browser build passed.
- Server TypeScript baseline remained exactly 319 diagnostics; it did not grow.

Edge and package gates:

- Generated Worker types and TypeScript checking passed.
- Edge coverage: 9 files and 93 tests passed; 82.17% statements, 77.09%
  branches, 96.10% functions, and 84.80% lines.
- Edge deterministic shuffle: all 93 tests passed.
- Edge property gate: 4 selected tests passed and 18 non-property tests were
  intentionally skipped by that selector.
- Development, staging, and production Wrangler dry-run builds passed.
- Edge production audit reported zero known vulnerabilities.
- MCP production audit and build passed.

These results establish local correctness/build parity for the checkpointed
five-file state. They do not establish hosted execution or deployment.

## Scoped security review

Scan identity:

- Target HEAD: `7492cec8b5c679bede30bf518e33955934526cc7`
- Exact working-tree snapshot:
  `codex-security-snapshot/v1:sha256:fcfe3ce4aa3865c87d5c9609d5d586778a35dfd9e9063f1ce543c77f696e47aa`
- Scan directory:
  `/var/folders/79/v8mgm0w50vv5qvv3l3_nvb7h0000gn/T/codex-security-scans/grok-build/7492cec8b5c679bede30bf518e33955934526cc7_20260713T004117Z`

Discovery reconciled 20 source receipts and two candidates. Both candidates were
validated with isolated Node 22 harnesses and then attack-path analyzed:

1. `WORLD-MOVEMENT-ATOMICITY-002`: reproduced correctness/fairness defect, final
   security policy `ignore`. Exploitation requires an attacker-uncontrolled
   second journal I/O failure; the unsafe V1 ordering already exists on `main`;
   V2 remains undeployed and non-authoritative. The transactional outbox remains
   required production debt before authority transfer.
2. `WORLD-MOVEMENT-JOURNAL-DOS-001`: **reportable medium/P2 and not fixed**.
   After branch adoption, unauthenticated effectful movement adds an unbounded
   larger V2 stream and causes both V2 and V1 segment rewrites with file and
   directory fsync. The bounded reproduction retained 129 V2 plus 129 V1
   entries (137,859 bytes), performed 516 fsyncs, and rewrote 4,445,121 bytes.
   Current V2 live exposure is none because the branch is undeployed.

A final read-only remediation review touched no repository or scan file. Its
preliminary conclusion was that complete closure needs both a persistent V2
evidence ceiling and constant-cost, crash-safe append behavior. No remediation
was started at this shutdown boundary.

## Honest remaining gaps

- The medium/P2 journal resource-consumption finding is open. This branch must
  not be merged or adopted until the original harness no longer reproduces and
  durability, compatibility, bypass, focused, and canonical gates pass again.
- The scoped security scan is not finalized or sealed because the surviving
  finding has not been fixed and verified.
- The V1/V2 pair is not a transactional outbox. Full gameplay parity, outbox,
  Queue/DLQ, archive, load/fault, restore, rollout, and measured SLO work remain.
- Hosted CI executed zero repository steps.
- No Worker deployment, route/DNS/traffic change, restart, production-data
  mutation, secret upload, paid resource creation, merge, release, or live
  runtime adoption occurred.

## Resume boundary

Keep the persistent production-readiness goal paused. When deliberately resumed,
start by rereading the P2 attack-path report and the fix-finding contract, then
encode the capacity/write-amplification regression before changing source:

```bash
cd /Users/romanmondello/grok-build
sed -n '1,360p' /var/folders/79/v8mgm0w50vv5qvv3l3_nvb7h0000gn/T/codex-security-scans/grok-build/7492cec8b5c679bede30bf518e33955934526cc7_20260713T004117Z/artifacts/05_findings/WORLD-MOVEMENT-JOURNAL-DOS-001/attack_path_analysis_report.md
sed -n '1,360p' /Users/romanmondello/.codex/plugins/cache/openai-curated-remote/codex-security/0.1.11/skills/fix-finding/SKILL.md
```
