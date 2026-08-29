//! T14 插件与 Skill 管理面板：扫描展示 skills/插件，编辑开关并写回 config.toml。

import { useState } from "react";
import * as codex from "../codexClient";

export default function PluginsPanel({
  open,
  onClose,
  codexHome,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  codexHome: string;
  onStatus: (s: string) => void;
}) {
  const [list, setList] = useState<codex.PluginsList | null>(null);
  const [skillRoots, setSkillRoots] = useState("");
  const [pluginRoots, setPluginRoots] = useState("");
  const [newSkillDir, setNewSkillDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!open) return null;

  // 默认扫描 codex 工作区内置 skill（与 fork 仓库 .codex/skills 对齐）。
  if (!loaded) {
    const roots = [
      "/workspace/codex/codex-rs/skills",
      "/workspace/codex/.codex/skills",
      "/workspace/codex-harness-app/.codex-test/skills",
    ];
    codex
      .pluginsList({
        codexHome,
        skillRoots: roots,
        pluginRoots: ["/workspace/codex-harness-app/.codex-test/plugins"],
      })
      .then((l) => {
        setList(l);
      })
      .catch((e) => {
        onStatus(`加载技能/插件失败: ${e}（已切换到本地占位展示）`);
        // 浏览器无 Tauri 或 远端未响应时，给空结构保证面板可渲染。
        setList({ skills: [], plugins: [], bundledSkillsEnabled: true, skillsIncludeInstructions: null });
      })
      .finally(() => {
        setLoaded(true);
      });
    return null;
  }
  if (!list) return null;

  const parseRoots = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  async function refresh() {
    setBusy(true);
    try {
      const l = await codex.pluginsList({
        codexHome,
        skillRoots: parseRoots(skillRoots),
        pluginRoots: parseRoots(pluginRoots),
      });
      setList(l);
      onStatus("已刷新技能/插件清单");
    } catch (e) {
      onStatus(`刷新失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSkill(i: number, enabled: boolean) {
    if (!list) return;
    const next = { ...list, skills: list.skills.map((s, k) => (k === i ? { ...s, enabled } : s)) };
    setList(next);
    await save(next);
  }

  async function togglePlugin(i: number, enabled: boolean) {
    if (!list) return;
    const next = { ...list, plugins: list.plugins.map((p, k) => (k === i ? { ...p, enabled } : p)) };
    setList(next);
    await save(next);
  }

  async function save(l: codex.PluginsList) {
    setBusy(true);
    try {
      const plugins: Record<string, boolean> = {};
      for (const p of l.plugins) plugins[p.id] = p.enabled;
      await codex.pluginsApply({
        codexHome,
        skills: l.skills.map((s) => ({ name: s.name, path: s.dir, enabled: s.enabled })),
        plugins,
        bundledSkillsEnabled: l.bundledSkillsEnabled,
        skillsIncludeInstructions: l.skillsIncludeInstructions,
      });
      onStatus("技能/插件配置已保存（重启 app-server 生效）");
    } catch (e) {
      onStatus(`保存失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function addCustomSkill() {
    const dir = newSkillDir.trim();
    if (!dir) return;
    setBusy(true);
    try {
      await codex.pluginsAddSkillDir(codexHome, dir, true);
      setNewSkillDir("");
      await refresh();
      onStatus(`已注册自定义 skill 目录: ${dir}`);
    } catch (e) {
      onStatus(`添加失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  const grouped: Record<string, codex.SkillInfo[]> = {};
  for (const s of list.skills) {
    const key = s.dir.includes("codex-rs/skills") ? "内置 skills" : s.dir.includes(".codex/") ? "工作区 skills" : "自定义 skills";
    (grouped[key] ||= []).push(s);
  }

  return (
    <div className="cfg-backdrop" onClick={onClose}>
      <div className="cfg-panel plugins-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-head">
          <h2>插件与 Skill</h2>
          <button className="cfg-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="cfg-body">
          {/* 作用域 */}
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>扫描根目录（每行一个）</h3>
              <button className="cfg-add" onClick={refresh} disabled={busy}>
                刷新
              </button>
            </div>
            <textarea
              className="cfg-full cfg-env"
              value={skillRoots}
              onChange={(e) => setSkillRoots(e.target.value)}
              placeholder={"skill 根目录（每行一个）"}
              rows={2}
            />
            <textarea
              className="cfg-full cfg-env"
              value={pluginRoots}
              onChange={(e) => setPluginRoots(e.target.value)}
              placeholder="插件根目录（每行一个）"
              rows={1}
            />
          </section>

          {/* 全局开关 */}
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>全局开关</h3>
            </div>
            <label className="cfg-check">
              <input
                type="checkbox"
                checked={list.bundledSkillsEnabled}
                onChange={(e) => {
                  const next = { ...list, bundledSkillsEnabled: e.target.checked };
                  setList(next);
                  save(next);
                }}
              />
              启用内置 skills（[skills.bundled]）
            </label>
          </section>

          {/* Skills */}
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>Skills（{list.skills.length}）</h3>
              <button className="cfg-add" onClick={addCustomSkill} disabled={busy}>
                添加目录
              </button>
            </div>
            <input
              className="cfg-full"
              value={newSkillDir}
              onChange={(e) => setNewSkillDir(e.target.value)}
              placeholder="自定义 skill 目录路径（含 SKILL.md）"
            />
            {Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="cfg-card">
                <div className="cfg-card-head">
                  <span className="cfg-id">{group}</span>
                </div>
                {items.map((s) => (
                  <label key={s.dir} className="cfg-check cfg-item">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => {
                        // 找到全局原索引，写回对应配置。
                        const gi = list.skills.findIndex((x) => x.dir === s.dir);
                        toggleSkill(gi, e.target.checked);
                      }}
                    />
                    <span>
                      <b>{s.name}</b>
                      {s.description && <i> · {s.description}</i>}
                      <div className="cfg-muted">{s.dir}</div>
                    </span>
                  </label>
                ))}
              </div>
            ))}
            {list.skills.length === 0 && <p className="cfg-hint">未发现任何 skill。</p>}
          </section>

          {/* 插件 */}
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>插件（{list.plugins.length}）</h3>
            </div>
            {list.plugins.length === 0 && <p className="cfg-hint">未发现插件（含 plugin.toml 的目录）。</p>}
            {list.plugins.map((p, i) => (
              <label key={p.id} className="cfg-check cfg-item">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => togglePlugin(i, e.target.checked)}
                />
                <span>
                  <b>{p.name}</b> @ {p.id}
                  {p.description && <i> · {p.description}</i>}
                  <div className="cfg-muted">{p.dir}</div>
                </span>
              </label>
            ))}
          </section>
          <p className="cfg-hint">改动写回 config.toml，重启 app-server 后 codex 生效。</p>
        </div>
      </div>
    </div>
  );
}