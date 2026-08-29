//! T08 审批面板（右侧浮栏卡片版）：
//! 展示 codex 的 `item/commandExecution/requestApproval` /
//! `item/fileChange/requestApproval` 请求，用户确认/拒绝后回包给 app-server。
//! 采用 Codex 桌面 App 的右栏审批卡片风格：暖色预警背景 + 命令代码块 + 4 种决策按钮。

import type { ApprovalRequest } from "../codexClient";

const DECISIONS = [
  { value: "accept", label: "允许", cls: "primary" },
  { value: "acceptForSession", label: "会话内允许", cls: "" },
  { value: "decline", label: "拒绝", cls: "" },
  { value: "cancel", label: "停止", cls: "danger" },
] as const;

function summarize(a: ApprovalRequest) {
  const p = a.params as Record<string, unknown>;
  if (a.method === "item/commandExecution/requestApproval") {
    const kind = typeof p.kind === "string" ? p.kind : "exec";
    const command =
      typeof p.command === "string" ? p.command :
      Array.isArray(p.command) ? (p.command as string[]).join(" ") : "(命令)";
    const reason = typeof p.reason === "string" && p.reason ? p.reason : "";
    const cwd = typeof p.cwd === "string" ? p.cwd : "";
    return {
      kind: "命令执行",
      badge: kind,
      command,
      reason,
      cwd,
    };
  }
  if (a.method === "item/fileChange/requestApproval") {
    const reason = typeof p.reason === "string" && p.reason ? p.reason : "文件变更";
    const patch = typeof p.patch === "string" ? p.patch : "";
    const path = typeof p.path === "string" ? p.path : "";
    return {
      kind: "文件变更",
      badge: path ? "file" : "patch",
      command: patch || path || reason,
      reason,
      cwd: path,
    };
  }
  return {
    kind: "需要审批",
    badge: "?",
    command: a.method,
    reason: "",
    cwd: "",
  };
}

export default function ApprovalPanel({
  approvals,
  onRespond,
  hideHeader = false,
}: {
  approvals: ApprovalRequest[];
  onRespond: (id: number, decision: string) => void;
  hideHeader?: boolean;
}) {
  return (
    <>
      {!hideHeader && (
        <header className="right-head">
          <span>审批 · Approvals</span>
          {approvals.length > 0 && <span className="count">{approvals.length}</span>}
        </header>
      )}
      <div className="right-body">
        {approvals.length === 0 ? (
          <div className="right-empty">
            暂无需审批的操作 <br />
            <span style={{ opacity: 0.7 }}>Agent 执行命令 / 修改文件时会在这里请求确认</span>
          </div>
        ) : (
          approvals.map((a) => {
            const s = summarize(a);
            return (
              <div key={a.id} className="approval-card">
                <h4>
                  请求 · {s.kind}
                  <span className="kbd">{s.badge}</span>
                  <span className="kbd">#{a.id}</span>
                </h4>
                <div className="approval-command">{s.command}</div>
                <div className="approval-info">
                  {s.reason && (
                    <div className="row">
                      <span className="k">原因</span>
                      <span>{s.reason}</span>
                    </div>
                  )}
                  {s.cwd && (
                    <div className="row">
                      <span className="k">路径</span>
                      <span style={{ fontFamily: "var(--mono)", wordBreak: "break-all" }}>{s.cwd}</span>
                    </div>
                  )}
                </div>
                <div className="approval-actions">
                  {DECISIONS.map((d) => (
                    <button
                      key={d.value}
                      className={d.cls}
                      onClick={() => onRespond(a.id, d.value)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
