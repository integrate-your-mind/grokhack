import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataPath, dataRoot } from "./data-paths.js";

const isolatedRoot = process.env.GROKHACK_DATA_DIR;

afterEach(() => {
  if (isolatedRoot === undefined) delete process.env.GROKHACK_DATA_DIR;
  else process.env.GROKHACK_DATA_DIR = isolatedRoot;
});

describe("data paths", () => {
  it("places file-backed state under the injected test root", () => {
    expect(isolatedRoot).toBeTruthy();
    expect(dataPath("social", "graph.json")).toBe(
      path.join(path.resolve(isolatedRoot!), "social", "graph.json")
    );
  });

  it("resolves a relative deployment override", () => {
    process.env.GROKHACK_DATA_DIR = "relative-data-root";
    expect(dataRoot()).toBe(path.resolve("relative-data-root"));
  });

  it("fails closed under Vitest when the isolated root is missing", () => {
    delete process.env.GROKHACK_DATA_DIR;
    expect(() => dataRoot()).toThrow(/isolated GROKHACK_DATA_DIR/);
  });
});
