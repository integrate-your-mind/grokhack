# Movement journal resource-exhaustion fix — local CI receipt

Timestamp: `2026-07-13T05:38:08Z`

This receipt binds the movement-journal hardening diff to the workflow-faithful
local proof completed before publication. It is not a merge, deployment,
production-adoption, or 99.99% uptime claim.

## Exact pre-commit state

- Repository: `/Users/romanmondello/grok-build`
- Branch: `codex/movement-shadow-parity`
- Starting/local HEAD: `51512128b91680ad3d8cfa6304922aea198a8e9f`
- Proven source implementation commit:
  `906ea50959c18e64a5b4920065a0de75987ffc39`
- Remote branch SHA before publication: `51512128b91680ad3d8cfa6304922aea198a8e9f`
- Base/default branch: `origin/main` at
  `596d1b5bd06500e5cd38f9f3e3097280a7ccce6d`
- Pull request: draft PR #2, <https://github.com/integrate-your-mind/grokhack/pull/2>
- Owned source diff: five tracked files plus this receipt; no unrelated or
  untracked file was present.
- Pre-receipt binary diff SHA-256:
  `e59c371bc6cc926af95f46d5b76e29ab5bf8e64442000444379ac5ef863f914c`
- Versionable source-state SHA-256 (tracked source excluding proof receipts,
  dependencies, data, coverage, and generated build output):
  `4d7d986559fcfa48f2398bc36f3ca9aeff4d1600b364af1538eb553ad2d7a322`
- Final generated browser/Worker/MCP artifact-manifest SHA-256:
  `d4a65e66e71793cb6743831c01a7acef7afb0f5ca67e1d63577e6f58bccf1867`

Key file hashes:

- `server/origin-journal.ts`:
  `4bce0cca5184691e833a27339b8efb336f6042a3a54520d8abb5189c8a82aff2`
- `server/origin-journal.test.ts`:
  `37d68c024ad532b0e3066af0a7e5921b3fa503961e7dadefc063cff3fc8bd79d`
- `server/world.ts`:
  `2a93cf588db7fb295a97fd16947ed657f4e5fcf91a08687f42e5aee84c7d4745`
- `server/world-movement-shadow.test.ts`:
  `f9f7df57586f4365590a4513e65d84e1fe9e0002ae88e53e3de8d4fabecfad50`
- `docs/edge-migration-plan.md`:
  `3fcb94335b3b585c25170fee4eb19614765468507d5702017b4596ed3d712585`

## Change and security outcome

- V1 and V2 canonical evidence now have separate origin-wide 4,096-entry
  ceilings and an 8 KiB serialized-entry ceiling.
- Appends write only the new JSONL record plus one commit byte instead of
  rewriting the accumulated segment.
- V2 evidence is isolated under `movement-v2`; bounded fixed probes replace
  unrelated directory scans.
- A single-writer owner and recoverable hard-link claim reject live competing
  writers, recover dead reclaimers, and compare process-start identity to avoid
  PID-reuse lock pinning where the platform can prove it.
- Readers consume only committed prefixes. The odd write-sequence token is
  fsynced before evidence mutation, even is published only after durable commit
  or successful recovery, and paged readers rebuild heads inside one stable
  sequence snapshot.
- Capacity is non-authoritative shadow backpressure: origin gameplay continues
  and logs once per full domain; corruption, continuity, and real I/O failures
  remain fail-closed.

The original isolated attack harness previously retained 129 V2 plus 129 V1
entries while rewriting 4,445,121 bytes. Against this diff it retained the same
258 entries, wrote 138,149 bytes, and rolled over three bounded segments in each
domain. Configurable-ceiling regressions also prove saturation across streams
and restart without further filesystem work. An independent final adversarial
review found no remaining reproducible P1/P2 in the scoped journal paths.

## Workflow-faithful local gate

Toolchain:

- Node: `v22.23.1`
- npm: `10.9.4`
- tmux fixture: `3.6a`
- Clean installs: `npm ci`, `npm ci --prefix edge`, and
  `npm ci --prefix mcp` all exited 0.

Every following command exited 0 on the exact five-file source state above:

```bash
npm audit --omit=dev --audit-level=moderate
npm audit --omit=dev --audit-level=moderate --prefix edge
npm audit --omit=dev --audit-level=moderate --prefix mcp
npm run lint
npm run test:coverage
npm test -- --sequence.shuffle --sequence.seed=20260710
npm run test:property
npm run test:shadow-e2e
npm run build
npm run check:server-types
npm run edge:verify
npm --prefix mcp run build
```

Results:

- All three production dependency audits: zero known vulnerabilities.
- Root coverage: 56 files and 652 tests passed; 71.11% statements, 65.17%
  branches, 79.54% functions, and 73.24% lines.
- Deterministic shuffled root run: 56 files and 652 tests passed with seed
  `20260710`.
- Journal/catch-up property selection: 3 files and 52 tests passed.
- Mixed origin-to-local-Worker proof: checkpoint 396; 332 accepted entries; 64
  response-loss duplicates; terminal parity; state, event, and continuity
  divergence all failed visibly with HTTP 422.
- Browser production build passed; output was 115.75 KiB JavaScript
  (38.85 KiB gzip).
- Exact server TypeScript debt remained 319 diagnostics and did not grow.
- Edge coverage: 9 files and 93 tests passed; 82.17% statements, 77.09%
  branches, 96.10% functions, and 84.80% lines.
- Edge shuffle: 93/93 passed. Seeded property selection: 4 passed and 18
  intentionally skipped by selector. Development, staging, and production
  Wrangler dry-run builds passed.
- MCP TypeScript build passed.
- `git diff --check` passed.

## Isolated physical runtime QA

A real Node 22 server was booted on `127.0.0.1:18080` with a fresh temporary
DuckDB and data root, IRC/Discord disabled, and Telnet disabled. `/health`
returned ready with zero initial users. The human WebSocket path passed welcome,
join, state, movement/wait/inventory, chat, wall post, friend failure response,
ping/pong, and `:who` checks.

The repository `scripts/qa-play.mjs` command exited 1 at 14/15 because its second
socket installs the `welcome` listener only after the socket has opened. That
pre-existing harness race was reproduced: a queue-before-open probe on the same
server passed agent welcome, join, 16 valid actions, movement, and chat with exit
0. No production endpoint or data was used. The isolated server was then
gracefully drained and its temporary data removed.

## Hosted and production state

- GitHub Actions run `29217023858` executed zero repository steps. GitHub says
  the job did not start because the account is locked due to a billing issue;
  it is not code evidence.
- At the final read-only live check, `https://grokhack.mondello.dev/api/presence`
  reported exactly two online/on-map agents: `GrokBotcsyzg1` and
  `GrokBotcsyzg2`. The supervised project process `node scripts/agent-bot.mjs`
  owned exactly two established localhost WebSocket connections and its log
  named those bots. No human player was online in that snapshot.
- This branch is not deployed. The current production server remains on the
  older live source. No server/tunnel/bot restart, Worker deployment, route or
  DNS change, traffic change, production-data mutation, merge, or release was
  performed.

## Remaining production-readiness gaps

- V2 movement plus its V1 vitals follow-up is still not a transactional outbox;
  process loss between the two durable records can create a ghost/prepared
  decision. That correctness gap remains before authority transfer.
- Combat, monster AI, item/trap/room effects, authoritative position, complete
  transfers, Queue/DLQ/archive, restore drills, external load/fault proof, staged
  rollout, and measured 99.99% SLO evidence remain separate roadmap work.
- PR #2 therefore remains draft and unmerged even after this branch push.
