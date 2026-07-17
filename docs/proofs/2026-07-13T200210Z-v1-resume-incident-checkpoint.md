# V1 no-turn resume incident checkpoint

Timestamp: `2026-07-13T20:02:10Z`

## Durable Git state

- Repository/worktree: `/Users/romanmondello/grok-build`
- Registered branch: `codex/movement-shadow-parity`
- Local HEAD: `a022a086f89f0e4f842f7712d1fdf6ab70f921f2`
- Upstream tracking SHA: `a022a086f89f0e4f842f7712d1fdf6ab70f921f2`
- Staged changes: none
- Pre-receipt tracked worktree patch SHA-256: `0a025217c43159eee45ecf0fa507504d46b343596f90efe903b7d9075ea1d242`
- Resume-slice patch SHA-256 (`server/shadow-catchup.ts` plus its test): `d926fadab7f641dd7154dc54a603546cb00f98a2b215a27b69eef95d70711564`
- The worktree is the sole registered Git worktree and is not temporary storage.

The broader uncommitted PR #2 patch remains intentionally preserved in place:
18 tracked files were modified before this receipt, with 2,735 insertions and
115 deletions. The only non-scan untracked source file is
`scripts/qa-play.test.ts`, SHA-256
`7ad723dfb6dd2870e48dd57d2775ad8057e4c8b812452ed9253b2c3a7c981789`.
The in-progress security artifacts remain under
`docs/proofs/security-scans/`; nothing was deleted, reset, moved, staged,
committed, pushed, merged, or deployed at this checkpoint.

## Reproduced defect and atomic fix

Independent QA reproduced a valid `turn -> no-turn -> resume at cursor 2`
sequence being rejected because the copier initialized its expected durable V1
turn-state hash to `null`. A regression was added before the fix. It failed with
`invalid movement-turn shadow checkpoint advance` while the other 12 focused
tests passed.

`catchUpMovementTurnJournal` now reconstructs the bounded committed prefix up
to the caller's re-submitted cursor, carrying the last movement hash, the last
non-null V1 turn hash, and terminal state. The expected acknowledgement hash is
explicitly typed as `string | null`, removing the added TS7022 diagnostic.

Focused exact-worktree evidence:

- `node scripts/run-tests-isolated.mjs server/shadow-catchup.test.ts`: exit 0,
  13/13 tests passed after the fix.
- `node scripts/check-server-type-baseline.mjs`: exit 0, exact 319-diagnostic
  TypeScript 5.9.3 baseline matched.
- Targeted ESLint for the resume and edge envelope files: exit 0.
- `git diff --check`: exit 0.

## Independent-review ledger

| Finding | Current disposition |
| --- | --- |
| Valid no-turn resume rejects the edge's carried V1 hash | Fixed locally and regression-proven 13/13. |
| New TS7022 raises the server baseline from 319 to 320 | Fixed locally; exact baseline is 319 again. |
| Envelope success response exposes an extra internal `ok` field | Fixed in the preserved patch with an exact-object assertion; Worker runtime proof remains pending. |
| Movement/turn divergence returns 422 without durable evidence | Fixed in the preserved patch with bounded SQL evidence and a ledger assertion; Worker runtime proof remains pending. |
| `shadowEvidenceDegraded` is volatile across restart | Open P1. The next source slice must add a bounded durable pre-mutation poison/preparation marker and restart/fault coverage. |
| The documented 32 MiB/domain ceiling ignores the 20 KiB envelope ceiling | Open P2. Correct the enforced worst-case accounting or tighten the protocol ceiling with compatibility proof. |
| New Durable Object name includes `:r1:` | External adoption proof remains required before any deployment if an earlier namespace may exist. |

The independent reviewer verdict therefore remains `FIX`; PR #2 must remain
draft. Hosted metadata, Worker-runtime execution, physical runtime QA, and
GitHub-rendered screenshot/video evidence are not proven by this checkpoint.

## Exact resume command

Run only the focused resume regression first:

```sh
/Users/romanmondello/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node \
  scripts/run-tests-isolated.mjs server/shadow-catchup.test.ts
```

Then reproduce the still-open restart-latch P1 in isolated temporary data before
editing `server/origin-journal.ts`, `server/world.ts`, or their focused tests.
