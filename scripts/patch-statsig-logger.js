/**
 * 构建后补丁脚本：注入 Statsig SDK 云控值实时日志
 *
 * 在 StatsigClientBase 的 _setStatus 方法中注入日志代码，
 * 当 Statsig 完成初始化/更新（values_updated 事件）时，
 * 遍历并打印所有 feature gates、dynamic configs、layers 的值。
 *
 * 拦截点：
 *   _setStatus(g, v) { this.loadingStatus = g, ... }
 *   → 在方法体头部注入 console 日志块
 *
 * 用法：
 *   node scripts/patch-statsig-logger.js          # 执行 patch
 *   node scripts/patch-statsig-logger.js --check  # 仅检查匹配
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

function getPropertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return null;
}

// ──────────────────────────────────────────────
//  注入代码模板
// ──────────────────────────────────────────────

const LOGGER_CODE = `
try {
  if (g === "Ready" && this._store) {
    const _container = this._store._values;
    const _raw = _container?._values || _container;
    const _fg = _raw.feature_gates || {};
    const _dc = _raw.dynamic_configs || {};
    const _lc = _raw.layer_configs || {};
    const _ps = _raw.param_stores || {};
    const _vals = _raw.values || {};
    console.group("[Statsig] values_updated — status:", g, "source:", this._store._source);

    console.group("Feature Gates (" + Object.keys(_fg).length + ")");
    for (const [k, v] of Object.entries(_fg)) {
      console.log(k, "=", v?.v === true ? "TRUE" : "FALSE", v?.r ? "(rule:" + v.r + ")" : "");
    }
    console.groupEnd();

    console.group("Dynamic Configs (" + Object.keys(_dc).length + ")");
    for (const [k, v] of Object.entries(_dc)) {
      console.log(k, "=", JSON.stringify(v?.v || {}), v?.r ? "(rule:" + v.r + ")" : "");
    }
    console.groupEnd();

    console.group("Layers (" + Object.keys(_lc).length + ")");
    for (const [k, v] of Object.entries(_lc)) {
      const layerValues = _vals[v?.v] || v?.v || {};
      console.log(k, "=", JSON.stringify(layerValues), v?.r ? "(rule:" + v.r + ")" : "");
    }
    console.groupEnd();

    if (Object.keys(_ps).length > 0) {
      console.group("Param Stores (" + Object.keys(_ps).length + ")");
      for (const [k, v] of Object.entries(_ps)) {
        console.log(k, "=", JSON.stringify(v));
      }
      console.groupEnd();
    }

    console.log("[raw keys]", Object.keys(_raw));
    console.groupEnd();
  }
} catch(_e) { console.warn("[Statsig Logger] error:", _e); }
`.trim();

// ──────────────────────────────────────────────
//  Patch 规则
// ──────────────────────────────────────────────

const RULES = [
  {
    id: "inject_statsig_logger",
    description: "_setStatus 方法体注入云控值日志",
    /**
     * AST 匹配：
     *   找到方法定义 _setStatus(g, v) { ... }
     *   特征：方法体中包含 this.loadingStatus = g 和 "values_updated" 字符串
     *   在函数体的 { 之后注入 logger 代码
     */
    match(node, source) {
      // 匹配 Property: _setStatus: function(g, v) { ... }
      // 或直接方法定义 _setStatus(g, v) { ... }
      if (node.type !== "Property" && node.type !== "MethodDefinition") return null;

      const keyName = getPropertyName(node.key);
      if (keyName !== "_setStatus") return null;

      const func = node.value || node;
      if (!func.body || func.body.type !== "BlockStatement") return null;

      // 验证：方法体中包含 "values_updated"
      const funcSrc = source.slice(func.body.start, func.body.end);
      if (!funcSrc.includes("values_updated")) return null;

      // 幂等：检查是否已注入
      if (funcSrc.includes("[Statsig] values_updated")) return null;

      // 在 { 之后插入
      const insertPos = func.body.start + 1;

      return {
        start: insertPos,
        end: insertPos,
        replacement: LOGGER_CODE,
        original: "",
      };
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
    console.log("\n✅ 无需修改（日志已注入或 _setStatus 未匹配）");
    return;
  }

  if (isCheck) {
    console.log(`\n🔎 匹配报告: ${patches.length} 处`);
    for (const p of patches) {
      console.log(`  📍 [${p.ruleId}] 插入位置 ${p.start}`);
      console.log(`     ${p.description}`);
    }
    return;
  }

  patches.sort((a, b) => b.start - a.start);

  let code = source;
  for (const p of patches) {
    console.log(`  ✏️  [${p.ruleId}] 位置 ${p.start}: 注入 Statsig 云控值日志`);
    code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
  }

  fs.writeFileSync(bundlePath, code, "utf-8");
  console.log(`\n✅ Statsig 云控值日志已注入: ${patches.length} 处`);
}

main();
