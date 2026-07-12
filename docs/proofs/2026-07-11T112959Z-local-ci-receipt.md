# Local CI-equivalent proof receipt — 2026-07-11T11:29:59Z

This receipt is evidence for direct execution on the trusted local checkout. It is not a claim that GitHub Actions ran, that the dirty worktree is represented by the commit, or that anything was deployed.

## Identity and environment

- Git commit: `f4843762cd8a9088b7f66f9f38e6fe4da2ec92cc`
- Worktree: dirty; the commit alone does not identify the tested source, so relevant file hashes are recorded below.
- Host: Apple arm64, Darwin 25.5.0, macOS 26.5 (25F71)
- Node used by these commands: `v26.3.0`
- npm: `11.16.0`
- Git: `2.52.0`
- Cloudflare Workers types retrieved: `5.20260711.1`
- Wrangler pinned by the edge package: `4.110.0`

## Commands and results

All commands ran from `/Users/romanmondello/grok-build` against trusted local code.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npm test -- src/gameplay-reducer.test.ts` | 0 | 1 file, 4 tests passed in isolated sandbox |
| `npm --prefix edge run verify` | 0 | types current; 30 tests passed; shuffled pass; development/staging/production dry-run bundles passed |
| `npm run lint` | 0 | zero warnings allowed |
| `npm run build` | 0 | TypeScript and Vite production build passed |
| `npm run check:server-types` | 0 | exact known baseline matched: 319 diagnostics |
| `npm test` | 0 | 48 files, 551 tests passed in isolated sandbox |
| `npm run test:coverage` | 0 | 48 files, 551 tests; 67.31% statements, 60.67% branches, 76.17% functions, 69.12% lines |

Edge coverage from `edge:verify`: 81.97% statements, 76.78% branches, 96.77% functions, 84.07% lines.

## Relevant artifact hashes (SHA-256)

```text
4f55078ec3f822a169981e78e4b56a24ae8c5cbfa76a624cd297b61f8d7572e4  src/gameplay-reducer.ts
8439b8e2c225f767b4773483268658faa61e4902ac308d824e18fa61d5a71891  src/gameplay-reducer.test.ts
cb187f81f215e8bc47cb1f203409579e547dd67826097a09e6ac7cf059848bf4  server/world.ts
08a294156009616e40f2e971bf2f99154a4d5f1c88b966e4d1f0c3fba1659443  edge/src/floor-instance.ts
28e87464caf2b5094a9c8f782f5bdbc7fdeb09a0f0fc39695bf34df350306a2c  edge/test/worker.test.ts
75b9e592f8cdc51520e1f336554ac23518433b156af7d2c9b9099652fc3c6793  package-lock.json
1ee8643958028c97d777c13646dc0863c8842d8354d4efae8702085458977cc3  edge/package-lock.json
9b9bd7cad289e27e79232d2d29e0f8967c83d78f98bcd71f2aa8e1c11261890e  .github/workflows/ci.yml
```

## Honest gaps

- The workflow requests Node 22 on Ubuntu; this receipt used Node 26 on macOS. Earlier Node 22 parity evidence is not reasserted as part of this exact receipt.
- This checkpoint did not rerun clean `npm ci`, production dependency audits, the root shuffled suite, or the MCP build.
- GitHub Actions did not run and remains optional publication evidence.
- No commit, branch, PR, deployment, traffic change, restart, production-data mutation, load test, failover drill, or restore drill was performed.
- The public and local health endpoints still expose the old running release schema with two users online; the tested source has not been adopted by the live process.
