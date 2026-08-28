//! T06 基础对话 UI：指令输入、流式输出（Markdown 渲染）、会话列表。
//! T08 审批面板：命令/文件变更需审批时弹出确认/拒绝。
import { useEffect, useRef, useState } from "react";
import Markdown from "./components/Markdown";
import ApprovalPanel from "./components/ApprovalPanel";
import ConfigPanel from "./components/ConfigPanel";
import * as codex from "./codexClient";
import type { ApprovalRequest, AppConfig } from "./codexClient";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

interface Session {
  id: string;
  title: string;
}

const DEFAULT_CODEX_BIN = "/workspace/codex/codex-rs/target/debug/codex";
const DEFAULT_CODEX_HOME = "/workspace/codex-harness-app/.codex-test";
const codexBin = DEFAULT_CODEX_BIN;
const POLL_MS = 200;

export default function App() {
  // 会话/模型参数：T09 配置面板加载并覆盖 model/provider。
  const codexHome = DEFAULT_CODEX_HOME;
  const [model, setModel] = useState("mock-model");
  const [provider, setProvider] = useState("mock");
  const [cfgOpen, setCfgOpen] = useState(false);
  const cwd = "/workspace/codex-harness-app";

  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("未连接");

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  const runningRef = useRef(false);
  const activeThreadRef = useRef<string | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);
  useEffect(() => {
    msgsRef.current = messages;
  }, [messages]);

  // 自动连接 app-server
  useEffect(() => {
    codex
      .start({ codexBin, codexHome })
      .then((ua) => {
        setConnected(true);
        setStatus(`已连接 · ${ua}`);
      })
      .catch((e) => setStatus(`连接失败: ${e}`));
    return () => {
      codex.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 轮询流式事件
  useEffect(() => {
    if (!running) return;
    timerRef.current = setInterval(async () => {
      if (!runningRef.current) return;
      try {
        const events = await codex.pollEvents();
        for (const e of events) {
          if (e.method === "turn/completed") {
            setRunning(false);
            continue;
          }
          const d = codex.textDelta(e);
          if (d === null) continue;
          // 追加到最新一条 assistant 消息
          const cur = msgsRef.current;
          if (cur.length > 0 && cur[cur.length - 1].role === "assistant") {
            const list = [...cur];
            list[list.length - 1] = {
              ...list[list.length - 1],
              text: list[list.length - 1].text + d,
            };
            setMessages(list);
          } else {
            setMessages([...cur, { role: "assistant", text: d }]);
          }
        }
      } catch (e) {
        setStatus(`事件推送错误: ${e}`);
        setRunning(false);
      }
    }, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [running]);

  // 轮询审批请求：只在前端持有待审批项为空时继续（避免重复弹窗应由后端缓冲保证）。
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(async () => {
      try {
        const list = await codex.pollApprovals();
        if (list.length > 0) {
          setApprovals((prev) => [...prev, ...list]);
        }
      } catch (e) {
        // 轮询失败静默，避免打断对话状态。
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected]);

  async function respondApproval(id: number, decision: string) {
    try {
      await codex.respondApproval(id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setStatus(`审批回复失败: ${e}`);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    if (!connected) {
      setStatus("请先连接 app-server");
      return;
    }
    setPending(true);
    setInput("");

    // 追加用户消息
    const next = [...msgsRef.current, { role: "user" as const, text }];
    setMessages(next);

    try {
      let threadId = activeThreadRef.current;
      if (!threadId) {
        const nid = await codex.threadStart({ model, modelProvider: provider, cwd });
        threadId = nid;
        setActiveThread(nid);
        setSessions((s) => [
          ...s,
          { id: nid, title: text.slice(0, 24) + (text.length > 24 ? "…" : "") },
        ]);
      }
      const tid = threadId as string;
      await codex.turnStart({ threadId: tid, cwd, text });
      setRunning(true);
    } catch (e) {
      setStatus(`发送失败: ${e}`);
    } finally {
      setPending(false);
    }
  }

  function newChat() {
    setActiveThread(null);
    setMessages([]);
  }

  function onConfigSaved(c: AppConfig) {
    if (c.model) setModel(c.model);
    if (c.model_provider) setProvider(c.model_provider);
  }

  return (
    <div className="chat">
      <aside className="sidebar">
        <h1>Harness · Agent</h1>
        <button className="new-btn" onClick={newChat}>
          ＋ 新建会话
        </button>
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeThread ? "active" : ""}>
              <span
                className="session-title"
                onClick={() => {
                  setActiveThread(s.id);
                  setMessages([]);
                }}
              >
                {s.title}
              </span>
            </li>
          ))}
        </ul>
        <button className="new-btn" onClick={() => setCfgOpen(true)}>
          ⚙ 配置
        </button>
        <div className="conn">
          <div className={`dot ${connected ? "on" : "off"}`} /> {status}
        </div>
      </aside>

      <main className="main">
        <ApprovalPanel approvals={approvals} onRespond={respondApproval} />
        <section className="msglist">
          {messages.length === 0 && (
            <div className="placeholder">输入指令开始与 Agent 对话</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">
                <Markdown text={m.text} />
              </div>
            </div>
          ))}
          {running && <div className="typing">正在推理…</div>}
        </section>

        <footer className="inputbar">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="输入指令（Enter 发送）"
            disabled={pending || running}
          />
          <button onClick={send} disabled={pending || running}>
            发送
          </button>
          <span className="cfg">
            model={model} provider={provider} · {cwd}
          </span>
        </footer>
      </main>

      <ConfigPanel
        open={cfgOpen}
        onClose={() => setCfgOpen(false)}
        codexHome={codexHome}
        onSaved={onConfigSaved}
        onStatus={setStatus}
      />
    </div>
  );
}