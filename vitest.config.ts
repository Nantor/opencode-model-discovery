import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    // Keep the bundled snapshot fallback enabled in tests so the default
    // behavior matches the full (fallback) build. The slim build is produced
    // by esbuild with BUILD_SNAPSHOT=false and is not exercised by vitest.
    BUILD_SNAPSHOT: "true",
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
