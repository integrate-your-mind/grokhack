# Movement shadow parity checkpoint — 2026-07-12T23:22:05Z

This is a resumable checkpoint, not a release receipt. It preserves the exact
branch and proof state while the full Node 22 test/build gate is deliberately
paused. It does not claim that the Cloudflare Worker is deployed, authoritative,
or receiving production traffic.

## Exact source identity

- Repository: `/Users/romanmondello/grok-build`
- Branch: `codex/movement-shadow-parity`
- Commit: `0a9a6344fe451d0ce3b2c610bad482ae704f7d25`
- Base: `596d1b5bd06500e5cd38f9f3e3097280a7ccce6d`
- Remote ref: `origin/codex/movement-shadow-parity` matched the commit above.
- Pull request: <https://github.com/integrate-your-mind/grokhack/pull/2>
- Worktree before this receipt: clean.
- Exact versionable source-state SHA-256: `9989a68bf16951162031b1bb54b7275485c3a30ba7055725afa7ab3434506c9d`
- Source manifest: 240 tracked files, excluding `data/`, proof receipts,
  generated build/coverage output, dependency directories and `.gstack/`.

Reproduction command:

```bash
files=$(git ls-files | LC_ALL=C sort | \
  rg -v '^(data/|docs/proofs/|dist/|edge/dist/|coverage/|edge/coverage/|node_modules/|edge/node_modules/|mcp/node_modules/|\.gstack/)')
printf '%s\n' "$files" | while IFS= read -r file; do
  test -f "$file" && shasum -a 256 "$file"
done | shasum -a 256
```

## Completed implementation

- One deterministic shared movement reducer now models direction, coordinate
  safety, bounds, terrain, doors, occupancy/combat intent, pickups, traps, room
  intent, transfers, turn cost and visibility events.
- The Node origin records a V2 movement-decision entry before mutating gameplay
  state and retains the existing V1 vitals follow-up for turn-consuming moves.
- Movement streams are floor-scoped and authority is fenced by realm, floor
  instance, depth, floor epoch and ruleset version.
- The immutable origin journal handles short writes, zero writes, temp-file
  fsync failure and directory-fsync acknowledgement loss without replacing a
  known-good canonical segment incorrectly.
- The Worker shadow validates V1/V2 mixed chains, state and behavioral-event
  hashes, route authority, schema upgrades and real legacy nonzero checkpoints.
- Duplicate/no-op evidence is permanently bounded to 64 distinct fingerprints
  per player and process; cycling fingerprints cannot restore unlimited fsyncs.
- The mixed-runtime proof driver covers 300 V1 and 96 V2 entries, including 64
  response-loss duplicates and both state and event divergence.

## Evidence already obtained

Earlier branch heads passed focused reducer, origin, Worker shadow, property and
mixed E2E checks; the browser build, lint, Worker check and exact 319-diagnostic
server baseline were also exercised. An independent adversarial review found
ruleset, migration, short-write, fsync and no-op-budget gaps; all were fixed in
`28d281b491c4b91e22edf88bae4ef0ba6ba08981` and
`0a9a6344fe451d0ce3b2c610bad482ae704f7d25`.

That predecessor evidence is useful defect evidence but is **not** presented as
an exact-head green gate. The current commit still requires the complete
canonical gate below.

A lightweight exact-head review on 2026-07-12 confirmed:

- `git diff --check 596d1b5..HEAD` exited 0;
- the worktree and remote branch matched before this receipt;
- a diff credential scan found only explicit local test fixtures and documented
  secret/config names, not credential material;
- cached Node `v22.23.1` and npm `10.9.4` runtimes are present locally;
- PR 2 has no review comments or overlapping review work.

## Hosted CI state

GitHub Actions run `29213185045` created a zero-step failed check for this exact
commit. Its complete annotation is:

> The job was not started because your account is locked due to a billing issue.

No repository command ran in that check. Hosted Actions is therefore neither
positive nor negative code evidence; the repository's canonical local gate is
the required proof surface.

## Exact resume commands

Do not use `npx` or download another runtime. The cached toolchain is:

```bash
cd /Users/romanmondello/grok-build
NODE22=/Users/romanmondello/.npm/_npx/17355f44438e6c6e/node_modules/node/bin/node
NPM10=/Users/romanmondello/.npm/_npx/4b0cc92362cfffad/node_modules/npm/bin/npm-cli.js
```

Once the paused test/build constraint is cleared, run the exact-head gate:

```bash
"$NODE22" "$NPM10" audit --omit=dev --audit-level=moderate
"$NODE22" "$NPM10" --prefix edge audit --omit=dev --audit-level=moderate
"$NODE22" "$NPM10" --prefix mcp audit --omit=dev --audit-level=moderate
"$NODE22" "$NPM10" run lint
"$NODE22" "$NPM10" run test:coverage
"$NODE22" "$NPM10" test -- --sequence.shuffle --sequence.seed=20260710
"$NODE22" "$NPM10" run test:property
"$NODE22" "$NPM10" run test:shadow-e2e
"$NODE22" "$NPM10" run build
"$NODE22" "$NPM10" run check:server-types
"$NODE22" "$NPM10" run edge:verify
"$NODE22" "$NPM10" --prefix mcp run build
git diff --check 596d1b5..HEAD
```

The raw `build:server` command is not a green release gate; the repository pins
its known 319-diagnostic debt with `check:server-types` so the baseline cannot
grow silently.

## Honest remaining gaps

- Exact-head coverage, shuffle, property, E2E, build, audit, Worker dry-run and
  MCP build proof remain pending.
- A sealed exact-head security scan remains pending; manual adversarial review
  is not a substitute for that final gate.
- V2 movement and its subsequent V1 vitals record are not one atomic command.
  A process loss after the first durable record can leave a prepared/ghost
  decision. Transactional outbox or prepared/committed semantics remain P0.
- Movement effects are still origin-authoritative. Combat resolution, monster
  AI, item mutation, trap/room effects, durable position and complete transfer
  effects have not reached shared reducer parity.
- No Worker deployment, route change, production-data mutation, external load
  test, restore drill or 99.99% SLO evidence occurred in this milestone.

