# Local CI-equivalent proof receipt — 2026-07-11T11:42:09Z

Trusted local execution only. No hosted CI, deployment, restart, traffic change, or live-data mutation occurred.

## Identity

- Git commit: `f4843762cd8a9088b7f66f9f38e6fe4da2ec92cc`
- Worktree: dirty; hashes below identify the tested source.
- Host/toolchain: Apple arm64; macOS 26.5 (25F71); Node `v26.3.0`; npm `11.16.0`; Wrangler `4.110.0`; Workers types `5.20260711.1`.

## Canonical local gate

| Command | Exit | Result |
| --- | ---: | --- |
| root/edge/MCP production dependency audits | 0 | zero vulnerabilities |
| `npm run lint` | 0 | zero warnings allowed |
| `npm run test:coverage` | 0 | 48 files, 558 tests; 67.30% statements, 60.68% branches, 76.28% functions, 69.17% lines |
| root deterministic shuffled suite | 0 | 48 files, 558 tests |
| `npm run build` | 0 | TypeScript and Vite production build passed |
| `npm run check:server-types` | 0 | exact known 319-diagnostic baseline |
| `npm run edge:verify` | 0 | 30 tests; 82.03% statements; shuffled pass; development/staging/production dry-run bundles passed |
| MCP TypeScript build | 0 | passed |

This slice adds deterministic cross-runtime state fingerprints, exact-step trace drift detection, fingerprints in edge acknowledgements, replay-stable duplicate responses, and terminal-state sequence fencing.

## SHA-256 artifacts

```text
14d1b5ee93963c96a3c7286a17a89f1d4c7a600a4e5ce457640c8d95dad8fd3e  src/gameplay-reducer.ts
001d616606a71e1f7c2406fe4dd79b06d7d5d5d2c08edc72fcb34fac5fadd225  src/gameplay-reducer.test.ts
95c24bb8fe7c47dedfe458380a9930d32d5a0b8fb04f8778f514949cb086fad5  server/world.ts
335106ea13821362c39a5ff5f8d70fe0b2676a4a71a0a21470c994ea6900dd45  edge/src/floor-instance.ts
b58fd58571ff89e4c5e477bcff97b8eb66f92912c26d5057bac27dca285b50de  edge/test/worker.test.ts
75b9e592f8cdc51520e1f336554ac23518433b156af7d2c9b9099652fc3c6793  package-lock.json
1ee8643958028c97d777c13646dc0863c8842d8354d4efae8702085458977cc3  edge/package-lock.json
213c07adba4d1bd1aeb6157a03cf8c04bf15bfd6eaafb202ff6d77f6b95e1240  mcp/package-lock.json
9b9bd7cad289e27e79232d2d29e0f8967c83d78f98bcd71f2aa8e1c11261890e  .github/workflows/ci.yml
```

## Honest gaps

- Exact receipt ran on Node 26/macOS, while hosted workflow declares Node 22/Ubuntu; clean locked installs were not rerun.
- This is deterministic trace infrastructure, not yet immutable origin journal ingestion or bulk shadow catch-up.
- Movement/combat parity, transfer/takeover, allocator/outbox, load/fault proof, restore drills, and production adoption remain unfinished.
- Local and public endpoints still served the old release with two users online.
