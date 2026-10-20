import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  entryPoints: ["src/index.ts"],
  logLevel: "info",
};

const variants = [
  { define: { BUILD_SNAPSHOT: "true" }, outfile: "dist/opencode-model-discovery.js" },
  { define: { BUILD_SNAPSHOT: "false" }, outfile: "dist/opencode-model-discovery-slim.js" },
];

const only = process.argv
  .filter((arg) => arg.startsWith("--variant="))
  .map((arg) => arg.split("=")[1]);

const selected = only.length > 0
  ? variants.filter((variant) => only.includes(variant.define.BUILD_SNAPSHOT === "true" ? "fallback" : "slim"))
  : variants;

await Promise.all(selected.map((variant) => build({ ...shared, ...variant })));
