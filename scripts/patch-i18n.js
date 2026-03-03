/**
 * 构建后补丁脚本：注入 English (en-US) 到语言选择器
 *
 * react-intl 以英语为 defaultMessage，不存在 en.json 翻译文件，
 * 导致语言列表中没有英语选项。
 * 当系统语言为非英语时，用户无法主动选择英文 UI。
 *
 * 匹配策略（纯结构，不依赖压缩名）：
 *   1. 定位 locale 数组变量：赋值源为 Object.entries(X).map(...).filter(...).sort(...)
 *      且 map 回调中包含 .json 文件路径匹配
 *   2. 定位返回 [...该变量] 的函数
 *   3. 在 ArrayExpression 头部注入 en-US 条目
 *
 * 用法：
 *   node scripts/patch-i18n.js          # 执行 patch
 *   node scripts/patch-i18n.js --check  # 仅检查匹配情况，不修改
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");

// ──────────────────────────────────────────────
//  AST 遍历
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
//  第 1 步：定位 locale 数组变量名
// ──────────────────────────────────────────────

/**
 * 在源码中查找形如：
 *   VAR = Object.entries(X).map((...) => { ... .json ... }).filter(...).sort(...)
 *
 * 特征链：
 *   - CallExpression: .sort(...)
 *     - callee.object: CallExpression .filter(...)
 *       - callee.object: CallExpression .map(...)
 *         - callee.object: CallExpression Object.entries(X)
 *   - map 回调体中包含 ".json" 字符串
 *
 * 返回变量名（Identifier.name）
 */
function findLocaleArrayName(ast, source) {
  let varName = null;

  walk(ast, (node) => {
    if (varName) return; // 已找到

    // 匹配赋值：VAR = expr
    let assignTarget = null;
    let assignValue = null;

    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
      assignTarget = node.id.name;
      assignValue = node.init;
    } else if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") {
      assignTarget = node.left.name;
      assignValue = node.right;
    }

    if (!assignTarget || !assignValue) return;

    // 验证链式调用：.sort(..).filter(..).map(..)..Object.entries(..)
    if (!isChainedCall(assignValue, ["sort", "filter", "map"])) return;

    // 取 map 调用节点
    const mapCall = getChainedCallAt(assignValue, "map");
    if (!mapCall) return;

    // map 回调体中应包含 ".json"
    const mapSrc = source.slice(mapCall.start, mapCall.end);
    if (!mapSrc.includes(".json")) return;

    // 额外确认：map 回调中应有 locale/normalized/language 关键字
    if (!mapSrc.includes("locale") && !mapSrc.includes("normalized")) return;

    varName = assignTarget;
  });

  return varName;
}

/**
 * 检查 node 是否为 X.method1(...).method2(...).method3(...) 链
 * methods 从外到内：[sort, filter, map]
 */
function isChainedCall(node, methods) {
  let current = node;
  for (const method of methods) {
    if (!current || current.type !== "CallExpression") return false;
    const callee = current.callee;
    if (!callee || callee.type !== "MemberExpression") return false;
    const prop = callee.property;
    if (!prop) return false;
    const name = prop.type === "Identifier" ? prop.name : prop.type === "Literal" ? prop.value : null;
    if (name !== method) return false;
    current = callee.object; // 深入一层
  }
  return true;
}

/** 从链式调用中提取指定方法的 CallExpression 节点 */
function getChainedCallAt(node, method) {
  let current = node;
  while (current && current.type === "CallExpression") {
    const callee = current.callee;
    if (callee?.type === "MemberExpression") {
      const prop = callee.property;
      const name = prop?.type === "Identifier" ? prop.name : prop?.type === "Literal" ? prop.value : null;
      if (name === method) return current;
      current = callee.object;
    } else {
      break;
    }
  }
  return null;
}

// ──────────────────────────────────────────────
//  第 2 步：定位返回 [...localeVar] 的函数并 patch
// ──────────────────────────────────────────────

const EN_US_ENTRY = '{locale:"en-US",normalized:"en-us",language:"en",load:()=>Promise.resolve({default:{}})}';

function collectPatches(ast, source, localeVarName) {
  const patches = [];

  walk(ast, (node) => {
    // 匹配任意函数类型
    const body = getFunctionBody(node);
    if (!body) return;

    const statements = body.type === "BlockStatement" ? body.body : null;
    if (!statements || statements.length !== 1) return;

    const retStmt = statements[0];
    if (retStmt.type !== "ReturnStatement") return;

    const arg = retStmt.argument;
    if (!arg || arg.type !== "ArrayExpression") return;
    if (arg.elements.length !== 1) return;

    const spread = arg.elements[0];
    if (!spread || spread.type !== "SpreadElement") return;
    if (spread.argument?.type !== "Identifier") return;
    if (spread.argument.name !== localeVarName) return;

    // 幂等检查
    const funcSrc = source.slice(node.start, node.end);
    if (funcSrc.includes('"en-US"')) return;

    const original = source.slice(arg.start, arg.end);
    const inner = original.slice(1, -1).trim();

    patches.push({
      start: arg.start,
      end: arg.end,
      replacement: `[${EN_US_ENTRY},${inner}]`,
      original,
    });
  });

  return patches;
}

function getFunctionBody(node) {
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
    return node.body;
  }
  if (node.type === "ArrowFunctionExpression") {
    return node.body;
  }
  return null;
}

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

  // 第 1 步：定位 locale 数组变量名
  const localeVarName = findLocaleArrayName(ast, source);
  if (!localeVarName) {
    console.log("\n⚠️  未找到 locale 数组变量（Object.entries → map → filter → sort 链）");
    return;
  }
  console.log(`📌 locale 数组变量: ${localeVarName}`);

  // 第 2 步：定位返回 [...localeVar] 的函数并收集 patch
  const patches = collectPatches(ast, source, localeVarName);

  if (patches.length === 0) {
    console.log("\n✅ 无需修改（English locale 已注入或未找到返回函数）");
    return;
  }

  if (isCheck) {
    console.log(`\n🔎 匹配报告: ${patches.length} 处`);
    for (const p of patches) {
      console.log(`  📍 位置 ${p.start}`);
      console.log(`     原始: ${p.original.slice(0, 80)}${p.original.length > 80 ? "..." : ""}`);
      console.log(`     替换: ${p.replacement.slice(0, 80)}${p.replacement.length > 80 ? "..." : ""}`);
    }
    return;
  }

  patches.sort((a, b) => b.start - a.start);

  let code = source;
  for (const p of patches) {
    console.log(`  ✏️  位置 ${p.start}: 注入 en-US 到语言列表`);
    code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
  }

  fs.writeFileSync(bundlePath, code, "utf-8");
  console.log(`\n✅ English (en-US) 已注入语言选择器: ${patches.length} 处修改`);
}

main();
