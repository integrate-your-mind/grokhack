#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "server", "tsconfig.json");
const baselinePath = path.join(root, "server", "typecheck-baseline.json");

function readDiagnostics() {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"),
    );
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const position =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
    return {
      code: diagnostic.code,
      file: diagnostic.file
        ? path.relative(root, diagnostic.file.fileName).split(path.sep).join("/")
        : null,
      line: position ? position.line + 1 : null,
      column: position ? position.character + 1 : null,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
  });
}

function sorted(records) {
  return [...records].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

const current = {
  typescriptVersion: ts.version,
  tsconfig: "server/tsconfig.json",
  diagnostics: sorted(readDiagnostics()),
};

if (process.argv.includes("--print-baseline")) {
  const diagnostics = current.diagnostics.map((record) => `    ${JSON.stringify(record)}`).join(",\n");
  process.stdout.write(
    `{\n  "typescriptVersion": ${JSON.stringify(current.typescriptVersion)},\n  "tsconfig": ${JSON.stringify(current.tsconfig)},\n  "diagnostics": [\n${diagnostics}\n  ]\n}\n`,
  );
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error("Missing server/typecheck-baseline.json; review and add an explicit baseline.");
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const expectedText = JSON.stringify(baseline);
const currentText = JSON.stringify(current);
if (expectedText === currentText) {
  console.log(
    `[server-types] exact baseline matched: ${current.diagnostics.length} diagnostics (TypeScript ${ts.version})`,
  );
  process.exit(0);
}

const expectedRows = new Map(
  (baseline.diagnostics ?? []).map((record) => [JSON.stringify(record), record]),
);
const currentRows = new Map(current.diagnostics.map((record) => [JSON.stringify(record), record]));
const added = [...currentRows].filter(([key]) => !expectedRows.has(key)).map(([, value]) => value);
const removed = [...expectedRows].filter(([key]) => !currentRows.has(key)).map(([, value]) => value);
console.error(
  `[server-types] baseline mismatch: expected ${baseline.diagnostics?.length ?? 0}, received ${current.diagnostics.length}; added ${added.length}, removed ${removed.length}`,
);
for (const [label, records] of [
  ["ADDED", added],
  ["REMOVED", removed],
]) {
  for (const record of records.slice(0, 20)) {
    console.error(
      `${label} ${record.file ?? "<global>"}:${record.line ?? 0}:${record.column ?? 0} TS${record.code} ${record.message}`,
    );
  }
  if (records.length > 20) console.error(`${label} ... ${records.length - 20} more`);
}
console.error("If the diagnostic change is intentional, regenerate and review the baseline explicitly.");
process.exit(1);
