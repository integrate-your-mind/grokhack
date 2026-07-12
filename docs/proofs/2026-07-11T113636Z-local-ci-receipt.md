# Local CI-equivalent proof receipt — 2026-07-11T11:36:36Z

Trusted local execution only. No hosted CI, deployment, restart, traffic change, or live-data mutation occurred.

## Identity

- Git commit: `f4843762cd8a9088b7f66f9f38e6fe4da2ec92cc`
- Worktree: dirty; tested source is identified by the hashes below, not the commit alone.
- Host/toolchain: Apple arm64; macOS 26.5 (25F71); Node `v26.3.0`; npm `11.16.0`; Wrangler `4.110.0`; Workers types `5.20260711.1`.

## Canonical local gate

| Command | Exit | Result |
| --- | ---: | --- |
| root/edge/MCP `npm audit --omit=dev --audit-level=moderate` | 0 | zero vulnerabilities in all three packages |
| `npm run lint` | 0 | zero warnings allowed |
| `npm run test:coverage` | 0 | 48 files, 557 tests; 67.28% statements, 60.81% branches, 76.23% functions, 69.08% lines |
| `npm test -- --sequence.shuffle --sequence.seed=20260710` | 0 | 48 files, 557 shuffled tests passed |
| `npm run build` | 0 | TypeScript and Vite production build passed |
| `npm run check:server-types` | 0 | exact known baseline matched: 319 diagnostics |
| `npm run edge:verify` | 0 | 30 tests, shuffled pass, 81.98% statement coverage, all environment dry-run bundles passed |
| `npm --prefix mcp run build` | 0 | TypeScript build passed |

An initial coverage attempt exposed three reducer compatibility failures, which were reproduced and fixed. A later retry had one unrelated dungeon property test exceed its 5-second timeout by 341 ms under load; that test passed twice independently (normal and shuffled), and the complete coverage and shuffled suites then passed.

## SHA-256 artifacts

```text
ff86210d30cece831c0d33cef09a495d862f3cdb12f9de580eae67743a6e83a0  src/gameplay-reducer.ts
75e4da3ac50d2d1ad524f41a9c9f3906853d7d68669b2a4a975ff68c39d7a262  src/gameplay-reducer.test.ts
95c24bb8fe7c47dedfe458380a9930d32d5a0b8fb04f8778f514949cb086fad5  server/world.ts
c52e1e66249b1a1f97e7ba7c65fe14481f4063f1da2a927ee3bffc1f75f2cd55  edge/src/floor-instance.ts
1dc831c6ecad3cda2567d535efec168a2291132db525fbacdfe8224c14ed4c72  edge/test/worker.test.ts
75b9e592f8cdc51520e1f336554ac23518433b156af7d2c9b9099652fc3c6793  package-lock.json
1ee8643958028c97d777c13646dc0863c8842d8354d4efae8702085458977cc3  edge/package-lock.json
213c07adba4d1bd1aeb6157a03cf8c04bf15bfd6eaafb202ff6d77f6b95e1240  mcp/package-lock.json
9b9bd7cad289e27e79232d2d29e0f8967c83d78f98bcd71f2aa8e1c11261890e  .github/workflows/ci.yml
```

## Honest gaps

- The GitHub workflow specifies Node 22 on Ubuntu; this exact receipt used Node 26 on macOS.
- Locked clean installs were not rerun in this checkpoint.
- Hosted CI and PR evidence remain optional and unavailable for this dirty, uncommitted source state.
- Load/fault tests, transfer/takeover, allocator/outbox, shadow replay, restore drills, and production adoption remain unfinished.
- Local and public health remained on the old live release with two users online at receipt time.
