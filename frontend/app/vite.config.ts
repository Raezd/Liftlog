import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The version shown on the page: the short git hash, passed in by Compose as
// BUILD_ID or read from git locally. Without either (a plain Docker build),
// a hash of the source, so every distinct build still gets its own id.
function sourceHash(dir: string, h = createHash("sha1")) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceHash(p, h); else h.update(name).update(readFileSync(p));
  }
  return h;
}
function buildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID.slice(0, 12);
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return `src-${sourceHash("src").digest("hex").slice(0, 7)}`; }
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [react(), tailwindcss()],
  build: { target: "es2022", sourcemap: false },
});
