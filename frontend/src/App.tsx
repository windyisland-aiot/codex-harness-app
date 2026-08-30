//! T06 基础对话 UI（Trae Work 风格 v6，2026-08-30 精简版）：
//! - 顶栏：42px · 汉堡/搜索/编辑/帮助菜单/主题切换/真实窗口三按钮（Tauri API）；整条 app-region:drag
//! - 左栏：单栏 272px（collapsed 时宽度 0）；顶部 5 菜单项（删除 Work/Code/Design Pill）+ 任务列表 + 底部 user
//! - 中栏：简化 thread-head · TraeWork 气泡 · 欢迎页正中标题+快捷卡片（无模型选择器）
//! - 发送器：圆角 pill 输入框 + 单圆形发送按钮（↑ SVG，紫蓝 gradient）；上方无模型 pill
//! - 模型：仅火山方舟 Ark（responses 直连，不经网关翻译）
//! - 右栏：完全删除；审批改右下角浮层
import { useEffect, useRef, useState } from "react";
import Markdown from "./components/Markdown";
import SettingsPanel from "./components/SettingsPanel";
import ApprovalPanel from "./components/ApprovalPanel";
import * as codex from "./codexClient";
import type {
  ApprovalRequest,
  ResolvedPaths,
  SessionMeta,
} from "./codexClient";

// 窗口控制：Tauri 2.x 下优先用 @tauri-apps/api/window 的 getCurrentWindow() 实例方法。
// 如果 `toggleMaximize` 在个别运行时不存在，退化为 maximize/unmaximize；
// 非 Tauri 环境（Web dev / 沙箱）失败则降级为占位状态消息。
async function withWindow<T>(
  cb: (w: typeof import("@tauri-apps/api/window"), win: any) => Promise<T>,
  fallback: T,
  onErr?: (e: unknown) => void,
): Promise<T> {
  try {
    const w = await import("@tauri-apps/api/window");
    const win = w.getCurrentWindow();
    return await cb(w, win);
  } catch (e) {
    onErr?.(e);
    return fallback;
  }
}
async function doMinimize(setStatus: (s: string) => void) {
  await withWindow(
    async (_w, win) => { await win.minimize(); },
    undefined,
    (e) => setStatus(`最小化失败：${e}`),
  );
}
async function doToggleMaximize(setStatus: (s: string) => void) {
  await withWindow(
    async (_w, win) => {
      // 兼容：部分 tauri-api 打包里没有 toggleMaximize，退化为手动 isMaximized+maximize/unmaximize
      if (typeof (win as any).toggleMaximize === "function") {
        await (win as any).toggleMaximize();
      } else {
        const maximized = await win.isMaximized();
        if (maximized) await win.unmaximize(); else await win.maximize();
      }
    },
    undefined,
    (e) => setStatus(`最大化失败：${e}`),
  );
}
async function doClose(setStatus: (s: string) => void) {
  await withWindow(
    async (_w, win) => { await win.close(); },
    undefined,
    (e) => setStatus(`关闭失败：${e}`),
  );
}

interface Msg {
  role: "user" | "assistant";
  text: string;
}

type SessionStatus = "running" | "approval" | "waiting" | "done" | "error";

interface SessionExt {
  id: string;
  title: string;
  updatedAt?: number;
  status?: SessionStatus;
  provider?: string;
  model?: string;
}

const POLL_MS = 200;
const ONBOARDING_KEY = "harness.onboarding.v1";

/** 基于状态推导会话徽章：running → approval → waiting → done。 */
function deriveBadge(opts: {
  running: boolean;
  approvalCount: number;
  hasMessages: boolean;
  hasError: boolean;
}): SessionStatus {
  if (opts.hasError) return "error";
  if (opts.approvalCount > 0) return "approval";
  if (opts.running) return "running";
  if (opts.hasMessages) return "done";
  return "waiting";
}

const BADGE_LABEL: Record<SessionStatus, string> = {
  running: "运行中",
  approval: "待审批",
  waiting: "待使用",
  done: "已完成",
  error: "出错",
};

const STARTER_CHIPS = [
  { title: "解释代码库", text: "帮我分析当前工作目录的代码结构并生成一个 README 摘要" },
  { title: "写测试", text: "为最近修改过的文件生成单元测试并运行" },
  { title: "调试修复", text: "运行项目测试套件，若有失败请定位原因并修复" },
  { title: "构建发布", text: "执行打包构建，生成产物并说明部署步骤" },
];

/* =============================================================
   内联 SVG 图标（Trae Work 极简 linear 风格，避免 emoji）
   ============================================================= */
const IconHamburger = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);
const IconSearch = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);
const IconSun = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const IconMoon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);
const IconWinMin = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const IconWinMax = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);
const IconWinClose = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const IconSend = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);
const IconCloud = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  </svg>
);
const IconShare = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);
const IconFullscreen = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);
const IconMic = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
  </svg>
);
const IconPlus = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function App() {
  // ------- 运行时路径 -------
  const [paths, setPaths] = useState<ResolvedPaths | null>(null);
  const codexHome = paths?.codexHome ?? "";
  const cwd = paths?.defaultCwd ?? "";

  // ------- 默认模型 -------
  const [model, setModel] = useState("ark-code-latest");
  const [provider, setProvider] = useState("volcengine-ark");

  // ------- 设置面板开关（v0.3.0 统一成单个 SettingsPanel） -------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);

  // ------- 连接 & 状态 -------
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("解析运行路径中…");
  const [lastError, setLastError] = useState<string | null>(null);

  // ------- 会话 / 对话状态 -------
  const [sessions, setSessions] = useState<SessionExt[]>([]);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [sideSearch, setSideSearch] = useState("");

  // ------- 主题 -------
  const [theme, setThemeState] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("harness.theme");
    if (saved === "dark" || saved === "light") return saved;
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  });
  const setTheme = (t: "light" | "dark") => {
    setThemeState(t);
    if (typeof window !== "undefined") window.localStorage.setItem("harness.theme", t);
  };

  // 注意：已移除"自动路由"概念。用户在设置面板里选默认 provider/model，发送直接用。

  // ------- Onboarding -------
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [oboUsername, setOboUsername] = useState("");
  const [oboKey, setOboKey] = useState("");

  // ------- Trae Work v5：左栏 collapsed、终端输出、浏览器 URL -------
  const [collapsed, setCollapsed] = useState(false);
  const [terminalLines, setTerminalLines] = useState<
    Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }>
  >([]);
  const [logOpen, setLogOpen] = useState(false);

  // ------- Refs 用于 timer 里拿最新值 -------
  const threadProviderRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const activeThreadRef = useRef<string | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const termRef = useRef(terminalLines);
  const msgsListRef = useRef<HTMLDivElement>(null);
  const lastErrMergeRef = useRef<{ text: string; count: number } | null>(null);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { activeThreadRef.current = activeThread; }, [activeThread]);
  useEffect(() => { msgsRef.current = messages; }, [messages]);
  useEffect(() => { approvalsRef.current = approvals; }, [approvals]);
  useEffect(() => { termRef.current = terminalLines; }, [terminalLines]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (theme === "dark") document.body.classList.add("theme-dark");
    else document.body.classList.remove("theme-dark");
  }, [theme]);

  // 新消息自动滚到底
  useEffect(() => {
    if (msgsListRef.current) {
      msgsListRef.current.scrollTop = msgsListRef.current.scrollHeight;
    }
  }, [messages, running, lastError]);

  // ------- 启动首步：解析路径 + 连接 app-server + 加载历史会话 -------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await codex.resolvePaths();
        if (cancelled) return;
        setPaths(p);
        setStatus("路径就绪");

        const ua = await codex.start({ codexBin: p.codexBin, codexHome: p.codexHome });
        if (cancelled) return;
        setConnected(true);
        setStatus(`已连接 · ${ua}`);

        try {
          const cfg = await codex.configRead(p.codexHome);
          if (cfg.model) setModel(cfg.model);
          if (cfg.modelProvider) setProvider(cfg.modelProvider);
        } catch { /* 首次无配置用前端默认 */ }

        try {
          const l: SessionMeta[] = await codex.sessionList(p.codexHome);
          if (!cancelled) {
            setSessions(
              l.map((m) => ({
                id: m.id,
                title: m.title || m.id,
                updatedAt: m.updatedAt ? new Date(String(m.updatedAt)).getTime() : undefined,
                provider: m.provider,
                model: m.model,
                status: "done",
              }))
            );
          }
        } catch { /* 首次空目录常见，静默 */ }

        try {
          const already = window.localStorage.getItem(ONBOARDING_KEY);
          if (!already && sessions.length === 0) setOnboardingOpen(true);
        } catch { /* localStorage 受限 */ }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setLastError(msg);
          setStatus(`初始化失败: ${msg}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      codex.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------- T16 自动持久化 -------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeThread || !codexHome) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const msgs = msgsRef.current.map((m, i) => ({ seq: i, role: m.role, text: m.text }));
      const title =
        sessions.find((s) => s.id === activeThread)?.title ||
        msgs[0]?.text.slice(0, 24) ||
        "未命名会话";
      const providerUsed = threadProviderRef.current ?? provider;
      codex
        .sessionSave({
          codexHome, id: activeThread, title, provider: providerUsed, model, cwd, messages: msgs,
        })
        .then(() => {
          setSessions((prev) =>
            prev.some((s) => s.id === activeThread)
              ? prev
              : [...prev, { id: activeThread, title, provider: providerUsed, model }]
          );
        })
        .catch(() => {});
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeThread, codexHome, cwd, model, provider]);

  // ------- 轮询流式事件 + 抓取终端输出 -------
  useEffect(() => {
    if (!running) return;
    timerRef.current = setInterval(async () => {
      if (!runningRef.current) return;
      try {
        const events = await codex.pollEvents();
        const termAccum: Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }> = [];
        for (const e of events) {
          if (e.method === "turn/completed") {
            setRunning(false); setLastError(null);
            lastErrMergeRef.current = null;
            continue;
          }
          if (e.method === "error") {
            // 健壮解析错误信息（递归遍历 params 拿可读字段）
            const msg = extractErrorText(e.params);
            setLastError(msg);
            // 合并连续相同错误：上次一样就只累乘不重复打 stderr 行
            const last = lastErrMergeRef.current;
            if (last && last.text === msg) {
              last.count += 1;
              // 更新已累积的 stderr 行最后一条的 count 文本（原地改 termAccum）
              const idx = termAccum.length - 1;
              if (idx >= 0 && termAccum[idx].text.startsWith("[ERROR] ")) {
                termAccum[idx] = { ts: Date.now(), text: `[ERROR] ${msg}  ×${last.count} 次`, stream: "stderr" };
              }
              continue;
            }
            lastErrMergeRef.current = { text: msg, count: 1 };
            termAccum.push({ ts: Date.now(), text: `[ERROR] ${msg}`, stream: "stderr" });
            // 附一条 JSON dump（meta 流，方便贴到 issue）
            try {
              const dump = JSON.stringify(e.params, null, 2);
              const short = dump.length > 300 ? dump.slice(0, 300) + "…" : dump;
              termAccum.push({ ts: Date.now(), text: `[ERROR-DUMP] ${short}`, stream: "meta" });
            } catch {}
            continue;
          }
          // --- 抓取命令输出（Codex 两种 method 名做双保险）---
          const cmdDelta = extractCmdDelta(e);
          if (cmdDelta) {
            // 非 error 事件出现 → 打断 error 合并
            if (lastErrMergeRef.current) lastErrMergeRef.current = null;
            termAccum.push(cmdDelta);
          }

          const d = codex.textDelta(e);
          if (d === null) continue;
          const cur = msgsRef.current;
          if (cur.length > 0 && cur[cur.length - 1].role === "assistant") {
            const list = [...cur];
            list[list.length - 1] = { ...list[list.length - 1], text: list[list.length - 1].text + d };
            setMessages(list);
          } else {
            setMessages([...cur, { role: "assistant", text: d }]);
          }
        }
        if (termAccum.length > 0) {
          setTerminalLines((prev) => [...prev, ...termAccum].slice(-500));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`事件推送错误: ${msg}`);
        setLastError(msg);
        setRunning(false);
      }
    }, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  // ------- 轮询审批 -------
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(async () => {
      try {
        const list = await codex.pollApprovals();
        if (list.length > 0) {
          setApprovals((prev) => {
            const seen = new Set(prev.map((a) => a.id));
            return [...prev, ...list.filter((a) => !seen.has(a.id))];
          });
        }
      } catch { /* 静默 */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected]);

  // ------- 状态派生 -------
  const activeStatus = deriveBadge({
    running, approvalCount: approvals.length,
    hasMessages: messages.length > 0, hasError: !!lastError,
  });
  const errCount = terminalLines.filter((l) => l.stream === "stderr").length;

  const presetName = provider || model || "未设置";

  // ------- 动作回调 -------
  async function respondApproval(id: number, decision: string) {
    try {
      await codex.respondApproval(id, decision);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
      setTerminalLines((prev) => [
        ...prev,
        { ts: Date.now(), text: `[审批 #${id}] ${decision}`, stream: "meta" as const },
      ].slice(-500));
    } catch (e) { setStatus(`审批回复失败: ${e}`); }
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    if (!connected || !codexHome) { setStatus("运行路径尚未就绪，请稍后"); return; }
    setPending(true); setInput(""); setLastError(null);

    const next = [...msgsRef.current, { role: "user" as const, text }];
    setMessages(next);
    setTerminalLines((prev) => [
      ...prev, { ts: Date.now(), text: `[user]: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`, stream: "meta" as const },
    ].slice(-500));

    try {
      const promptText = text;

      // --- 阶段 1：建线程（如果需要） ---
      let threadId = activeThreadRef.current;
      if (!threadId) {
        setStatus("创建会话…");
        try {
          const nid = await codex.threadStart({ model, modelProvider: provider, cwd });
          threadId = nid;
          threadProviderRef.current = provider;
          setActiveThread(nid);
          setSessions((s) => [...s, {
            id: nid,
            title: text.slice(0, 24) + (text.length > 24 ? "…" : ""),
            provider, model, status: "running",
          }]);
          setTerminalLines((prev) => [
            ...prev, { ts: Date.now(), text: `[thread/start] ok → ${nid}`, stream: "meta" as const },
          ].slice(-500));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setLastError(msg);
          setStatus(`创建会话失败（provider/model 配置不正确或 API Key 无效）：${msg}`);
          setTerminalLines((prev) => [
            ...prev, { ts: Date.now(), text: `[thread/start] 失败: ${msg}`, stream: "stderr" as const },
          ].slice(-500));
          console.error("[thread/start] failed", e);
          return;
        }
      }

      // --- 阶段 2：发消息（turn/start） ---
      const tid = threadId as string;
      setStatus("发送中…");
      try {
        await codex.turnStart({ threadId: tid, cwd, text: promptText });
        setTerminalLines((prev) => [
          ...prev, { ts: Date.now(), text: `[turn/start] ok，等待 LLM 回复…`, stream: "meta" as const },
        ].slice(-500));
        setRunning(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLastError(msg);
        setStatus(`发送消息失败: ${msg}`);
        setTerminalLines((prev) => [
          ...prev, { ts: Date.now(), text: `[turn/start] 失败: ${msg}`, stream: "stderr" as const },
        ].slice(-500));
        console.error("[turn/start] failed", e);
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg); setStatus(`发送失败: ${msg}`);
      console.error("[send] unexpected", e);
    } finally { setPending(false); }
  }

  function newChat() {
    setActiveThread(null); setMessages([]); setApprovals([]); setRunning(false);
    setLastError(null); threadProviderRef.current = null;
  }

  function handleLoadSession(d: codex.SessionDetail) {
    setActiveThread(d.meta.id);
    threadProviderRef.current = d.meta.provider ?? null;
    setMessages(d.messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text })));
    if (d.meta.provider) setProvider(d.meta.provider);
    if (d.meta.model) setModel(d.meta.model);
    setSessions((prev) =>
      prev.some((s) => s.id === d.meta.id) ? prev : [...prev, {
        id: d.meta.id, title: d.meta.title || d.meta.id,
        provider: d.meta.provider, model: d.meta.model, status: "done",
      }]
    );
    setSettingsOpen(false);
  }

  async function handleSideSessionClick(id: string) {
    if (!codexHome) return;
    try {
      const d = await codex.sessionGet(codexHome, id);
      handleLoadSession(d);
    } catch {
      setActiveThread(id); setMessages([]); setApprovals([]); threadProviderRef.current = null;
    }
  }

  function finishOnboarding() {
    try { window.localStorage.setItem(ONBOARDING_KEY, "1"); } catch {}
    setOnboardingOpen(false);
  }

  const filteredSessions = sessions
    .filter((s) => !sideSearch || s.title.toLowerCase().includes(sideSearch.toLowerCase()))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // =============================================================
  // 渲染
  // =============================================================
  const sessionTitle = activeThread
    ? sessions.find((s) => s.id === activeThread)?.title || "新任务"
    : messages.length > 0 ? "任务对话" : "新任务";

  return (
    <div className="app-shell">
      {/* ============ 顶部栏 (42px) ============ */}
      <header className="topbar" style={{ "-webkit-app-region": "drag" } as React.CSSProperties}>
        <button
          className="tb-icon-btn"
          data-tauri-drag-region="false"
          onClick={() => setCollapsed((c) => !c)}
          title="切换侧栏"
        >
          {IconHamburger}
        </button>
        <button
          className="tb-icon-btn"
          data-tauri-drag-region="false"
          onClick={() => setSettingsOpen(true)}
          title="搜索任务"
        >
          {IconSearch}
        </button>
        <button
          className="tb-menu-btn"
          data-tauri-drag-region="false"
          onClick={() => setStatus("菜单栏：编辑(E) 占位（v0.2 实现）")}
        >
          编辑<span className="mn">(E)</span>
        </button>
        <button
          className="tb-menu-btn"
          data-tauri-drag-region="false"
          onClick={() => setStatus("菜单栏：帮助(H) 占位（v0.2 实现）")}
        >
          帮助<span className="mn">(H)</span>
        </button>

        <div className="spacer" />

        <button
          className="tb-icon-btn"
          data-tauri-drag-region="false"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        >
          {theme === "dark" ? IconSun : IconMoon}
        </button>
        <button
          className="tb-win-btn"
          data-tauri-drag-region="false"
          onClick={() => doMinimize(setStatus)}
          title="最小化"
        >{IconWinMin}</button>
        <button
          className="tb-win-btn"
          data-tauri-drag-region="false"
          onClick={() => doToggleMaximize(setStatus)}
          title="最大化"
        >{IconWinMax}</button>
        <button
          className="tb-win-btn close"
          data-tauri-drag-region="false"
          onClick={() => doClose(setStatus)}
          title="关闭"
        >{IconWinClose}</button>
      </header>

      {/* ============ 工作区 ============ */}
      <div className="workspace">
        {/* ---------- 左栏（collapsed 时宽度 0） ---------- */}
        <aside className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="左栏导航与任务">
          {/* 菜单项（5 个） */}
          <nav className="sb-menu" aria-label="主菜单" style={{ paddingTop: 20 }}>
            <button className="sb-menu-item" onClick={newChat}>
              <span className="ic-wrap">{IconPlus}</span>
              <span>新建任务</span>
            </button>
            <button className="sb-menu-item" onClick={() => setSettingsOpen(true)}>
              <span className="ic-wrap gr">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8.11 2.79a3 3 0 0 1 4.24 4.24 3 3 0 0 1 4.24 4.24 3 3 0 0 1 4.62 4.62z"/></svg>
              </span>
              <span>插件市场</span>
            </button>
            <button className="sb-menu-item" onClick={() => setStatus("模板库：敬请期待（v0.2）")}>
              <span className="ic-wrap bl">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
              </span>
              <span>模板库</span>
            </button>
            <button className="sb-menu-item" onClick={() => setStatus("自动化：敬请期待（v0.2）")}>
              <span className="ic-wrap yl">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </span>
              <span>自动化</span>
            </button>
            <button className="sb-menu-item" onClick={() => setSettingsOpen(true)}>
              <span className="ic-wrap gn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </span>
              <span>办公助理</span>
            </button>
          </nav>

          <div className="sb-divider" />

          {/* 任务列表 section header */}
          <div className="sb-section-head">
            <div className="sb-section-label">任务列表</div>
            <div className="sb-section-tools">
              <button className="tb-icon-btn tiny" onClick={() => setSettingsOpen(true)} title="打开会话面板">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              </button>
              <button className="tb-icon-btn tiny" onClick={newChat} title="新建任务">
                {IconPlus}
              </button>
            </div>
          </div>
          <div className="sb-search-row">
            <input
              className="sb-search"
              placeholder="搜索任务…"
              value={sideSearch}
              onChange={(e) => setSideSearch(e.target.value)}
            />
          </div>

          <ul className="sessions">
            {filteredSessions.length === 0 && (
              <li className="empty" style={{ cursor: "default", opacity: 0.7 }}>
                <div className="s-title">（暂无任务）</div>
                <div className="s-meta">输入指令开始第一个任务</div>
              </li>
            )}
            {filteredSessions.map((s) => {
              const isActive = s.id === activeThread;
              const st: SessionStatus = isActive ? activeStatus : s.status || "done";
              const dayLabel = s.updatedAt
                ? new Date(s.updatedAt).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })
                : "—";
              return (
                <li
                  key={s.id}
                  className={isActive ? "active" : ""}
                  onClick={() => handleSideSessionClick(s.id)}
                >
                  <div className="s-title">
                    <span className={`s-dot ${st}`} />
                    <span className="s-text">{s.title}</span>
                  </div>
                  <div className="s-meta">
                    <span className={`badge ${st}`}>{BADGE_LABEL[st]}</span>
                    <span style={{ marginLeft: "auto" }}>{dayLabel}</span>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* 底部 user footer */}
          <div className="sb-footer">
            <div className="avatar" title={oboUsername || "本机用户"}>
              {oboUsername ? oboUsername.slice(0, 1).toUpperCase() : "U"}
            </div>
            <div className="user-info">
              <span className="n">{oboUsername || "本机用户"}</span>
              <span className="r" title={status}>
                {connected ? "在线" : "离线"}
              </span>
            </div>
            <button
              className="tb-icon-btn tiny"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="设置"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
        </aside>

        {/* ---------- 中栏：对话 ---------- */}
        <main className="center">
          <div className="thread-head">
            <div className="title">
              <span className="cloud">{IconCloud}</span>
              <span>{sessionTitle}</span>
            </div>
            <div className="crumbs">
              <span className="model-crumb" title={`${presetName} · ${model}`}>
                <span className="dot" /> {model}
              </span>
              <button className="tb-icon-btn tiny" title="分享（v0.2 占位）" onClick={() => setStatus("分享：敬请期待（v0.2）")}>{IconShare}</button>
              <button className="tb-icon-btn tiny" title="全屏阅读" onClick={() => setStatus("全屏模式：敬请期待（v0.2）")}>{IconFullscreen}</button>
            </div>
          </div>

          <section className="msglist" ref={msgsListRef}>
            {messages.length === 0 ? (
              <div className="placeholder">
                <h1 className="hero-title">今天想做什么？</h1>
                <div className="hero-sub">用自然语言下达任务，Harness 会调用火山方舟 Ark Code 自动完成</div>

                <div className="shortcuts">
                  {STARTER_CHIPS.map((c) => (
                    <div
                      key={c.title}
                      className="chip"
                      onClick={() => { setInput(c.text); }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{c.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role}`}>
                    {m.role === "assistant" && (
                      <div className="msg-avatar harness" title="Harness Agent">H</div>
                    )}
                    <div className={`bubble md ${m.role === "user" ? "user-bubble" : "asst-bubble"}`}>
                      <Markdown text={m.text} />
                    </div>
                  </div>
                ))}
                {running && (
                  <div className="msg assistant">
                    <div className="msg-avatar harness">H</div>
                    <div className="bubble asst-bubble typing">
                      <span className="dots" />
                      <span>Agent 正在执行任务…</span>
                    </div>
                  </div>
                )}
                {lastError && !running && (
                  <div className="msg assistant">
                    <div className="msg-avatar harness" style={{ background: "linear-gradient(135deg,#EF4444,#B91C1C)" }}>!</div>
                    <div className="bubble asst-bubble" style={{ background: "var(--bg-err)", borderColor: "#FECACA", color: "#991B1B" }}>
                      <strong>出错：</strong>{lastError}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* 发送器 composer */}
          <footer className="composer">
            <div className="composer-inner">
              <div className="composer-tools-left">
                <button className="ctool" title="附件（敬请期待 v0.2）" onClick={() => setStatus("附件：v0.2 支持上传/拖拽")}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </button>
                <button className="ctool" title="媒体（敬请期待 v0.2）" onClick={() => setStatus("媒体：v0.2 支持图片/音视频")}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </button>
                <button className="ctool" title="设计工具（敬请期待 v0.2）" onClick={() => setStatus("设计：v0.2 接入 Seedance/Seedream")}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
                </button>
                <button className="ctool" title="MCP 工具（敬请期待 v0.2）" onClick={() => setStatus("MCP 工具：运行中即可使用")}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                </button>
              </div>
              <textarea
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px";
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="告诉 Harness 你想做什么，用自然语言下达任务"
                disabled={pending || running || !paths}
                className="composer-input"
              />
              <div className="composer-send-wrap">
                <button
                  className="btn-send"
                  disabled={pending || running || !paths || !input.trim()}
                  onClick={send}
                  title="发送 (Enter)"
                >
                  {IconSend}
                </button>
              </div>
            </div>

            <div className="composer-meta">
              <div className="meta-left">
                <span className="auto-mode-pill" title="当前使用的模型（设置 → 通用里修改）">
                  <span className="pill-label">模型</span>
                  <span className="pill-val">{provider}/{model}</span>
                </span>
                <span className="status-chip" title={status}>{status}</span>
              </div>
              <div className="meta-right">
                <button className={`log-toggle ${errCount > 0 ? "has-err" : ""}`} onClick={() => setLogOpen((v) => !v)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-6-6-6M12 19h8"/></svg>
                  <span>日志</span>
                  {errCount > 0 && <span className="log-badge">{errCount}</span>}
                </button>
                <button className="tb-icon-btn tiny" title="语音输入（v0.2 占位）" onClick={() => setStatus("语音：敬请期待（v0.2）")}>
                  {IconMic}
                </button>
              </div>
            </div>

            {/* 可折叠错误/日志面板（stderr 高亮） */}
            {logOpen && (
              <div className="log-pane">
                <div className="log-pane-head">
                  <span className="log-pane-title">对话运行日志</span>
                  <div className="log-pane-actions">
                    <span className="log-pane-count">共 {terminalLines.length} 条 {errCount > 0 && <span className="log-pane-err">· {errCount} 错误</span>}</span>
                    <button className="log-clear" onClick={() => setTerminalLines([])}>清空</button>
                    <button className="log-close" onClick={() => setLogOpen(false)}>收起</button>
                  </div>
                </div>
                <div className="log-pane-body">
                  {terminalLines.length === 0 ? (
                    <div className="log-empty">暂无日志。发送消息后会在此显示运行轨迹、API key 注入、provider 调用结果等。</div>
                  ) : terminalLines.map((l, i) => {
                    const isErr = l.stream === "stderr";
                    const isMeta = l.stream === "meta";
                    const time = new Date(l.ts).toLocaleTimeString();
                    return (
                      <div key={i} className={`log-line ${l.stream ?? "stdout"} ${isErr ? "is-err" : isMeta ? "is-meta" : ""}`}>
                        <span className="log-time">{time}</span>
                        <span className="log-tag">{(l.stream ?? "stdout").toUpperCase()}</span>
                        <span className="log-text">{l.text}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </footer>
        </main>

        {/* 右栏：完全删除（原 ToolPanel / 审批/会话/终端/浏览器/画布/快捷键 Tabs 整体移除） */}
      </div>

      {/* ============ 审批浮层（右下角） ============ */}
      {approvals.length > 0 && !approvalOpen && (
        <div className="approval-toast">
          <div className="at-card">
            <div className="at-title">
              <span className="at-dot" /> 有 {approvals.length} 条审批待处理
            </div>
            <div className="at-actions">
              <button className="btn sm" onClick={() => setApprovalOpen(true)}>查看</button>
              <button
                className="btn sm primary"
                onClick={() => {
                  // 一键 accept 最旧的一条
                  if (approvals[0]) respondApproval(approvals[0].id, "accept");
                }}
              >允许最旧</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ ApprovalPanel modal 版 ============ */}
      {approvalOpen && (
        <div className="modal-backdrop" onClick={() => setApprovalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 92vw)" }}>
            <div className="modal-head">
              <h3>审批请求</h3>
              <button className="modal-close" onClick={() => setApprovalOpen(false)}>×</button>
            </div>
            <div className="modal-body">
              <ApprovalPanel approvals={approvals} onRespond={(id, dec) => respondApproval(id, dec)} />
            </div>
          </div>
        </div>
      )}

      {/* ============ Modals（保留全部）============ */}





      {/* ============ 首次启动向导 ============ */}
      {onboardingOpen && (
        <div className="onboarding">
          <div className="onboarding-inner">
            <h1>欢迎使用 Harness AI 工作台</h1>
            <div className="sub">
              你的本地 Agent 工作台，Work/Code/Design 三模式切换，
              火山方舟 Ark Code 已预置为默认模型。
            </div>
            <div className="steps">
              <div className={`step ${onboardingStep >= 1 ? "done" : onboardingStep === 0 ? "now" : ""}`} />
              <div className={`step ${onboardingStep >= 2 ? "done" : onboardingStep === 1 ? "now" : ""}`} />
              <div className={`step ${onboardingStep === 2 ? "now" : ""}`} />
            </div>

            {onboardingStep === 0 && (
              <div className="onboarding-card">
                <h3>工具 · 默认模型已就绪</h3>
                <p>
                  火山方舟 Ark Code（<code>ark-code-latest</code>）已被设为默认模型，
                  API Key 由后端内嵌网关持有，可直接开箱使用。
                  你稍后可以在「设置」中切换到其他厂商。
                </p>
                <div className="ok">· 内嵌 Ark 网关 127.0.0.1:18762 转发真实 Ark 端点</div>
                <div className="ok">· wire_api: responses（Codex 新版协议）</div>
              </div>
            )}

            {onboardingStep === 1 && (
              <div className="onboarding-card">
                <h3>用户 · 账号信息（单机模式）</h3>
                <p>当前为单机运行。填写以下信息用于界面展示。</p>
                <div className="onboarding-form" style={{ marginTop: 10 }}>
                  <div>
                    <label>昵称</label>
                    <input type="text" value={oboUsername} onChange={(e) => setOboUsername(e.target.value)} placeholder="例如：张三" />
                  </div>
                  <div>
                    <label>自定义 API Key（可选，留空则使用预置）</label>
                    <input type="password" value={oboKey} onChange={(e) => setOboKey(e.target.value)} placeholder="自定义火山方舟 API Key（后期替换用）" />
                  </div>
                </div>
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="onboarding-card">
                <h3>开始你的第一个任务</h3>
                <p>点击下方完成即可进入工作台。你可以直接尝试：</p>
                <ul style={{ color: "var(--text-secondary)", fontSize: 13, paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
                  <li>分析当前目录下的项目结构并生成 README</li>
                  <li>运行测试套件，定位并修复失败用例</li>
                  <li>为最近修改过的代码生成单元测试</li>
                </ul>
              </div>
            )}

            <div className="onboarding-foot">
              <button onClick={() => { if (onboardingStep === 0) finishOnboarding(); else setOnboardingStep((s) => s - 1); }}>
                {onboardingStep === 0 ? "跳过" : "上一步"}
              </button>
              {onboardingStep < 2 ? (
                <button className="primary" onClick={() => setOnboardingStep((s) => s + 1)}>下一步</button>
              ) : (
                <button className="primary" onClick={finishOnboarding}>完成，开始使用</button>
              )}
            </div>
          </div>
        </div>
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        codexHome={codexHome}
        codexBin={paths?.codexBin ?? ""}
        onSaved={async () => {
          // codex 已重启（API key + provider 配置生效），重新读取 config 更新本地状态
          try {
            const cfg = await codex.configRead(codexHome);
            if (cfg.model) setModel(cfg.model);
            if (cfg.modelProvider) setProvider(cfg.modelProvider);
          } catch {}
          // 清理当前线程——codex 重启了 thread 引用失效
          setActiveThread(null);
          setMessages([]);
          setRunning(false);
          setStatus("设置已保存并生效 ✅ 可以开始对话了");
        }}
        onStatus={setStatus}
      />
    </div>
  );
}

/* ---------- 工具函数 ---------- */

/** 从任意 JSON-RPC error params 里提取可读错误信息。
 *  Codex 会把错误包成多种形态：
 *    1. { message: "...", code: "...", ... }
 *    2. { error: { message: "...", code: ... }, message?: "..." }
 *    3. { error: "纯字符串" }
 *    4. 嵌套到 item/params/error/ 里
 *    5. Error 对象 JSON 化只剩 {}
 *  本函数递归搜索，优先返回 message/code 组合；实在找不到返回 JSON dump 截断版。
 */
function extractErrorText(p: unknown, depth = 0): string {
  if (p == null) return "模型调用错误";
  if (typeof p === "string") return p;
  if (typeof p === "number" || typeof p === "boolean") return String(p);
  if (depth > 3) return "";
  if (Array.isArray(p)) {
    for (const item of p) {
      const t = extractErrorText(item, depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof p === "object") {
    const o = p as Record<string, unknown>;
    // 优先：error.message + code 组合
    const code = o.code ?? o.errorCode ?? o.status_code ?? o.status ?? o.httpStatus;
    const codeStr = code != null ? ` (${code})` : "";
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim() + codeStr;
    // error 嵌套
    if (o.error != null) {
      const nested = extractErrorText(o.error, depth + 1);
      if (nested) return nested + codeStr;
    }
    // detail / reason / description
    for (const key of ["detail", "reason", "description", "error_description", "err", "statusText"]) {
      if (typeof o[key] === "string" && (o[key] as string).trim()) {
        return (o[key] as string).trim() + codeStr;
      }
    }
    // 兜底：第一个 string 值
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string" && v.trim() && k !== "type") return `${v.trim()}${codeStr}`;
    }
  }
  // 最后兜底：JSON dump（截断）
  try {
    const dump = JSON.stringify(p, null, 2);
    return dump.length > 400 ? dump.slice(0, 400) + "…" : dump;
  } catch {
    return String(p);
  }
}

function shortPath(p: string): string {
  if (!p) return "—";
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join(sep);
}

/** 从事件抽取 exec 输出 delta，用于保留终端逻辑（右栏已移除，但状态机不丢）。 */
function extractCmdDelta(
  e: codex.AppEvent
): null | { ts: number; text: string; stream?: "stdout" | "stderr" | "meta" } {
  void shortPath;
  const p = e.params as Record<string, unknown> | undefined;
  if (!p) return null;
  let delta: unknown = null;
  let streamName: "stdout" | "stderr" | undefined;
  if (e.method === "commandExecution/outputDeltaNotification") {
    delta = p.delta;
    const s = p.outputStream as string | undefined;
    streamName = s === "stderr" ? "stderr" : "stdout";
  } else if (e.method === "item/commandExecution/outputDelta") {
    delta = p.delta;
    const s = p.outputStream as string | undefined;
    streamName = s === "stderr" ? "stderr" : "stdout";
  } else if (e.method === "item/commandExecution/requestApproval") {
    const kind = (p.kind ?? p.commandExecutionKind ?? "命令执行") as string;
    return { ts: Date.now(), text: `[请求审批] ${kind}`, stream: "meta" };
  }
  if (typeof delta === "string" && delta.length > 0) {
    return { ts: Date.now(), text: delta, stream: streamName };
  }
  return null;
}