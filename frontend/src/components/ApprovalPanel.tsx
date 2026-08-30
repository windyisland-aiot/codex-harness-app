//! T08 审批面板（Trae Work 图一风格：⚠️ 大标题 + 授权路径 pill + 命令代码块 + 4 级编号按钮）
//! 展示 codex 的 `item/commandExecution/requestApproval` /
//! `item/fileChange/requestApproval` 请求，用户选择 4 种决策后回包。
//!
//! 决策映射（匹配 Codex 协议的 decision 枚举）：
//!   ① 仅本次运行   → accept            (只批准这一次，下次同命令还要再问)
//!   ② 本次会话允许   → acceptForSession (当前 codex session 内同类/同命令直接过)
//!   ③ 始终允许      → acceptForSession (协议无永久级，保留占位；对用户提示"当前版本等价于会话级")
//!   ④ 拒绝执行      → decline           (不执行，codex 走 fallback 或失败提示)

import { useState } from "react";
import type { ApprovalRequest } from "../codexClient";

interface Dec {
  value: "accept" | "acceptForSession" | "decline";
  label: string;
  idx: string;
  hint: string;
  danger?: boolean;
}

const DECISIONS_COMMAND: Dec[] = [
  { value: "accept",            idx: "1", label: "仅本次运行",   hint: "只允许这一条命令，下一条再问" },
  { value: "acceptForSession",  idx: "2", label: "本次会话允许", hint: "当前会话中相同命令直接通过" },
  { value: "acceptForSession",  idx: "3", label: "始终允许",     hint: "v0.4 当前版本等价于「本次会话允许」" },
  { value: "decline",           idx: "4", label: "拒绝执行",     hint: "不执行该命令", danger: true },
];

const DECISIONS_FILE: Dec[] = [
  { value: "accept",            idx: "1", label: "仅本次修改",   hint: "只接受这次文件改动" },
  { value: "acceptForSession",  idx: "2", label: "本次会话允许", hint: "当前会话同类写入直接通过" },
  { value: "acceptForSession",  idx: "3", label: "始终允许",     hint: "v0.4 当前版本等价于「本次会话允许」" },
  { value: "decline",           idx: "4", label: "拒绝修改",     hint: "不写入，丢弃 patch", danger: true },
];

interface Summarized {
  kind: string;
  title: string;               // 标题行：⚠️ "是否允许运行这个命令？" 等
  scopeLabel: string;          // 权限描述，如"授权路径读写权限"
  scopeValue: string;          // 权限具体值，如路径 / 文件名
  codeBlock: string;           // 命令 / patch / 代码块
  decisions: Dec[];
}

function summarize(a: ApprovalRequest): Summarized {
  const p = a.params as Record<string, unknown>;
  if (a.method === "item/commandExecution/requestApproval") {
    const command =
      typeof p.command === "string" ? p.command :
      Array.isArray(p.command) ? (p.command as unknown[]).map(String).join(" ") : "(命令)";
    const cwd = typeof p.cwd === "string" ? p.cwd : "";
    return {
      kind: "command",
      title: "是否允许运行这个命令？",
      scopeLabel: "授权路径读写权限：",
      scopeValue: cwd,
      codeBlock: command,
      decisions: DECISIONS_COMMAND,
    };
  }
  if (a.method === "item/fileChange/requestApproval") {
    const path = typeof p.path === "string" ? p.path : "(未命名 patch)";
    const patch = typeof p.patch === "string" ? p.patch : "";
    const reason = typeof p.reason === "string" && p.reason ? p.reason : "";
    return {
      kind: "file",
      title: "是否允许修改这个文件？",
      scopeLabel: "目标文件：",
      scopeValue: path,
      codeBlock: patch || reason || `# 写入文件：${path}`,
      decisions: DECISIONS_FILE,
    };
  }
  return {
    kind: "other",
    title: "是否允许执行该操作？",
    scopeLabel: "请求方法：",
    scopeValue: a.method,
    codeBlock: JSON.stringify(p, null, 2),
    decisions: DECISIONS_COMMAND,
  };
}

function IconWarn() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}
function IconArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 5l7 7-7 7"/>
    </svg>
  );
}

export default function ApprovalPanel({
  approvals,
  onRespond,
  // hideHeader 为占位 prop：ToolPanel 传 true 以便后续扩展（外层已有 Tab 头部），
  // 当前版本卡片形态在外层弹窗/抽屉均无额外差异，保留接口以避免类型报错。
  hideHeader: _hideHeader,
}: {
  approvals: ApprovalRequest[];
  onRespond: (id: number, decision: string) => void;
  /** 内嵌在 ToolPanel 抽屉时为 true（外层已有 Tab 标题），审批弹窗里不传。 */
  hideHeader?: boolean;
}) {
  void _hideHeader;
  const [hoveredIdx, setHoveredIdx] = useState<Record<string, number | null>>({});

  if (approvals.length === 0) {
    return (
      <div style={{ padding: "40px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        暂无需审批的操作
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          Agent 执行命令 / 修改文件时会在这里请求确认
        </div>
      </div>
    );
  }

  return (
    <div className="tw-approval-stack">
      {approvals.map((a) => {
        const s = summarize(a);
        const hov = hoveredIdx[String(a.id)];
        return (
          <div key={a.id} className="tw-approval-card">
            {/* 标题：⚠️ 图标 + 粗体问句 */}
            <div className="tw-a-title">
              <IconWarn />
              <h3>{s.title}</h3>
            </div>

            {/* 权限 scope 标签 + 值 pill（深灰圆角） */}
            <div className="tw-a-scope">
              <div className="tw-a-scope-label">{s.scopeLabel}</div>
              {s.scopeValue && (
                <div className="tw-a-scope-pill" title={s.scopeValue}>
                  {s.scopeValue}
                </div>
              )}
            </div>

            {/* 命令 / patch 代码块（monospace 灰底） */}
            <div className="tw-a-code" title={s.codeBlock}>
              {s.codeBlock}
            </div>

            {/* 4 级编号按钮列表 */}
            <ul className="tw-a-decisions">
              {s.decisions.map((d, i) => (
                <li
                  key={`${d.idx}-${i}`}
                  className={`tw-a-decision ${d.danger ? "danger" : ""} ${hov === i ? "is-hover" : ""}`}
                  onMouseEnter={() => setHoveredIdx((m) => ({ ...m, [String(a.id)]: i }))}
                  onMouseLeave={() => setHoveredIdx((m) => ({ ...m, [String(a.id)]: null }))}
                  onClick={() => onRespond(a.id, d.value)}
                >
                  <span className="tw-a-idx">{d.idx}</span>
                  <span className="tw-a-dec-label">{d.label}</span>
                  <span className="tw-a-hint">{d.hint}</span>
                  <span className="tw-a-arrow">{hov === i ? <IconArrow /> : null}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
