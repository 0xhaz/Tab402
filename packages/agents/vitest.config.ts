import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    // Integration tests share one test database; run files one at a time.
    fileParallelism: false,
  },
});
