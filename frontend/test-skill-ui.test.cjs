// TDD: 验证 Harness 的设置面板里存在「插件/Skill」入口。
// 期望：
// 1. SettingsPanel NavKey 联合类型含 plugins
// 2. NAV 数组存在 key=plugins 条目，label 含 插件/Skill/技能
// 3. SettingsPanel 存在 nav === "plugins" 时的条件渲染（<SectionPlugins ... /> 或内嵌 PluginsPanel 组件）
// 4. PluginsPanel 代码里调用了 codex.pluginsList / codex.pluginsApply — 即能扫描 skill 并写回启用状态
// 5. codexClient.ts 真正 invoke "plugins_list" / "plugins_apply" Tauri 命令（确保和 Rust 侧对接）
//
// 运行：node frontend/test-skill-ui.test.cjs

const fs = require("fs");
const path = require("path");

const settings = fs.readFileSync(
  path.resolve(__dirname, "src/components/SettingsPanel.tsx"),
  "utf8"
);
const pluginsPanel = fs.readFileSync(
  path.resolve(__dirname, "src/components/PluginsPanel.tsx"),
  "utf8"
);
const codexClient = fs.readFileSync(
  path.resolve(__dirname, "src/codexClient.ts"),
  "utf8"
);

const failures = [];
function check(desc, cond, reason) {
  if (cond) console.log("[PASS]", desc);
  else failures.push(`[FAIL] ${desc}: ${reason}`);
}

// 1) NavKey
const navKeyMatch = settings.match(/type\s+NavKey\s*=\s*([^\n;]+)/);
const navKeyBody = navKeyMatch ? navKeyMatch[1] : "(未找到)";
check(
  "NavKey 联合类型包含 plugins",
  /"plugins"/.test(navKeyBody),
  `当前 NavKey=${navKeyBody.trim()}，不含 "plugins"`
);

// 2) NAV 条目
const navEntry = settings.match(/\{\s*key\s*:\s*"plugins"\s*,\s*label\s*:\s*"([^"]+)"/);
check(
  "NAV 数组存在 plugins 条目（label 含 插件/Skill/技能）",
  navEntry && /插件|Skill|技能|skill/.test(navEntry[1]),
  navEntry
    ? `label="${navEntry[1]}" 不含 插件/Skill/技能 关键字`
    : "NAV 数组里没找到 key=plugins 条目"
);

// 3) 渲染分支
const renderBranch = /nav\s*===\s*"plugins"[\s\S]{0,300}(SectionPlugins|PluginsPanel)/.test(
  settings
);
check(
  "设置面板存在 plugins → 插件/Skill 内容区的条件渲染分支",
  renderBranch,
  "没找到 nav === 'plugins' 时渲染 SectionPlugins/PluginsPanel 的分支，点 tab 后内容为空"
);

// 4) PluginsPanel 调用 codex.pluginsList / codex.pluginsApply / codex.pluginsAddSkillDir
check(
  "PluginsPanel 调用 codex.pluginsList（扫描 skills/插件）",
  /codex\s*\.\s*pluginsList\s*\(/.test(pluginsPanel),
  "PluginsPanel 内没有 codex.pluginsList 调用 → 无法发现磁盘上的 skill"
);
check(
  "PluginsPanel 调用 codex.pluginsApply（写回启用状态）",
  /codex\s*\.\s*pluginsApply\s*\(/.test(pluginsPanel),
  "PluginsPanel 内没有 codex.pluginsApply 调用 → 勾选 skill 后不会生效"
);

// 5) codexClient 底层 invoke "plugins_list" / "plugins_apply"
check(
  "codexClient.ts 中有 invoke('plugins_list')",
  /invoke\s*\(\s*['"]plugins_list['"]/.test(codexClient),
  "codexClient 没有 invoke('plugins_list')，Tauri 命令名不匹配"
);
check(
  "codexClient.ts 中有 invoke('plugins_apply')",
  /invoke\s*\(\s*['"]plugins_apply['"]/.test(codexClient),
  "codexClient 没有 invoke('plugins_apply')，用户的设置不会写回 config.toml"
);

console.log("");
if (failures.length) {
  console.log(`${failures.length} 项失败：`);
  failures.forEach((f) => console.log("  " + f));
  process.exit(1);
} else {
  console.log("✅ 全部通过：设置面板里已接入 Skill/插件 UI。");
  process.exit(0);
}
