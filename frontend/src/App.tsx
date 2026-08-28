import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 应用骨架根组件。T04 阶段仅做最小“Tauri 已接通”校验，
 * 后续 T05/T06 会在此之上叠加 app-server 对话与登录流程。
 */
export default function App() {
  const [greeting, setGreeting] = useState<string>("...");

  useEffect(() => {
    invoke<string>("greet", { name: "Windows" })
      .then(setGreeting)
      .catch((e) => setGreeting(`ERROR: ${e}`));
  }, []);

  return (
    <main className="shell">
      <h1>Harness — 内部 Agent 桌面应用</h1>
      <p className="status">
        Tauri hello from Rust: <code>{greeting}</code>
      </p>
      <p className="hint">目标平台：Windows（.msi/.exe，WebView2）</p>
    </main>
  );
}