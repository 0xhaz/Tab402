import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    // Whole-system tests make hundreds of paid calls.
    testTimeout: 60_000,
    // Shares the tab402_test database with packages/db; turbo runs this after db tests (see turbo.json).
    fileParallelism: false,
  },
});
