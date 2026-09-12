import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The Postgres-backed suite is opt-in via `npm run test:db`.
    exclude: ["tests/db/**", "node_modules/**"],
  },
});
