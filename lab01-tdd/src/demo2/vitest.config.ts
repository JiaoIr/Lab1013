import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Config for the demo2 generated tests. Its root is src/demo2 so that the
// generated suite is isolated from the course suites declared in the
// project-root vitest.config.ts.
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    include: ["generated/**/*.test.ts"],
  },
});
