#!/usr/bin/env node
// ============================================================
//  patch-epipe.js — Prepend EPIPE error handler to main bundle
//
//  Prevents "Error: write EPIPE" crash when running as AppImage
//  or in any environment where stdout/stderr are not connected
//  to a terminal (broken pipe on console.info/log/warn/error).
//
//  Usage:
//    node scripts/patch-epipe.js           # execute patch
//    node scripts/patch-epipe.js --check   # dry-run check only
// ============================================================

const fs = require("fs");
const path = require("path");

const EPIPE_HANDLER =
  'process.stdout?.on?.("error",function(e){if(e.code==="EPIPE")return;throw e});' +
  'process.stderr?.on?.("error",function(e){if(e.code==="EPIPE")return;throw e});';

function locateBundle() {
  const buildDir = path.join(__dirname, "..", "src", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.error("❌ Build directory not found:", buildDir);
    process.exit(1);
  }
  const files = fs.readdirSync(buildDir);
  const mainFile = files.find(f => /^main(-[^.]+)?\.js$/.test(f));
  if (!mainFile) {
    console.error("❌ Main bundle (main*.js) not found");
    process.exit(1);
  }
  return path.join(buildDir, mainFile);
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const src = fs.readFileSync(bundlePath, "utf-8");

  if (src.includes('process.stdout?.on?.("error"')) {
    console.log("✅ EPIPE handler already present — skipping");
    return;
  }

  console.log(`📄 Bundle: ${path.basename(bundlePath)}`);

  if (checkOnly) {
    console.log("🔍 [CHECK] EPIPE handler not yet present — would patch");
    return;
  }

  // Insert handler right after "use strict"; (or at the very start)
  let patched;
  if (src.startsWith('"use strict";')) {
    patched = '"use strict";' + EPIPE_HANDLER + src.slice('"use strict";'.length);
  } else {
    patched = EPIPE_HANDLER + src;
  }

  fs.writeFileSync(bundlePath, patched, "utf-8");
  console.log("✅ EPIPE handler injected successfully");
}

main();
