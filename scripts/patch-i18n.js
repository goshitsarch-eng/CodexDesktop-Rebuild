/**
 * 构建后补丁脚本：注入 English (en-US) 到语言选择器
 *
 * react-intl 以英语为 defaultMessage，不存在 en.json 翻译文件，
 * 导致 qNe() 返回的语言列表中没有英语选项。
 * 当系统语言为非英语时，用户无法主动选择英文 UI。
 *
 * 本脚本通过 AST 精确匹配 qNe() 函数，在返回数组中注入 en-US 条目。
 * 选择英语后 LocaleProvider 检测到无对应翻译 → messages=undefined → 回退到 defaultMessage（英文）。
 *
 * 用法：
 *   node scripts/patch-i18n.js          # 执行 patch
 *   node scripts/patch-i18n.js --check  # 仅检查匹配情况，不修改
 */
const fs = require("fs");
const path = require("path");
const acorn = require(require.resolve("acorn", { paths: [path.join(__dirname, "..")] }));

// ──────────────────────────────────────────────
//  第 1 层：AST 引擎 — 解析 + 递归遍历
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  第 2 层：声明式 Patch 规则
// ──────────────────────────────────────────────

const EN_US_ENTRY = '{locale:"en-US",normalized:"en-us",language:"en",load:()=>Promise.resolve({default:{}})}';

const RULES = [
  {
    id: "inject_english_locale",
    description: "qNe() 注入 English (en-US) locale 选项",
    /**
     * AST 匹配条件：
     *   FunctionDeclaration — id.name === "qNe"
     *   body 含 ReturnStatement，返回 ArrayExpression
     *   ArrayExpression 内有 SpreadElement（...fX）
     *
     * 替换策略：
     *   在 ArrayExpression 的首个元素前插入 en-US 对象
     *   [...fX] → [{en-US entry},...fX]
     */
    match(node, source) {
      if (node.type !== "FunctionDeclaration") return null;
      if (!node.id || node.id.name !== "qNe") return null;

      const body = node.body;
      if (!body || body.type !== "BlockStatement") return null;

      // 在函数体中找 ReturnStatement
      const retStmt = body.body.find((s) => s.type === "ReturnStatement");
      if (!retStmt) return null;

      const arg = retStmt.argument;
      if (!arg || arg.type !== "ArrayExpression") return null;

      // 确认包含 SpreadElement
      const hasSpread = arg.elements.some((el) => el && el.type === "SpreadElement");
      if (!hasSpread) return null;

      // 幂等：如果函数体中已含 "en-US" 则跳过
      const funcSrc = source.slice(node.start, node.end);
      if (funcSrc.includes('"en-US"')) return null;

      const original = source.slice(arg.start, arg.end);
      // 提取 spread 部分（从 [ 后到 ] 前的内容）
      const inner = original.slice(1, -1).trim();

      return {
        start: arg.start,
        end: arg.end,
        replacement: `[${EN_US_ENTRY},${inner}]`,
        original,
      };
    },
  },
];

// ──────────────────────────────────────────────
//  第 3 层：文件定位 + 外科替换
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
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  console.log(`🔍 AST 解析: ${Date.now() - t0}ms`);

  // 收集 patches
  const patches = [];
  const seen = new Set();

  walk(ast, (node) => {
    for (const rule of RULES) {
      const result = rule.match(node, source);
      if (result && !seen.has(result.start)) {
        seen.add(result.start);
        patches.push({ ...result, ruleId: rule.id, description: rule.description });
      }
    }
  });

  if (patches.length === 0) {
    console.log("\n✅ 无需修改（English locale 已注入或 qNe 不匹配）");
    return;
  }

  if (isCheck) {
    console.log(`\n🔎 匹配报告: ${patches.length} 处`);
    for (const p of patches) {
      console.log(`  📍 [${p.ruleId}] 位置 ${p.start}`);
      console.log(`     原始: ${p.original.slice(0, 80)}${p.original.length > 80 ? "..." : ""}`);
      console.log(`     替换: ${p.replacement.slice(0, 80)}${p.replacement.length > 80 ? "..." : ""}`);
    }
    return;
  }

  // 按 start 降序排列（从后往前替换，避免偏移漂移）
  patches.sort((a, b) => b.start - a.start);

  let code = source;
  for (const p of patches) {
    console.log(`  ✏️  [${p.ruleId}] 位置 ${p.start}: 注入 en-US 到语言列表`);
    code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
  }

  fs.writeFileSync(bundlePath, code, "utf-8");
  console.log(`\n✅ English (en-US) 已注入语言选择器: ${patches.length} 处修改`);
}

main();
