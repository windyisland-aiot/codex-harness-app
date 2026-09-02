// TDD: 4 个 UI 问题的结构断言（RED → GREEN）
// 1. 插件管理 = 独立页面（App.tsx 渲染 PluginsPanel，SettingsPanel 移除 plugins tab）
// 2. 按钮 hover 不用 filter（WebView2 backdrop-filter 渲染 bug），主按钮黑白
// 3. 编辑模型弹窗用 createPortal 脱离 transform 祖先（修复拉伸/裁剪）
// 4. 飞书 Skill 检测：resources 打包 skills + Rust 端追加 resource 扫描 + 前端正确路径
// 运行：node frontend/test-ui-fixes.test.cjs

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const app = read("frontend/src/App.tsx");
const settings = read("frontend/src/components/SettingsPanel.tsx");
const pluginsPanel = read("frontend/src/components/PluginsPanel.tsx");
const css = read("frontend/src/styles.css");
const pluginsRs = read("src-tauri/src/plugins.rs");
const tauriConf = read("src-tauri/tauri.conf.json");

const failures = [];
function check(desc, cond, reason) {
  if (cond) console.log("[PASS]", desc);
  else failures.push(`[FAIL] ${desc}: ${reason}`);
}

/* ---------- 1. 插件管理独立页面 ---------- */
check(
  "App.tsx import PluginsPanel",
  /import\s+PluginsPanel\s+from\s+["']\.\/components\/PluginsPanel["']/.test(app),
  "没有 import PluginsPanel 组件"
);
check(
  "App.tsx 有 pluginsOpen state",
  /const\s*\[pluginsOpen,\s*setPluginsOpen\]\s*=\s*useState\(false\)/.test(app),
  "没有 pluginsOpen state"
);
check(
  "「插件管理」按钮 onClick 打开独立页面（不再是 setSettingsOpen）",
  /onClick=\{\(\)\s*=>\s*setPluginsOpen\(true\)\}[\s\S]{0,400}?插件管理/.test(app),
  "插件管理按钮的 onClick 没有指向 setPluginsOpen(true)"
);
check(
  "App.tsx 渲染 <PluginsPanel（独立模态）",
  /<PluginsPanel[\s\S]{0,200}pluginsOpen/.test(app) && /<PluginsPanel[\s\S]{0,300}onClose=\{\(\)\s*=>\s*setPluginsOpen\(false\)\}/.test(app),
  "没有渲染 <PluginsPanel open={pluginsOpen} onClose={...}/>"
);
check(
  "App.tsx 给 PluginsPanel 传 codexHome",
  /<PluginsPanel[\s\S]{0,400}codexHome=\{/.test(app),
  "PluginsPanel 没拿到 codexHome（扫描需要）"
);
// SettingsPanel 中移除 plugins tab
check(
  "SettingsPanel NavKey 不再含 plugins（插件管理移出设置）",
  !/"plugins"/.test(settings.match(/type\s+NavKey\s*=\s*([^\n;]+)/)?.[1] || ""),
  "NavKey 仍包含 \"plugins\"，插件管理还在设置面板里"
);
check(
  "SettingsPanel 无 SectionPlugins 残留",
  !/SectionPlugins/.test(settings),
  "SettingsPanel 仍有 SectionPlugins 代码残留"
);

/* ---------- 2. hover filter 移除 + 黑白主色 ---------- */
check(
  "styles.css 无 filter: brightness（WebView2 backdrop-filter 渲染 bug 元凶）",
  !/filter\s*:\s*brightness/.test(css),
  "仍存在 filter: brightness 的 hover 样式"
);
check(
  "styles.css 无任何 filter:（残留检查，允许 0 处）",
  !/\bfilter\s*:/.test(css.replace(/backdrop-filter\s*:/g, "")),
  "仍存在非 backdrop 的 filter 声明"
);
check(
  ".sp-btn-primary 改为纯黑底白字（无蓝紫渐变）",
  /\.sp-btn-primary\s*\{[^}]*background:\s*#111827[^}]*\}/.test(css),
  ".sp-btn-primary 不是 background: #111827"
);
check(
  ":root 主品牌变量为黑白灰（--brand-start 不再是 indigo）",
  /--brand-start:\s*#1F2328/.test(css) || /--brand-start:\s*#111827/.test(css),
  "--brand-start 未改为黑/深灰"
);
check(
  ":root --brand-end 为黑色系",
  /--brand-end:\s*#111827/.test(css) || /--brand-end:\s*#374151/.test(css),
  "--brand-end 未改为黑/深灰"
);
check(
  "CSS 无蓝紫渐变残留（#4F46E5/#7C3AED/#7c5cff/#3aa0ff/#6366F1/#8B5CF6）",
  !/#4F46E5|#7C3AED|#7c5cff|#3aa0ff|#6366F1|#8B5CF6|#4338CA|#3730A3/i.test(css),
  "仍存在蓝紫色值"
);

/* ---------- 3. 编辑弹窗 portal 化 ---------- */
check(
  "SettingsPanel 使用 createPortal（弹窗脱离 transform 祖先）",
  /createPortal/.test(settings) && /from\s+["']react-dom["']/.test(settings),
  "未引入 createPortal / react-dom"
);
check(
  "编辑模型弹窗 JSX 由 createPortal 包裹",
  /createPortal\(\s*\(?[\s\S]{0,80}<div\s+className="modal-backdrop"/.test(settings),
  "modal-backdrop 弹窗未被 createPortal 包裹"
);

/* ---------- 4. 飞书 Skill 检测 ---------- */
check(
  "tauri.conf.json resources 打包 skills 目录",
  /"resources"[\s\S]{0,300}(skills|"\.codex\/skills")/.test(tauriConf),
  "bundle.resources 里没有 skills 相关条目（feishu-bot 没进安装包）"
);
check(
  "plugins_list Rust 端追加 resource skills 扫描",
  /resource_dir/.test(pluginsRs) && /default_roots/.test(pluginsRs) && /CARGO_MANIFEST_DIR/.test(pluginsRs),
  "plugins.rs 没有把 resource_dir 下的 skills 加入扫描根"
);
check(
  "skill 清单带 source 字段（bundled/codex-home/custom 分组）",
  /"source"/.test(pluginsRs) && /source/.test(pluginsPanel),
  "skills 没有来源标记，前端无法分组展示"
);
check(
  "内置 feishu-bot skill 已进 src-tauri/resources（随安装包分发）",
  fs.existsSync(path.join(ROOT, "src-tauri/resources/skills/feishu-bot/SKILL.md")),
  "src-tauri/resources/skills/feishu-bot/SKILL.md 不存在"
);
check(
  ".gitignore 放行 resources/skills（不被忽略）",
  /!src-tauri\/resources\/skills\//.test(read(".gitignore")),
  ".gitignore 仍忽略 src-tauri/resources 整个目录"
);
check(
  "PluginsPanel 默认 skillRoots 基于 codexHome（不再硬编码 /workspace Linux 路径）",
  !/\/workspace\/codex-harness-app\/\.codex-test/.test(pluginsPanel),
  "PluginsPanel 仍硬编码 /workspace/... 测试路径"
);

console.log("");
if (failures.length) {
  console.log(`${failures.length} 项失败：`);
  failures.forEach((f) => console.log("  " + f));
  process.exit(1);
} else {
  console.log("✅ 全部通过：4 个 UI 问题已修复。");
  process.exit(0);
}
