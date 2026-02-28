#!/usr/bin/env node
// ============================================================
//  patch-devtools.js — AST 补丁：强制启用 DevTools & InspectElement
//
//  策略：
//    在 main bundle 中查找 Property 节点:
//    - allowInspectElement: <Identifier>  →  allowInspectElement: !0
//    - devTools: <MemberExpression>       →  devTools: !0
//
//  用法：
//    node scripts/patch-devtools.js           # 执行 patch
//    node scripts/patch-devtools.js --check   # 仅检查匹配
// ============================================================

const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

// ─── 1. 定位 main bundle ─────────────────────────────────
function locateBundle() {
  const buildDir = path.join(__dirname, "..", "src", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.error("❌ 构建目录不存在:", buildDir);
    process.exit(1);
  }
  const files = fs.readdirSync(buildDir);
  // 优先带 hash 的 main-{hash}.js，回退到 main.js
  const mainFile = files.find(f => /^main(-[^.]+)?\.js$/.test(f));
  if (!mainFile) {
    console.error("❌ 未找到 main bundle (main*.js)");
    process.exit(1);
  }
  return path.join(buildDir, mainFile);
}

// ─── 2. AST 引擎 ─────────────────────────────────────────
function walkAST(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(c => walkAST(c, visitor));
    } else if (child && typeof child === "object" && child.type) {
      walkAST(child, visitor);
    }
  }
}

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

// ─── 3. 声明式规则 ────────────────────────────────────────
const RULES = [
  {
    id: "allowInspectElement",
    description: "allowInspectElement: <value> → allowInspectElement: !0",
    match(node, source) {
      if (node.type !== "Property") return null;
      if (getPropertyName(node.key) !== "allowInspectElement") return null;

      const val = node.value;
      // 跳过已经是 !0 的
      const valSrc = source.slice(val.start, val.end);
      if (valSrc === "!0") return null;

      // 跳过函数参数定义（key 和 value 是同一个 Identifier 节点，即解构简写）
      if (node.shorthand) return null;

      return {
        start: val.start,
        end: val.end,
        replacement: "!0",
        original: valSrc,
      };
    },
  },
  {
    id: "devTools",
    description: "devTools: this.options.allowDevtools → devTools: !0",
    match(node, source) {
      if (node.type !== "Property") return null;
      if (getPropertyName(node.key) !== "devTools") return null;

      const val = node.value;
      const valSrc = source.slice(val.start, val.end);
      if (valSrc === "!0") return null;

      // 只匹配 devTools 在 webPreferences 上下文中的用法（值引用 allowDevtools）
      if (!valSrc.includes("allowDevtools") && !valSrc.includes("allowDevTools")) return null;

      return {
        start: val.start,
        end: val.end,
        replacement: "!0",
        original: valSrc,
      };
    },
  },
];

// ─── 4. 主流程 ────────────────────────────────────────────
function main() {
  const isCheck = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const source = fs.readFileSync(bundlePath, "utf-8");

  console.log(`📄 目标文件: ${path.relative(process.cwd(), bundlePath)}`);
  console.log(`📏 文件大小: ${(source.length / 1048576).toFixed(1)} MB`);

  const t0 = Date.now();
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  console.log(`🔍 AST 解析: ${Date.now() - t0}ms`);

  // 收集 patches
  const patches = [];
  const seen = new Set();

  walkAST(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (!result) continue;
      const key = `${result.start}:${result.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      patches.push({ ...result, rule: rule.id, description: rule.description });
    }
  });

  if (patches.length === 0) {
    console.log("\n✅ 无需修改（DevTools 已处于启用状态）");
    return;
  }

  // 按 start 降序排列（从后往前替换，避免偏移漂移）
  patches.sort((a, b) => b.start - a.start);

  if (isCheck) {
    console.log(`\n🔎 匹配报告: ${patches.length} 处`);
    for (const p of [...patches].reverse()) {
      console.log(`  📍 [${p.rule}] 位置 ${p.start}: ${p.original} → ${p.replacement}`);
    }
    return;
  }

  // 执行替换
  let patched = source;
  for (const p of patches) {
    console.log(`  ✏️  [${p.rule}] 位置 ${p.start}: ${p.original} → ${p.replacement}`);
    patched = patched.slice(0, p.start) + p.replacement + patched.slice(p.end);
  }

  fs.writeFileSync(bundlePath, patched, "utf-8");
  console.log(`\n✅ DevTools 已强制启用: ${patches.length} 处修改`);
}

main();
