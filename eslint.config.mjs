import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/coverage/**",
      "**/dist/**",
      "**/dist-*/**",
      "**/*.d.ts",
      "data/**",
      ".gstack/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Existing TypeScript debt is tracked exactly by check:server-types.
      // Keep this gate focused on control-flow and syntax correctness.
      "no-undef": "off",
      "no-unused-vars": "off",
      // Control-code stripping is intentional in IRC, terminal, and input sanitizers.
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
