//! T08 审批面板：展示 codex 的 `item/commandExecution/requestApproval` /
//! `item/fileChange/requestApproval` 请求，用户确认/拒绝后回包给 app-server。

import type { ApprovalRequest } from "../codexClient";

const DECISIONS = [
  { value: "accept", label: "允许" },
  { value: "acceptForSession", label: "本次会话允许" },
  { value: "decline", label: "拒绝" },
  { value: "cancel", label: "取消并停止" },
] as const;

function describe(a: ApprovalRequest): string {
  const p = a.params as Record<string, unknown>;
  if (a.method === "item/commandExecution/requestApproval") {
    const cmd = typeof p.command === "string" ? p.command : "(命令)";
    const reason = typeof p.reason === "string" && p.reason ? ` · ${p.reason}` : "";
    return `${cmd}${reason}`;
  }
  if (a.method === "item/fileChange/requestApproval") {
    const reason = typeof p.reason === "string" && p.reason ? p.reason : "文件变更";
    return `${reason}`;
  }
  return a.method;
}

export default function ApprovalPanel({
  approvals,
  onRespond,
}: {
  approvals: ApprovalRequest[];
  onRespond: (id: number, decision: string) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="approval-panel">
      <h3>需要审批</h3>
      {approvals.map((a) => (
        <div key={a.id} className="approval-item">
          <code className="approval-cmd">{describe(a)}</code>
          <div className="approval-actions">
            {DECISIONS.map((d) => (
              <button key={d.value} onClick={() => onRespond(a.id, d.value)}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}