import fs from "node:fs";
import path from "node:path";

const sandboxRoot = process.env.GROKHACK_TEST_DATA_ROOT?.trim();
const sentinel = process.env.GROKHACK_TEST_SANDBOX_SENTINEL?.trim();
const nonce = process.env.GROKHACK_TEST_SANDBOX_NONCE?.trim();
if (
  process.env.GROKHACK_TEST_ISOLATED !== "1" ||
  !sandboxRoot ||
  !sentinel ||
  !nonce ||
  !fs.existsSync(sentinel) ||
  fs.readFileSync(sentinel, "utf8") !== nonce
) {
  throw new Error(
    "Refusing to run tests against repository data. Use `npm test` to create an isolated sandbox."
  );
}

const sandboxDir = path.dirname(path.resolve(sentinel));
const resolvedDataRoot = path.resolve(sandboxRoot);
const relativeDataRoot = path.relative(sandboxDir, resolvedDataRoot);
if (relativeDataRoot.startsWith("..") || path.isAbsolute(relativeDataRoot)) {
  throw new Error("Test data root escaped the verified sandbox");
}

// A fork handles one test file at a time. A unique leaf prevents late timers or
// native handles from a previous file from writing into the next file's store.
const workerId = `${process.env.VITEST_POOL_ID ?? "pool"}-${process.pid}`;
const workerRoot = path.join(resolvedDataRoot, workerId);
fs.mkdirSync(workerRoot, { recursive: true });
process.env.GROKHACK_DATA_DIR = fs.mkdtempSync(path.join(workerRoot, "file-"));
