//! 右栏工具面板（形态参考 Trae Work 的工具抽屉）：
//! - 多 Tab：审批 / 会话 / 终端 / 浏览器 / 画布 / 快捷键
//! - 可折叠：右上角折叠按钮，折叠时仅保留 Tab 图标条
//! - 仅参考 Trae Work 形态；终端 / 浏览器 / 画布 UI 本版本为轻量占位，
//!   实际 exec / 浏览 功能由 Codex 工具调用驱动（Agent 跑起来后会有输出）。

import { useRef, useState } from "react";
import type { ApprovalRequest } from "../codexClient";
import ApprovalPanel from "./ApprovalPanel";

export interface SessionInfo {
  title?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  threadId?: string;
  msgCount?: number;
  running?: boolean;
  approvals?: number;
  statusText?: string;
  username?: string;
}

type TabId = "approvals" | "session" | "terminal" | "browser" | "canvas" | "shortcuts";

interface TabDef {
  id: TabId;
  label: string;
  hint: string;
}

const TABS: TabDef[] = [
  { id: "approvals", label: "审批", hint: "工具调用审批" },
  { id: "session", label: "会话", hint: "当前任务元信息" },
  { id: "terminal", label: "终端", hint: "命令执行输出预览" },
  { id: "browser", label: "浏览器", hint: "联网浏览工具视图" },
  { id: "canvas", label: "画布", hint: "设计 / 图表 / 原型 画布" },
  { id: "shortcuts", label: "快捷键", hint: "键盘操作速查" },
];

export default function ToolPanel({
  approvals,
  onRespond,
  session,
  terminalLines,
  onTerminalInput,
  browserUrl,
  onBrowserUrlChange,
}: {
  approvals: ApprovalRequest[];
  onRespond: (id: number, decision: string) => void;
  session: SessionInfo;
  /** 终端输出行（由外部 App 聚合命令 delta 注入）。 */
  terminalLines?: Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }>;
  /** 用户在占位终端里键入命令 → 交给上层处理。 */
  onTerminalInput?: (cmd: string) => void;
  /** 浏览器占位地址。 */
  browserUrl?: string;
  onBrowserUrlChange?: (url: string) => void;
}) {
  const [tab, setTab] = useState<TabId>("approvals");
  const [collapsed, setCollapsed] = useState(false);
  const approvalCount = approvals.length;

  return (
    <div className={`tool-panel ${collapsed ? "collapsed" : ""}`}>
      {/* 抽屉头：Tab 条 + 折叠按钮 */}
      <div className="tool-panel-head">
        <div className="tool-tabs" role="tablist" aria-label="工具抽屉">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              title={t.hint}
              className={`tool-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => {
                setTab(t.id);
                if (collapsed) setCollapsed(false);
              }}
            >
              <span className="tt-label">{t.label}</span>
              {t.id === "approvals" && approvalCount > 0 && (
                <span className="tool-tab-count">{approvalCount}</span>
              )}
            </button>
          ))}
        </div>
        <button
          className="tool-collapse"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "展开工具面板" : "收起工具面板"}
          aria-label={collapsed ? "展开" : "收起"}
        >
          {collapsed ? "‹" : "›"}
        </button>
      </div>

      {/* 抽屉体：折叠时只留极窄条（保留 Tab 条） */}
      {!collapsed && (
        <div className="tool-body" role="tabpanel">
          {tab === "approvals" && (
            <ApprovalPanel hideHeader approvals={approvals} onRespond={onRespond} />
          )}
          {tab === "session" && <SessionDetail s={session} />}
          {tab === "terminal" && (
            <TerminalTab lines={terminalLines ?? []} onInput={onTerminalInput} />
          )}
          {tab === "browser" && (
            <BrowserTab url={browserUrl ?? ""} onUrlChange={onBrowserUrlChange ?? (() => {})} />
          )}
          {tab === "canvas" && <CanvasTab />}
          {tab === "shortcuts" && <ShortcutsPanel />}
        </div>
      )}
    </div>
  );
}

/* ---------- 各 Tab 子组件 ---------- */

function SessionDetail({ s }: { s: SessionInfo }) {
  const rows: Array<[string, string]> = [
    ["模型", s.model || "—"],
    ["提供商", s.provider || "—"],
    ["工作目录", s.cwd || "—"],
    ["线程 ID", s.threadId ? `#${s.threadId.slice(0, 12)}` : "—"],
    ["消息数", s.msgCount != null ? String(s.msgCount) : "—"],
    [
      "状态",
      s.running ? "运行中" : s.approvals && s.approvals > 0 ? `${s.approvals} 条待审批` : "空闲",
    ],
  ];
  return (
    <div className="right-body">
      <div className="session-info-card">
        <div className="si-title">
          <span className="avatar-mini" style={{ width: 22, height: 22, fontSize: 11 }}>
            {s.username ? s.username.slice(0, 1).toUpperCase() : "H"}
          </span>
          <span>{s.title || "新对话"}</span>
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="si-row">
            <span className="si-k">{k}</span>
            <span className="si-v" title={v}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShortcutsPanel() {
  const items: Array<[string, string]> = [
    ["Enter", "发送消息"],
    ["Shift+Enter", "换行"],
    ["Ctrl+N", "新建会话"],
    ["Work 按钮", "只问答，不执行命令 / 改文件"],
    ["Code 按钮", "Agent 全权执行任务"],
    ["自动路由", "按任务类型自动选模型"],
    ["Ctrl+F", "搜索任务 / 历史"],
    ["Ctrl+S", "保存当前会话"],
  ];
  return (
    <div className="right-body">
      <div className="shortcuts-panel">
        {items.map(([k, v]) => (
          <div key={k} className="si-row">
            <span className="si-k">
              <kbd>{k}</kbd>
            </span>
            <span className="si-v">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalTab({
  lines,
  onInput,
}: {
  lines: Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }>;
  onInput?: (cmd: string) => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  if (scrollRef.current) {
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }
  return (
    <div className="right-body tab-terminal">
      <div className="term-head">
        <span className="term-dot" style={{ background: "#EF4444" }} />
        <span className="term-dot" style={{ background: "#F59E0B" }} />
        <span className="term-dot" style={{ background: "#10B981" }} />
        <span className="term-title">workspace — sh</span>
      </div>
      <div className="term-viewport" ref={scrollRef}>
        {lines.length === 0 && (
          <div className="term-muted">
            尚未捕获命令输出。Agent 执行 exec_command 后，输出会显示在这里。
            <br />
            下方输入框为占位手动执行：
          </div>
        )}
        {lines.map((ln, i) => (
          <div
            key={i}
            className={`term-line ${ln.stream === "stderr" ? "err" : ln.stream === "meta" ? "meta" : ""}`}
          >
            <span className="term-ts">{formatTs(ln.ts)}</span>
            <pre>{ln.text}</pre>
          </div>
        ))}
      </div>
      <form
        className="term-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || !onInput) return;
          onInput(input.trim());
          setInput("");
        }}
      >
        <span className="term-prompt">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="sh: 手动命令占位（执行需要审批流程）"
          disabled={!onInput}
        />
      </form>
    </div>
  );
}

function BrowserTab({ url, onUrlChange }: { url: string; onUrlChange: (u: string) => void }) {
  return (
    <div className="right-body tab-browser">
      <form
        className="br-address"
        onSubmit={(e) => e.preventDefault()}
      >
        <span className="br-lock" aria-label="安全连接">HTTPS</span>
        <input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="浏览器占位 — Agent 调用 browser_use 时页面会显示在此"
        />
      </form>
      <div className="br-view">
        <div className="br-placeholder">
          <div className="br-ico">W</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>浏览器工具面板</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
            当 Agent 在 Code / Design 模式中调用 browser_use / web_search
            工具时，页面截图、搜索快照和结果会在此处预览。
            <br />
            点击顶栏「搜索」按钮可立即执行一次联网搜索。
          </div>
        </div>
      </div>
    </div>
  );
}

function CanvasTab() {
  return (
    <div className="right-body tab-canvas">
      <div className="cv-head">
        <div className="cv-title">画布</div>
        <div className="cv-tools">
          <span className="cv-chip">矩形</span>
          <span className="cv-chip">文本</span>
          <span className="cv-chip">箭头</span>
          <span className="cv-chip">便签</span>
        </div>
      </div>
      <div className="cv-view">
        <div className="cv-grid" />
        <div className="cv-placeholder-center">
          <div className="cv-ico">C</div>
          <div style={{ fontWeight: 600 }}>无限画布（占位）</div>
          <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            Design 模式下 Agent 生成的图表 / 架构图 / 线框图将渲染于此。
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Helpers ---------- */

function formatTs(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return "";
  }
}
