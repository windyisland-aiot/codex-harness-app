//! T11 模型路由：按任务类型自动推荐模型，并可在发送前应用到当前会话。
import { useState } from "react";
import { route } from "../codexClient";
import type { RouteDecision } from "../codexClient";

export default function RouterPanel({
  prompt,
  disabled,
  autoRoute,
  onAutoRouteChange,
  sensitive,
  onSensitiveChange,
  onRouted,
}: {
  prompt: string;
  disabled: boolean;
  autoRoute: boolean;
  onAutoRouteChange: (v: boolean) => void;
  sensitive: boolean;
  onSensitiveChange: (v: boolean) => void;
  /** 手动路由命中后回调，携带决策；`null` 表示失败。 */
  onRouted: (d: RouteDecision | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [time, setTime] = useState("");

  /** 手动触发一次路由（基于当前输入框内容）。 */
  async function runRoute() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const d = await route(prompt, { sensitive });
      setDecision(d);
      setTime(new Date().toLocaleTimeString());
      onRouted(d);
    } catch (e) {
      setDecision(null);
      setTime("");
      onRouted(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="router-panel">
      <label className="router-auto">
        <input
          type="checkbox"
          checked={autoRoute}
          onChange={(e) => onAutoRouteChange(e.target.checked)}
        />
        发送前自动路由
      </label>
      <label className="router-sensitive">
        <input
          type="checkbox"
          checked={sensitive}
          onChange={(e) => onSensitiveChange(e.target.checked)}
        />
        敏感请求
      </label>
      <button
        className="router-btn"
        onClick={runRoute}
        disabled={disabled || busy || !prompt.trim()}
      >
        {busy ? "路由中…" : "路由"}
      </button>
      {decision && (
        <span className="router-decision" title={decision.reason}>
          → {decision.provider}/{decision.model}
          {time && <span className="router-time"> · {time}</span>}
        </span>
      )}
    </div>
  );
}