import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    sequence: { setupFiles: "list" },
    setupFiles: ["./scripts/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts", "server/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/dist*/**"],
      thresholds: {
        statements: 65,
        branches: 58,
        functions: 73,
        lines: 66,
      },
    },
    exclude: [
      ...configDefaults.exclude,
      "dist/**",
      "dist-test/**",
      "server/dist-server/**",
      "edge/**",
    ],
  },
});
