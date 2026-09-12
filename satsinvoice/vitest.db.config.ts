import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

loadEnv({ path: ".env", quiet: true });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. These tests write to a real Postgres database — " +
      "point it at a throwaway one (see .env.example). Run `npm test` for the suite that needs no database.",
  );
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    // The suite shares one database; running files in parallel would let them
    // truncate each other's rows mid-test.
    fileParallelism: false,
    env: { DATABASE_URL: testDatabaseUrl },
  },
});
