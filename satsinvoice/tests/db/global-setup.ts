import { execFileSync } from "node:child_process";

/** Brings the throwaway test database up to the current schema, once per run. */
export default function setup() {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
}
