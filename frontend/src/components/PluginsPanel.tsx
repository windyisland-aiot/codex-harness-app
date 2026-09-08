//! T14 插件与 Skill 管理面板（v0.6.0 卡片化重写 · 独立页面）
//! 三个 Tab：已安装（卡片网格） / 云端市场（从 118.31.107.214 下载） / 本地导入（目录或 ZIP）。
//! 插件/技能存储路径统一放在安装目录下的 <codexHome>/skills 和 <codexHome>/plugins，
//! 后端 sync_bundled_skills 会把随安装包分发的内置 skills 同步到该目录，与 codex 扫描路径一致。

import { useEffect, useMemo, useState } from "react";
import * as codex from "../codexClient";

type Tab = "installed" | "cloud" | "import";

const SOURCE_TAG_CLASS: Record<string, string> = {
  bundled: "source-bundled",
  "codex-home": "source-codex-home",
  custom: "source-custom",
};
const SOURCE_LABEL: Record<string, string> = {
  bundled: "内置",
  "codex-home": "安装目录",
  custom: "自定义",
};

/** source/class 兜底 */
function sourceClass(s?: string) {
  return SOURCE_TAG_CLASS[s ?? "custom"] ?? "source-custom";
}
function sourceLabel(s?: string) {
  return SOURCE_LABEL[s ?? "custom"] ?? "自定义";
}

/** 根据名字首字/两字生成卡片图标里的小 emoji 替代文字 */
function iconGlyph(name: string) {
  if (!name) return "P";
  const n = name.trim();
  const m = n.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
  return m ? m[0].toUpperCase() : n[0]?.toUpperCase() ?? "P";
}

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
  const [tab, setTab] = useState<Tab>("installed");
  const [search, setSearch] = useState("");
  const [list, setList] = useState<codex.PluginsList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // 云端连接状态
  const [cloudOk, setCloudOk] = useState<boolean | null>(null);
  const [cloudMsg, setCloudMsg] = useState<string>("");
  const [cloudChecking, setCloudChecking] = useState(false);
  const [cloudItems, setCloudItems] = useState<codex.CloudMarketItem[]>([]);
  const [cloudLoaded, setCloudLoaded] = useState(false);

  // 本地导入
  const [importPath, setImportPath] = useState("");
  const [importKind, setImportKind] = useState<"auto" | "skill" | "plugin">("auto");
  const [importBusy, setImportBusy] = useState(false);

  // 面板打开时：加载已安装清单 + 连接云端
  useEffect(() => {
    if (!open) return;
    if (!loaded) loadInstalled();
    if (!cloudLoaded) checkCloud(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, codexHome]);

  async function loadInstalled() {
    setBusy(true);
    try {
      const l = await codex.pluginsList({ codexHome, skillRoots: [], pluginRoots: [] });
      setList(l);
      setLoaded(true);
    } catch (e: any) {
      onStatus(`加载技能/插件失败: ${e?.message ?? e}`);
      setList({ skills: [], plugins: [], bundledSkillsEnabled: true, skillsIncludeInstructions: null });
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }

  async function checkCloud(withList: boolean) {
    setCloudChecking(true);
    try {
      const h = await codex.pluginsCloudHealth();
      setCloudOk(h.ok);
      setCloudMsg(h.message);
      if (withList && h.ok) {
        try {
          const resp = await codex.pluginsCloudList();
          setCloudItems(resp.items as codex.CloudMarketItem[]);
          if (resp.message) setCloudMsg(`${h.message}｜${resp.message}`);
        } catch (e: any) {
          setCloudItems([]);
          setCloudMsg(`${h.message}｜市场清单加载失败: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      setCloudOk(false);
      setCloudMsg(`云端连接检查异常: ${e?.message ?? e}`);
    } finally {
      setCloudLoaded(true);
      setCloudChecking(false);
    }
  }

  async function refreshCloudList() {
    setCloudChecking(true);
    try {
      const h = await codex.pluginsCloudHealth();
      setCloudOk(h.ok);
      if (h.ok) {
        const resp = await codex.pluginsCloudList();
        setCloudItems(resp.items as codex.CloudMarketItem[]);
        setCloudMsg(resp.message || h.message);
        onStatus(`云端市场：${resp.items.length} 项`);
      } else {
        setCloudMsg(h.message);
      }
    } catch (e: any) {
      setCloudOk(false);
      setCloudMsg(`刷新失败: ${e?.message ?? e}`);
    } finally {
      setCloudChecking(false);
    }
  }

  // ============== 已安装：开关/保存 ==============

  async function toggleSkill(i: number, enabled: boolean) {
    if (!list) return;
    const next: codex.PluginsList = {
      ...list,
      skills: list.skills.map((s, k) => (k === i ? { ...s, enabled } : s)),
    };
    setList(next);
    await save(next);
  }

  async function togglePlugin(i: number, enabled: boolean) {
    if (!list) return;
    const next: codex.PluginsList = {
      ...list,
      plugins: list.plugins.map((p, k) => (k === i ? { ...p, enabled } : p)),
    };
    setList(next);
    await save(next);
  }

  async function toggleBundled(enabled: boolean) {
    if (!list) return;
    const next = { ...list, bundledSkillsEnabled: enabled };
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
      onStatus("配置已保存");
    } catch (e: any) {
      onStatus(`保存失败: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  // ============== 云端安装 ==============
  async function installFromCloud(item: codex.CloudMarketItem) {
    onStatus(`正在下载 ${item.name} …`);
    try {
      const r = await codex.pluginsCloudInstall({ codexHome, itemId: item.id });
      if (r.ok) {
        onStatus(`已安装：${item.name} → ${r.installedDir}`);
        await loadInstalled();
        setTab("installed");
      } else {
        onStatus(`安装失败：${r.message}`);
      }
    } catch (e: any) {
      onStatus(`云端安装异常: ${e?.message ?? e}`);
    }
  }

  // ============== 本地导入 ==============
  async function doImport() {
    setImportBusy(true);
    try {
      const r = await codex.pluginsImportLocal({
        codexHome,
        sourcePath: importPath || undefined,
        kind: importKind,
      });
      if (r.ok) {
        onStatus(r.message || `导入成功：${r.installedDir}`);
        setImportPath("");
        await loadInstalled();
        setTab("installed");
      } else {
        onStatus(`导入失败：${r.message}`);
      }
    } catch (e: any) {
      onStatus(`本地导入异常: ${e?.message ?? e}`);
    } finally {
      setImportBusy(false);
    }
  }

  // ============== 过滤（搜索） ==============
  const needle = search.trim().toLowerCase();
  const filteredSkills = useMemo(
    () =>
      (list?.skills ?? []).filter(
        (s) =>
          !needle ||
          s.name.toLowerCase().includes(needle) ||
          s.description.toLowerCase().includes(needle) ||
          s.dir.toLowerCase().includes(needle)
      ),
    [list, needle]
  );
  const filteredPlugins = useMemo(
    () =>
      (list?.plugins ?? []).filter(
        (p) =>
          !needle ||
          p.name.toLowerCase().includes(needle) ||
          p.description.toLowerCase().includes(needle) ||
          p.id.toLowerCase().includes(needle) ||
          p.dir.toLowerCase().includes(needle)
      ),
    [list, needle]
  );
  const filteredCloud = useMemo(
    () =>
      cloudItems.filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          c.description.toLowerCase().includes(needle) ||
          (c.tags ?? []).some((t) => t.toLowerCase().includes(needle))
      ),
    [cloudItems, needle]
  );

  const installedCount = (list?.skills.length ?? 0) + (list?.plugins.length ?? 0);

  if (!open) return null;

  return (
    <div className="cfg-backdrop" onClick={onClose}>
      <div className="cfg-panel plugins-panel" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="cfg-head">
          <h2>插件与 Skill 管理</h2>
          <button className="cfg-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        {/* 标签切换 */}
        <div className="plg-tabs">
          <button
            className={`plg-tab ${tab === "installed" ? "active" : ""}`}
            onClick={() => setTab("installed")}
          >
            已安装
            <span className="plg-tab-badge">{installedCount}</span>
          </button>
          <button
            className={`plg-tab ${tab === "cloud" ? "active" : ""} ${
              cloudOk === false ? "cloud-offline" : ""
            }`}
            onClick={() => setTab("cloud")}
          >
            云端市场
            {cloudItems.length > 0 && (
              <span className="plg-tab-badge">{cloudItems.length}</span>
            )}
          </button>
          <button
            className={`plg-tab ${tab === "import" ? "active" : ""}`}
            onClick={() => setTab("import")}
          >
            本地导入
          </button>
        </div>

        {/* 主体 */}
        <div className="cfg-body">
          {/* 云端连接状态条（所有 tab 都显示，方便用户一眼看到是否已连到云服务器） */}
          <div
            className={`plg-cloud-status ${
              cloudOk === null ? (cloudChecking ? "offline" : "offline") : cloudOk ? "online" : "offline"
            }`}
            title={cloudMsg}
          >
            <span
              className={`plg-cloud-dot ${cloudOk === null || !cloudOk ? "offline" : "online"}`}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {cloudChecking
                ? "正在连接云端服务器 118.31.107.214 …"
                : cloudMsg || "未执行连接检查"}
            </span>
            <button
              className="plg-cloud-retry"
              onClick={() => {
                if (tab === "cloud") refreshCloudList();
                else checkCloud(true);
              }}
              disabled={cloudChecking || busy}
            >
              {cloudChecking ? "连接中…" : "重新连接"}
            </button>
          </div>

          {/* ====================== Tab 1：已安装 ====================== */}
          {tab === "installed" && (
            <>
              <div className="plg-toolbar">
                <input
                  className="plg-search"
                  placeholder="搜索已安装的 skill / 插件（名称、描述、路径）…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="plg-toolbar-actions">
                  <button
                    className="plg-card-btn"
                    onClick={loadInstalled}
                    disabled={busy}
                  >
                    {busy ? "刷新中…" : "刷新清单"}
                  </button>
                  <label
                    className="cfg-check"
                    style={{ padding: 0, alignItems: "center" }}
                  >
                    <input
                      type="checkbox"
                      checked={list?.bundledSkillsEnabled ?? true}
                      disabled={busy}
                      onChange={(e) => toggleBundled(e.target.checked)}
                    />
                    <span style={{ fontSize: 12.5 }}>启用内置 skills</span>
                  </label>
                </div>
              </div>

              {filteredSkills.length === 0 && filteredPlugins.length === 0 && (
                <div className="cfg-empty">
                  {(list?.skills.length ?? 0) === 0 && (list?.plugins.length ?? 0) === 0
                    ? "尚未安装任何 skill 或插件。请尝试「本地导入」或从「云端市场」下载。"
                    : search
                    ? `没有找到匹配「${search}」的项。`
                    : "暂无匹配项。"}
                </div>
              )}

              {/* Skills 卡片网格 */}
              {filteredSkills.length > 0 && (
                <>
                  <h3 style={{ margin: "4px 0 0", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    Skills（{filteredSkills.length} / 共 {list?.skills.length ?? 0}）
                  </h3>
                  <div className="plg-grid">
                    {filteredSkills.map((s) => {
                      const gi = list!.skills.findIndex((x) => x.dir === s.dir);
                      return (
                        <div className="plg-card" key={s.dir} title={s.description}>
                          <div className="plg-card-head">
                            <div className="plg-card-icon skill">{iconGlyph(s.name)}</div>
                            <div className="plg-card-title">
                              <div className="name">{s.name}</div>
                              <div className="version">{s.version ?? "skill"}</div>
                            </div>
                          </div>
                          <div className="plg-card-desc">
                            {s.description || "（未填写 SKILL.md 描述）"}
                          </div>
                          <div className="plg-card-tags">
                            <span className={`plg-card-tag type-skill`}>skill</span>
                            <span className={`plg-card-tag ${sourceClass(s.source)}`}>
                              {sourceLabel(s.source)}
                            </span>
                          </div>
                          <div className="plg-card-foot">
                            <span className="plg-card-path" title={s.dir}>
                              {s.dir}
                            </span>
                            <div className="plg-card-actions">
                              <button
                                className={`plg-card-switch ${s.enabled ? "on" : ""}`}
                                aria-label={s.enabled ? "禁用" : "启用"}
                                onClick={() => gi >= 0 && toggleSkill(gi, !s.enabled)}
                                disabled={busy || gi < 0}
                              >
                                <span className="plg-card-switch-track" />
                                <span className="plg-card-switch-thumb" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* 插件 卡片网格 */}
              {filteredPlugins.length > 0 && (
                <>
                  <h3 style={{ margin: "8px 0 0", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    插件（{filteredPlugins.length} / 共 {list?.plugins.length ?? 0}）
                  </h3>
                  <div className="plg-grid">
                    {filteredPlugins.map((p) => {
                      const gi = list!.plugins.findIndex((x) => x.id === p.id);
                      return (
                        <div className="plg-card" key={p.id} title={p.description}>
                          <div className="plg-card-head">
                            <div className="plg-card-icon plugin">{iconGlyph(p.name || p.id)}</div>
                            <div className="plg-card-title">
                              <div className="name">
                                {p.name}
                                <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
                                  @ {p.id}
                                </span>
                              </div>
                              <div className="version">{p.version ?? "plugin"}</div>
                            </div>
                          </div>
                          <div className="plg-card-desc">
                            {p.description || "（未填写 plugin.toml 描述）"}
                          </div>
                          <div className="plg-card-tags">
                            <span className="plg-card-tag type-plugin">plugin</span>
                            <span className="plg-card-tag source-codex-home">安装目录</span>
                          </div>
                          <div className="plg-card-foot">
                            <span className="plg-card-path" title={p.dir}>
                              {p.dir}
                            </span>
                            <div className="plg-card-actions">
                              <button
                                className={`plg-card-switch ${p.enabled ? "on" : ""}`}
                                aria-label={p.enabled ? "禁用" : "启用"}
                                onClick={() => gi >= 0 && togglePlugin(gi, !p.enabled)}
                                disabled={busy || gi < 0}
                              >
                                <span className="plg-card-switch-track" />
                                <span className="plg-card-switch-thumb" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              <p className="cfg-hint" style={{ marginTop: 4 }}>
                存储位置：<code style={{ fontFamily: "var(--mono)" }}>{codexHome}/skills</code>、
                <code style={{ fontFamily: "var(--mono)", marginLeft: 4 }}>{codexHome}/plugins</code>
              </p>
            </>
          )}

          {/* ====================== Tab 2：云端市场 ====================== */}
          {tab === "cloud" && (
            <>
              <div className="plg-toolbar">
                <input
                  className="plg-search"
                  placeholder="搜索云端 skill / 插件…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="plg-toolbar-actions">
                  <button
                    className="plg-card-btn"
                    onClick={refreshCloudList}
                    disabled={cloudChecking}
                  >
                    {cloudChecking ? "刷新中…" : "刷新市场"}
                  </button>
                </div>
              </div>

              {cloudOk === false && (
                <div className="cfg-empty" style={{ textAlign: "left" }}>
                  ⚠️ 无法连接服务器
                  <br />
                  <span style={{ color: "var(--text-secondary)" }}>
                    {cloudMsg || "网络不通 / 服务未启动"}
                  </span>
                </div>
              )}

              {cloudOk !== false && filteredCloud.length === 0 && (
                <div className="cfg-empty">
                  {cloudItems.length === 0
                    ? "云端暂无可用内容，请在服务端后台导入后刷新。"
                    : search
                    ? `云端未找到匹配「${search}」的项。`
                    : "没有匹配项。"}
                </div>
              )}

              {filteredCloud.length > 0 && (
                <div className="plg-grid">
                  {filteredCloud.map((c) => (
                    <div className="plg-card" key={c.id} title={c.description}>
                      <div className="plg-card-head">
                        <div className={`plg-card-icon ${c.type === "skill" ? "skill" : "plugin"} cloud`}>
                          {iconGlyph(c.name)}
                        </div>
                        <div className="plg-card-title">
                          <div className="name">{c.name}</div>
                          <div className="version">
                            v{c.version || "1.0.0"}
                            {c.author && ` · ${c.author}`}
                            {c.updatedAt && ` · 更新于 ${c.updatedAt}`}
                          </div>
                        </div>
                      </div>
                      <div className="plg-card-desc">{c.description || "（暂无描述）"}</div>
                      <div className="plg-card-tags">
                        <span
                          className={`plg-card-tag ${
                            c.type === "skill" ? "type-skill" : "type-plugin"
                          }`}
                        >
                          {c.type === "skill" ? "skill" : "插件"}
                        </span>
                        <span className="plg-card-tag">云端</span>
                        {(c.tags ?? []).slice(0, 3).map((t) => (
                          <span key={t} className="plg-card-tag">
                            {t}
                          </span>
                        ))}
                        {c.size != null && (
                          <span className="plg-card-tag">{formatSize(c.size)}</span>
                        )}
                      </div>
                      <div className="plg-card-foot">
                        <span className="plg-card-path" title={c.downloadUrl}>
                          {c.downloadUrl}
                        </span>
                        <div className="plg-card-actions">
                          <button
                            className="plg-card-btn primary"
                            onClick={() => installFromCloud(c)}
                          >
                            安装
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ====================== Tab 3：本地导入 ====================== */}
          {tab === "import" && (
            <>
              <div className="plg-import-area">
                <div className="plg-import-icon">📦</div>
                <div className="plg-import-title">导入本地 Skill 或 插件</div>
                <div className="plg-import-desc">
                  支持目录（含 <code style={{ fontFamily: "var(--mono)" }}>SKILL.md</code> 或{" "}
                  <code style={{ fontFamily: "var(--mono)" }}>plugin.toml</code>）与 ZIP 压缩包，导入后自动启用。
                </div>
              </div>

              <section className="cfg-section" style={{ marginTop: 6 }}>
                <div className="cfg-sec-head">
                  <h3>设置导入来源</h3>
                </div>

                <div>
                  <label style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    类型判断
                  </label>
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    {(["auto", "skill", "plugin"] as const).map((k) => (
                      <label
                        key={k}
                        className="cfg-check"
                        style={{
                          padding: "6px 12px",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          alignItems: "center",
                          background:
                            importKind === k ? "var(--brand-soft)" : "var(--bg-surface)",
                          color: importKind === k ? "var(--brand)" : "var(--text)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="radio"
                          checked={importKind === k}
                          onChange={() => setImportKind(k)}
                        />
                        <span>
                          {k === "auto" ? "自动识别（推荐）" : k === "skill" ? "Skill 目录/ZIP" : "插件 目录/ZIP"}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    本地完整路径
                  </label>
                  <input
                    className="cfg-full"
                    style={{ marginTop: 4, fontFamily: "var(--mono)", fontSize: 12 }}
                    placeholder='例：D:\my-skills\talk-script   或   /home/me/Downloads/my-plugin.zip'
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") doImport();
                    }}
                  />
                  <p className="cfg-hint" style={{ marginTop: 6 }}>
                    粘贴本地完整路径即可，将安装到{" "}
                    <code style={{ fontFamily: "var(--mono)" }}>{codexHome}/skills</code>。
                  </p>
                </div>

                <div className="plg-toolbar-actions" style={{ justifyContent: "flex-end", marginTop: 6 }}>
                  <button className="plg-card-btn" onClick={() => setImportPath("")} disabled={importBusy}>
                    清空
                  </button>
                  <button
                    className="plg-card-btn primary"
                    onClick={doImport}
                    disabled={importBusy || !importPath.trim()}
                  >
                    {importBusy ? "导入中…" : "开始导入"}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
