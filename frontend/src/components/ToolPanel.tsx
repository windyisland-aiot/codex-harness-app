//! 右栏工具面板（形态参考 Trae Work 的工具面板）：
//! 页签 = 审批 / 会话 / 快捷键。不借鉴 Trae Work 功能，仅借界面形态
//! （多页签 + 状态摘要），内容沿用本应用既有功能。

import { useState } from "react";
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

const TABS = [
  { id: "approvals", icon: "⚠", label: "审批" },
  { id: "session", icon: "▤", label: "会话" },
  { id: "shortcuts", icon: "⌘", label: "快捷键" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function SessionDetail({ s }: { s: SessionInfo }) {
  const rows: Array<[string, string]> = [
    ["模型", s.model || "—"],
    ["提供商", s.provider || "—"],
    ["工作目录", s.cwd || "—"],
    ["线程 ID", s.threadId ? `#${s.threadId.slice(0, 12)}` : "—"],
    ["消息数", s.msgCount != null ? String(s.msgCount) : "—"],
    ["状态", s.running ? "运行中" : s.approvals && s.approvals > 0 ? `${s.approvals} 条待审批` : "空闲"],
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
            <span className="si-v">{v}</span>
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
    ["Ask 按钮", "只问答，不执行命令 / 改文件"],
    ["Code 按钮", "Agent 全权执行任务"],
    ["自动路由", "按任务类型自动选择模型"],
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

export default function ToolPanel({
  approvals,
  onRespond,
  session,
}: {
  approvals: ApprovalRequest[];
  onRespond: (id: number, decision: string) => void;
  session: SessionInfo;
}) {
  const [tab, setTab] = useState<TabId>("approvals");
  const approvalCount = approvals.length;

  return (
    <>
      <div className="tool-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tool-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
            {t.id === "approvals" && approvalCount > 0 && (
              <span className="tool-tab-count">{approvalCount}</span>
            )}
          </button>
        ))}
      </div>
      {tab === "approvals" && <ApprovalPanel hideHeader approvals={approvals} onRespond={onRespond} />}
      {tab === "session" && <SessionDetail s={session} />}
      {tab === "shortcuts" && <ShortcutsPanel />}
    </>
  );
}