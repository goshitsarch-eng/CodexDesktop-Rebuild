/**
 * 构建后补丁脚本：禁用 appSunset 强制更新拦截
 *
 * Codex 通过 Statsig gate "2929582856" 控制版本淘汰（sunset）。
 * 当 gate 返回 true 时，aUn 组件拦截整个 UI，显示 "Update Required" 全屏遮罩，
 * 阻止用户正常使用应用。
 *
 * 本脚本通过 AST 精确匹配，将 Cs("2929582856") gate 检查替换为 !1（false），
 * 使 sunset 守卫永远放行，渲染正常 children。
 *
 * 匹配模式：
 *   aUn 函数中 Cs(i) 调用 → Cs 为 Statsig useGateValue
 *   i 来自 memo cache 常量 "2929582856"
 *   将 Cs(i) 替换为 !1，短路整个 gate 检查
 *
 * 用法：
 *   node scripts/patch-sunset.js          # 执行 patch
 *   node scripts/patch-sunset.js --check  # 仅检查匹配情况
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

// ──────────────────────────────────────────────
//  AST 遍历
// ──────────────────────────────────────────────

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch 规则
// ──────────────────────────────────────────────

const SUNSET_GATE_ID = "2929582856";

const RULES = [
  {
    id: "disable_sunset_gate",
    description: `Cs(var) → !1  (gate "${SUNSET_GATE_ID}" 对应的 useGateValue 调用)`,
    /**
     * AST 匹配策略：
     *   在包含字符串常量 "2929582856" 的函数中，
     *   找到 Cs(identifier) 形式的 CallExpression，
     *   将整个调用替换为 !1
     *
     * 匹配条件：
     *   1. 函数体中存在 Literal "2929582856"
     *   2. 该函数体中存在 CallExpression: Cs(Identifier)
     *   3. Cs 是 Identifier（不是 MemberExpression）
     */
    match(node, source) {
      // 寻找包含 sunset gate ID 的函数体
      if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression" &&
          node.type !== "ArrowFunctionExpression") return null;

      const funcSrc = source.slice(node.start, node.end);

      // 快速预筛：函数体中必须包含 gate ID
      if (!funcSrc.includes(SUNSET_GATE_ID)) return null;

      // 在此函数的 AST 子树中找 Cs(xxx) 调用
      const patches = [];

      walk(node, (child) => {
        if (child.type !== "CallExpression") return;
        const callee = child.callee;
        if (!callee || callee.type !== "Identifier" || callee.name !== "Cs") return;

        // 确认参数是单个 Identifier（memo 缓存变量）
        if (child.arguments.length !== 1) return;

        const callSrc = source.slice(child.start, child.end);
        // 已被 patch 过
        if (callSrc === "!1") return;

        patches.push({
          start: child.start,
          end: child.end,
          replacement: "!1",
          original: callSrc,
        });
      });

      return patches.length > 0 ? patches : null;
    },
  },
];

// ──────────────────────────────────────────────
//  文件定位
// ──────────────────────────────────────────────

function locateBundle() {
  const assetsDir = path.join(__dirname, "..", "src", "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    console.error("❌ 资源目录不存在:", assetsDir);
    process.exit(1);
  }

  const files = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));

  if (files.length === 0) {
    console.error("❌ 未找到 index-*.js bundle 文件");
    process.exit(1);
  }
  if (files.length > 1) {
    console.error("❌ 发现多个 index-*.js 文件:", files.join(", "));
    process.exit(1);
  }

  return path.join(assetsDir, files[0]);
}

// ──────────────────────────────────────────────
//  主流程
// ──────────────────────────────────────────────

function main() {
  const isCheck = process.argv.includes("--check");
  const bundlePath = locateBundle();
  const relPath = path.relative(path.join(__dirname, ".."), bundlePath);

  console.log(`📄 目标文件: ${relPath}`);

  const source = fs.readFileSync(bundlePath, "utf-8");
  console.log(`📏 文件大小: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

  const t0 = Date.now();
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  console.log(`🔍 AST 解析: ${Date.now() - t0}ms`);

  // 收集所有 patches
  const allPatches = [];

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (result) {
        const items = Array.isArray(result) ? result : [result];
        for (const p of items) {
          if (!allPatches.some((x) => x.start === p.start)) {
            allPatches.push({ ...p, ruleId: rule.id, description: rule.description });
          }
        }
      }
    }
  });

  if (allPatches.length === 0) {
    console.log("\n✅ 无需修改（sunset gate 已禁用或未匹配）");
    return;
  }

  if (isCheck) {
    console.log(`\n🔎 匹配报告: ${allPatches.length} 处`);
    for (const p of allPatches) {
      console.log(`  📍 [${p.ruleId}] 位置 ${p.start}`);
      console.log(`     原始: ${p.original}`);
      console.log(`     替换: ${p.replacement}`);
    }
    return;
  }

  // 按 start 降序（从后往前替换）
  allPatches.sort((a, b) => b.start - a.start);

  let code = source;
  for (const p of allPatches) {
    console.log(`  ✏️  [${p.ruleId}] 位置 ${p.start}: ${p.original} → ${p.replacement}`);
    code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
  }

  fs.writeFileSync(bundlePath, code, "utf-8");
  console.log(`\n✅ sunset 强制更新已禁用: ${allPatches.length} 处 gate 调用 → !1`);
}

main();
