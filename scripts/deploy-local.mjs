import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// Deploy the built plugin into the local OpenCode plugins directory.
//
// Usage:
//   npm run deploy:local                 # default: slim variant
//   npm run deploy:local -- --variant=slim
//   npm run deploy:local -- --variant=fallback
//
// The variant selects which dist artifact is copied; the plugin is always
// built first.

const variantArg = process.argv.find((arg) => arg.startsWith("--variant="));
const variant = variantArg?.split("=")[1];
if (variant !== undefined && variant !== "slim" && variant !== "fallback") {
  console.error(`Unknown variant "${variant}". Expected "slim" or "fallback".`);
  process.exit(1);
}
const isSlim = (variant ?? "slim") === "slim";
const artifact = isSlim
  ? "opencode-model-discovery-slim.js"
  : "opencode-model-discovery.js";

console.log(`Building plugin (${isSlim ? "slim" : "fallback"} variant)...`);
if (isSlim) {
  execFileSync("npm", ["run", "build:slim"], { stdio: "inherit" });
} else {
  execFileSync("npm", ["run", "build:fallback"], { stdio: "inherit" });
}

const pluginsDir = resolve(homedir(), ".config", "opencode", "plugins");
mkdirSync(pluginsDir, { recursive: true });

const source = resolve("dist", artifact);
if (!existsSync(source)) {
  console.error(`Expected built artifact missing: ${source}`);
  process.exit(1);
}
copyFileSync(source, resolve(pluginsDir, artifact));
console.log(`Deployed ${artifact} to ${pluginsDir}`);

console.log("Restarting opencode service...");
execFileSync("opencode", ["service", "restart"], { stdio: "inherit" });
