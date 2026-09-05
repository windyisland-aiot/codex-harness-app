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
import PluginsPanel from "./components/PluginsPanel";
import ApprovalPanel from "./components/ApprovalPanel";
import * as codex from "./codexClient";
import type {
  ApprovalRequest,
  ResolvedPaths,
} from "./codexClient";
import { ALL_MODELS, modelInfo, modelLogo } from "./models";

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

// ---------- 自动化任务 ----------
type TriggerKind = "daily" | "interval" | "weekday" | "weekly";
interface AutoTask {
  id: string;
  name: string;
  kind: TriggerKind;
  trigger: string;          // 原始触发描述，如 "每天 09:00" / "每 30 分钟"
  cronExpr: string;         // 供计算用的内部表达式
  content: string;          // 要执行的任务内容
  outputPath: string;       // 输出文件存储路径
  on: boolean;
  nextRun: number;          // 下一次执行的时间戳（ms）
  lastRun?: number;
  lastStatus?: "success" | "failed";
}
interface AutoHistoryItem {
  id: string;
  taskId: string;
  taskName: string;
  time: number;
  status: "success" | "failed";
  durMs: number;
  trigger: "定时触发" | "手动触发";
  note?: string;
}

/**
 * 简易 cron 解析器：计算下一次运行时间。
 * 支持：
 *   - 每天 HH:MM            → kind=daily    expr="HH:MM"
 *   - 每 N 分钟              → kind=interval expr="N"
 *   - 工作日 HH:MM          → kind=weekday  expr="HH:MM"
 *   - 每周 N HH:MM          → kind=weekly   expr="N HH:MM"   (N=1..7, 1=周一)
 *   - 多个时间点             → expr 里用 "|" 分隔，如 "10:00|15:00"
 */
function computeNextRun(kind: TriggerKind, cronExpr: string, fromTs = Date.now()): number {
  const base = new Date(fromTs);
  const makeAt = (h: number, m: number, d = new Date()) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x.getTime();
  };

  if (kind === "interval") {
    const minutes = Math.max(1, parseInt(cronExpr, 10) || 30);
    return fromTs + minutes * 60 * 1000;
  }

  const times = cronExpr.split("|").map((s) => s.trim()).filter(Boolean);
  const candidates: number[] = [];

  if (kind === "daily" || kind === "weekday") {
    for (const t of times) {
      const [h, m] = t.split(":").map((x) => parseInt(x, 10));
      if (isNaN(h) || isNaN(m)) continue;
      // 今天
      let ts = makeAt(h, m, base);
      if (kind === "weekday") {
        // 若是周末则跳到周一
        while (new Date(ts).getDay() === 0 || new Date(ts).getDay() === 6) {
          ts += 24 * 3600 * 1000;
        }
      }
      if (ts <= fromTs) {
        ts += 24 * 3600 * 1000;
        if (kind === "weekday") {
          while (new Date(ts).getDay() === 0 || new Date(ts).getDay() === 6) {
            ts += 24 * 3600 * 1000;
          }
        }
      }
      candidates.push(ts);
    }
  } else if (kind === "weekly") {
    for (const t of times) {
      const [n, hm] = t.split(/\s+/);
      const dayNum = Math.max(1, Math.min(7, parseInt(n, 10) || 1));
      const [h, m] = (hm || "").split(":").map((x) => parseInt(x, 10));
      if (isNaN(h) || isNaN(m)) continue;
      const targetDow = dayNum === 7 ? 0 : dayNum; // 1=周一 → 1, 7=周日 → 0
      let ts = makeAt(h, m, base);
      let curDow = new Date(ts).getDay();
      let diff = targetDow - curDow;
      if (diff < 0) diff += 7;
      ts += diff * 24 * 3600 * 1000;
      if (ts <= fromTs) ts += 7 * 24 * 3600 * 1000;
      candidates.push(ts);
    }
  }

  if (candidates.length === 0) return fromTs + 3600 * 1000;
  return Math.min(...candidates);
}

/** 解析用户输入的触发描述（中文自然语言）→ { kind, cronExpr }  */
function parseTriggerInput(text: string): { kind: TriggerKind; cronExpr: string; display: string } {
  const t = text.trim();
  // 每 N 分钟 / 小时
  const mInterval = t.match(/每\s*(\d+)\s*(分钟|小时)/);
  if (mInterval) {
    let min = parseInt(mInterval[1], 10);
    if (mInterval[2] === "小时") min *= 60;
    return { kind: "interval", cronExpr: String(min), display: t };
  }
  // 工作日 HH:MM
  const mWeekday = t.match(/工作日\s*(.+)/);
  if (mWeekday) {
    const times = mWeekday[1].split(/[,，/、]/).map((s) => s.trim()).filter(Boolean);
    return { kind: "weekday", cronExpr: times.join("|"), display: t };
  }
  // 每周 N HH:MM  /  每周 N
  const mWeekly = t.match(/每周\s*([一二三四五六日天1-7]+)\s*(.+)?/);
  if (mWeekly) {
    const dayMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    let n: number | null = null;
    if (/[1-7]/.test(mWeekly[1])) n = parseInt(mWeekly[1], 10);
    else n = dayMap[mWeekly[1]] ?? 1;
    const rest = (mWeekly[2] || "09:00").trim();
    const times = rest.split(/[,，/、]/).map((s) => s.trim()).filter(Boolean);
    const expr = times.map((tm) => `${n} ${tm}`).join("|");
    return { kind: "weekly", cronExpr: expr, display: t };
  }
  // 每天
  const mDaily = t.match(/每天\s*(.+)/);
  if (mDaily) {
    const times = mDaily[1].split(/[,，/、]/).map((s) => s.trim()).filter(Boolean);
    return { kind: "daily", cronExpr: times.join("|"), display: t };
  }
  // 兜底：每天一次
  return { kind: "daily", cronExpr: "09:00", display: t || "每天 09:00" };
}

function formatNextRun(ts: number): string {
  const diffMin = Math.round((ts - Date.now()) / 60000);
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diffMin <= 0) return `${abs}（到期）`;
  if (diffMin < 60) return `${abs} · ${diffMin} 分钟后`;
  if (diffMin < 60 * 24) return `${abs} · ${Math.round(diffMin / 60)} 小时后`;
  return `${abs} · ${Math.round(diffMin / 1440)} 天后`;
}
function formatTimeAgo(ts?: number): string {
  if (!ts) return "—";
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 0) return "—";
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)} 小时前`;
  return `${Math.round(diffMin / 1440)} 天前`;
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
/* 左上角 sidebar toggle：圆角深色方块 + 白色竖条（Trae Work 图一样式） */
const IconHamburger = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="5" className="tbtn-shell" />
    <rect x="10.5" y="7" width="3" height="10" rx="1.5" className="tbtn-bar" />
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
const IconApproval = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const IconCaretDown = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
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
  const [autoModeOpen, setAutoModeOpen] = useState(false);

  // ------- 附件（多模态文件上传） -------
  interface Attachment { name: string; size: number; kind: "image" | "video" | "doc"; preview?: string; }
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openFilePicker() {
    const current = modelInfo(model);
    if (!current.multiModal) {
      setStatus(`⚠ 模型 ${current.name} 不支持图片/视频/文档，请先切换到多模态模型`);
      setLastError(`当前模型「${current.name}」是纯文本模型，不支持多模态输入。请在右侧切换到支持多模态的模型（如 doubao-seed-2.0-lite / deepseek-v4-flash 等）后再上传文件。`);
      return;
    }
    fileInputRef.current?.click();
  }

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const newItems: Attachment[] = files.map((f) => {
      const isImage = f.type.startsWith("image/");
      const isVideo = f.type.startsWith("video/");
      return {
        name: f.name,
        size: f.size,
        kind: isImage ? "image" : isVideo ? "video" : "doc",
        preview: isImage ? URL.createObjectURL(f) : undefined,
      };
    });
    setAttachments((prev) => [...prev, ...newItems]);
    setStatus(`已附加 ${newItems.length} 个文件，发送时一并提交`);
    // reset 以便下次选同一文件也能触发 change
    e.target.value = "";
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // ------- 设置面板开关（v0.3.0 统一成单个 SettingsPanel） -------
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ------- 插件管理：独立页面（v0.5.3 起不再挂在设置面板里） -------
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);

  // ------- 连接 & 状态 -------
  const [connected] = useState(false);
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

  // ------- B2 云端 codex 桥 -------
  const [cloudMode, setCloudMode] = useState(false);
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudUser, setCloudUser] = useState("");
  const [cloudPass, setCloudPass] = useState("");
  const [cloudStage, setCloudStage] = useState<string | null>(null);
  const cloudSessionRef = useRef<string | null>(null);
  // 当前选用的云端 skill（不传 = 后端默认；talk-script = 脚本生成工作流）
  const [selectedSkill, setSelectedSkill] = useState<string>("talk-script");

  // ------- T6 模板库抽屉（广告脚本 5 步模板） -------
  const [templateOpen, setTemplateOpen] = useState(false);
  type TemplateId = "ad_script" | "manual_summarize_weekly";
  const TEMPLATES: Array<{
    id: TemplateId;
    icon: string;
    title: string;
    subtitle: string;
    prompt: string;
    tag?: string;
  }> = [
    {
      id: "ad_script",
      icon: "🎬",
      title: "广告脚本生成（RAG → LLM × 2 → Bitable → 飞书审批）",
      subtitle: "5 步协同工作流：品牌话术检索 → 初稿 → 润色 → 写 Bitable → 提单审批",
      tag: "T21 · AdScriptWorkflow",
      prompt: [
        "【广告脚本生成工作流 · 5 步】",
        "",
        "【第 1 步 · 检索知识库】请调用 RAG 检索：品牌话术、竞品分析、历史脚本案例，关键词提取自 brief（品牌 / 品类 / 卖点）。",
        "",
        "【第 2 步 · 生成初稿】基于 brief + 第 1 步检索到的参考片段，输出 3 套广告脚本（每条 <= 180 字，包含：Hook、卖点、CTA）。",
        "",
        "【第 3 步 · 润色定稿】挑出最佳的 1 条，按品牌语气进行润色；输出「脚本标题 / 最终稿 / 可选 B 版 / 拍摄建议」四段结构。",
        "",
        "【第 4 步 · 写入飞书多维表格】把第 3 步结果写入多维表格：字段 = {品牌、品类、脚本标题、脚本正文、拍摄建议、创建时间、状态=draft}。",
        "",
        "【第 5 步 · 飞书审批提单】对上述脚本执行「提交飞书审批」：审批说明包含脚本标题与正文预览；审批通过后状态置 approved。",
        "",
        "请开始执行工作流。",
      ].join("\n"),
    },
    {
      id: "manual_summarize_weekly",
      icon: "📊",
      title: "周报/总结助手",
      subtitle: "通用工作周报模板，按：本周产出 / 风险与阻塞 / 下周计划 三段输出",
      prompt: [
        "请帮我生成一份本周工作周报，按三段结构整理：",
        "1. 本周产出（3-8 条，动宾开头）",
        "2. 风险与阻塞（如无则写「无」）",
        "3. 下周计划（3-5 条）",
        "以下是我的本周零散记录（可补充具体条目）：",
        "……",
      ].join("\n"),
    },
  ];
  const applyTemplate = (id: TemplateId) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setInput((prev) => (prev.trim() ? `${prev}\n\n${t.prompt}` : t.prompt));
    setTemplateOpen(false);
    setStatus(`已应用模板：${t.title}`);
  };

  // ------- Trae Work v5：左栏 collapsed、终端输出、浏览器 URL -------
  const [collapsed, setCollapsed] = useState(false);
  const [terminalLines, setTerminalLines] = useState<
    Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }>
  >([]);
  const [logOpen, setLogOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState<{ open: boolean; id: string; title: string }>({ open: false, id: "", title: "" });
  const [accessMode, setAccessMode] = useState<"auto" | "full">("auto");
  const [automationOpen, setAutomationOpen] = useState(false);
  const [autoTab, setAutoTab] = useState<"configured" | "templates" | "history">("configured");
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);

  // ESC 快捷键：退出自动化面板 / 关闭 modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (showNewTaskModal) { setShowNewTaskModal(false); return; }
      if (automationOpen) { setAutomationOpen(false); return; }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [automationOpen, showNewTaskModal]);

  // ---------- 自动化任务状态（localStorage 持久化） ----------
  const AUTO_TASKS_KEY = "harness.auto.tasks.v1";
  const AUTO_HISTORY_KEY = "harness.auto.history.v1";
  const [autoTasks, setAutoTasks] = useState<AutoTask[]>(() => {
    try {
      const raw = window.localStorage.getItem(AUTO_TASKS_KEY);
      return raw ? (JSON.parse(raw) as AutoTask[]) : [];
    } catch { return []; }
  });
  const [autoHistory, setAutoHistory] = useState<AutoHistoryItem[]>(() => {
    try {
      const raw = window.localStorage.getItem(AUTO_HISTORY_KEY);
      return raw ? (JSON.parse(raw) as AutoHistoryItem[]) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(AUTO_TASKS_KEY, JSON.stringify(autoTasks)); } catch {}
  }, [autoTasks]);
  useEffect(() => {
    try { window.localStorage.setItem(AUTO_HISTORY_KEY, JSON.stringify(autoHistory.slice(-200))); } catch {}
  }, [autoHistory]);

  /** ticker：每秒检查到期任务（同时从 localStorage 读最新状态，防止 React state 同步延迟） */
  const autoLastFireRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const iv = window.setInterval(() => {
      const now = Date.now();
      // 优先从 localStorage 读最新的任务列表
      let liveTasks = autoTasks;
      try {
        const raw = window.localStorage.getItem(AUTO_TASKS_KEY);
        if (raw) liveTasks = JSON.parse(raw) as AutoTask[];
      } catch {}
      let changed = false;
      const updated = liveTasks.map((t) => {
        if (!t.on) return t;
        if (now >= t.nextRun) {
          const lastFire = autoLastFireRef.current[t.id] || 0;
          if (now - lastFire < 1000) return t;
          autoLastFireRef.current[t.id] = now;
          changed = true;
          runAutoTask(t, "定时触发");
          const next = computeNextRun(t.kind, t.cronExpr, now + 1000);
          return { ...t, lastRun: now, nextRun: next };
        }
        return t;
      });
      if (changed) {
        // 写回 localStorage 并触发 React 重渲染
        try { window.localStorage.setItem(AUTO_TASKS_KEY, JSON.stringify(updated)); } catch {}
        setAutoTasks(updated);
      }
    }, 1000);
    return () => window.clearInterval(iv);
  }, []);

  /** 执行一个自动化任务：创建新会话 + 发送任务内容 + 把输出路径拼到输入里 */
  function runAutoTask(task: AutoTask, trigger: "定时触发" | "手动触发") {
    const start = Date.now();
    // 记录一次历史（先插入一条 running，再在下方 on 里替换）
    const histId = `h_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setAutoHistory((prev) => [
      { id: histId, taskId: task.id, taskName: task.name, time: start, status: "success", durMs: 0, trigger, note: "执行中…" },
      ...prev,
    ]);
    try {
      // 在输入里带上输出路径，让 agent 知道要存哪
      const contentWithPath = task.outputPath
        ? `${task.content}\n\n> 请将所有输出文件保存到：${task.outputPath}`
        : task.content;
      // 调用现有的 newChat + setInput + send 序列
      newChat();
      setTimeout(() => {
        setInput(contentWithPath);
        setTimeout(() => {
          send();
          // 异步等待：每 2 秒轮询 msgs 是否还有 assistant 在工作，最多 5 分钟
          const pollStart = Date.now();
          const pollIv = window.setInterval(() => {
            const now = Date.now();
            if (now - pollStart > 5 * 60 * 1000) {
              window.clearInterval(pollIv);
              finalize("执行超时");
              return;
            }
            const last = msgsRef.current[msgsRef.current.length - 1];
            if (!last || last.role !== "assistant") return;
            // 如果 pending 为 false 且 session 不再 running，视为完成
            if (!pendingRef.current) {
              window.clearInterval(pollIv);
              finalize();
            }
          }, 2000);

          function finalize(note?: string) {
            setAutoHistory((prev) => prev.map((h) => h.id === histId
              ? { ...h, status: "success", durMs: Date.now() - start, note }
              : h));
            setAutoTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, lastStatus: "success" } : t));
          }
        }, 120);
      }, 200);
    } catch (e) {
      setAutoHistory((prev) => prev.map((h) => h.id === histId
        ? { ...h, status: "failed", durMs: Date.now() - start, note: String(e) }
        : h));
      setAutoTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, lastStatus: "failed" } : t));
    }
  }

  function addAutoTask(name: string, triggerText: string, content: string, outputPath: string) {
    const parsed = parseTriggerInput(triggerText);
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const nextRun = computeNextRun(parsed.kind, parsed.cronExpr);
    setAutoTasks((prev) => [
      ...prev,
      {
        id,
        name: name.trim() || "未命名任务",
        kind: parsed.kind,
        trigger: parsed.display,
        cronExpr: parsed.cronExpr,
        content: content.trim(),
        outputPath: outputPath.trim(),
        on: true,
        nextRun,
      },
    ]);
  }
  function toggleAutoTask(id: string) {
    setAutoTasks((prev) => prev.map((t) => t.id === id ? { ...t, on: !t.on } : t));
  }
  function deleteAutoTask(id: string) {
    setAutoTasks((prev) => prev.filter((t) => t.id !== id));
    setAutoHistory((prev) => prev.filter((h) => h.taskId !== id));
  }
  function runAutoTaskNow(id: string) {
    const t = autoTasks.find((x) => x.id === id);
    if (t) runAutoTask(t, "手动触发");
  }

  // ------- Refs 用于 timer 里拿最新值 -------
  const threadProviderRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const pendingRef = useRef(false);
  const activeThreadRef = useRef<string | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const termRef = useRef(terminalLines);
  const msgsListRef = useRef<HTMLDivElement>(null);
  const lastErrMergeRef = useRef<{ text: string; count: number } | null>(null);
  // 云端会话消息缓存：每个 thread id 对应一份消息历史，切换会话时恢复
  const sessionMessagesRef = useRef<Record<string, Msg[]>>({});
  // 正在运行云端 turn 的会话 id（用于把 SSE 事件路由到正确的会话）
  const runningSessionIdRef = useRef<string | null>(null);
  // Modal 表单状态（放在顶层 hooks 区，不放进 IIFE）
  const [mName, setMName] = useState("");
  const [mTrigger, setMTrigger] = useState("每天 09:00");
  const [mContent, setMContent] = useState("");
  const [mOutput, setMOutput] = useState("");
  // 每次打开 modal 时重置表单
  useEffect(() => {
    if (showNewTaskModal) {
      setMName("");
      setMTrigger("每天 09:00");
      setMContent("");
      setMOutput("");
    }
  }, [showNewTaskModal]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { activeThreadRef.current = activeThread; }, [activeThread]);
  useEffect(() => { msgsRef.current = messages; }, [messages]);
  useEffect(() => { approvalsRef.current = approvals; }, [approvals]);
  useEffect(() => { termRef.current = terminalLines; }, [terminalLines]);

  // 会话消息缓存：消息变化时按当前 activeThread 存盘
  useEffect(() => {
    const tid = activeThreadRef.current;
    if (tid) {
      sessionMessagesRef.current[tid] = messages;
    }
  }, [messages]);

  // 切换会话时：从缓存恢复该会话的消息历史
  useEffect(() => {
    const tid = activeThread;
    if (!tid) {
      setMessages([]);
      return;
    }
    const cached = sessionMessagesRef.current[tid];
    setMessages(cached ?? []);
  }, [activeThread]);

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

  // ------- 启动首步：解析路径 + 强制云端模式 + 检查登录 -------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await codex.resolvePaths();
        if (cancelled) return;
        setPaths(p);
        setStatus("路径就绪");

        // 强制启用云端模式
        try {
          await codex.cloudModeSet(true);
        } catch { /* 首次安装可能未就绪 */ }

        setCloudMode(true);
        let hasToken = false;
        try {
          const cs = await codex.cloudModeGet();
          hasToken = cs.hasToken;
        } catch { /* */ }

        if (hasToken) {
          setCloudConnected(true);
          setStatus("云端模式 · 已登录");
          try {
            const h = await codex.cloudHealth();
            if (h.ok) setStatus(`云端模式 · 已连接 (${h.latencyMs}ms)`);
            else setStatus("云端模式 · 连接失败");
          } catch { /* */ }
        } else {
          setStatus("请登录云端");
        }

        // 读取本地配置（模型/Provider 仍需读取）
        try {
          const cfg = await codex.configRead(p.codexHome);
          if (cfg.model) setModel(cfg.model);
          if (cfg.modelProvider) setProvider(cfg.modelProvider);
        } catch { /* 首次无配置用前端默认 */ }
        // 不加载本地会话列表 —— 全部走云端
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          const isTauri = (typeof (window as any).__TAURI_INTERNALS__ !== "undefined" || typeof (window as any).__TAURI__ !== "undefined");
          if (!isTauri) {
            setPaths({
              codexHome: "/tmp/harness-dev/codex-home",
              codexBin: "/usr/bin/codex",
              defaultCwd: "/tmp/harness-dev/workspace",
            });
            setCloudMode(true);
            setStatus("浏览器开发模式 · 请登录");
          } else {
            setLastError(msg);
            setStatus(`初始化失败: ${msg}`);
          }
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
          // ===== B2 云端事件处理 =====
          if (e.method === "cloud/turn_completed") {
            setRunning(false); setLastError(null);
            setCloudStage(null);
            runningSessionIdRef.current = null;
            continue;
          }
          if (e.method === "cloud/error") {
            const msg = codex.cloudError(e) ?? "云端错误";
            setLastError(msg);
            termAccum.push({ ts: Date.now(), text: `[CLOUD-ERROR] ${msg}`, stream: "stderr" });
            setRunning(false);
            runningSessionIdRef.current = null;
            continue;
          }
          const stage = codex.cloudStatusStage(e);
          if (stage) {
            setCloudStage(stage);
            const stageLabel: Record<string, string> = {
              intake: "需求采集",
              retrieving: "知识检索",
              generating: "脚本生成",
              guard: "风险守卫",
            };
            setStatus(`云端 · ${stageLabel[stage] || stage}…`);
            continue;
          }
          // 把云端消息追加到「正在运行的会话」的缓存；若是当前活跃会话则同步刷新 UI
          const appendCloudMsg = (m: Msg) => {
            const sid = runningSessionIdRef.current ?? activeThreadRef.current;
            if (!sid) return;
            const cur = sessionMessagesRef.current[sid] ?? [];
            const next = [...cur, m];
            sessionMessagesRef.current[sid] = next;
            if (sid === activeThreadRef.current) {
              setMessages(next);
            }
          };
          const intakeQ = codex.cloudIntakeQuestion(e);
          if (intakeQ) {
            appendCloudMsg({ role: "assistant", text: `📋 **${intakeQ.question}**\n\n_原因：${intakeQ.reason}_` });
            setCloudStage("intake");
            continue;
          }
          const result = codex.cloudResult(e);
          if (result) {
            let resultText = result.script;
            if (result.creative_notes) resultText += `\n\n---\n**创意备注**\n${result.creative_notes}`;
            if (result.issues && result.issues.length > 0) {
              const issueLines = result.issues.map((i, idx) => {
                const sev = i.severity ? `[${i.severity}] ` : "";
                return `${idx + 1}. ${sev}${i.message}`;
              });
              resultText += `\n\n---\n**⚠️ 守卫提醒（不阻断）**\n` + issueLines.join("\n");
            }
            if (result.suggestions) {
              const sugArr = typeof result.suggestions === "string"
                ? [result.suggestions]
                : (result.suggestions as string[]);
              if (sugArr.length > 0) {
                resultText += `\n\n---\n**优化建议**\n` + sugArr.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
              }
            }
            appendCloudMsg({ role: "assistant", text: resultText });
            setTerminalLines((prev) => [
              ...prev, { ts: Date.now(), text: `[cloud/result] 脚本已生成（${result.script.length} 字，mode=${result.mode ?? "standard"}）`, stream: "meta" as const },
            ].slice(-500));
            continue;
          }
          // ===== 本地 codex 事件处理（原有逻辑） =====
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

  // ------- B2 云端登录 -------
  async function handleCloudLogin() {
    const isTauriEnv = (typeof (window as any).__TAURI_INTERNALS__ !== "undefined" || typeof (window as any).__TAURI__ !== "undefined");
    // 浏览器开发模式：invoke 不可用，直接 mock 登录成功
    if (!isTauriEnv) {
      setStatus("云端登录中…");
      await new Promise((r) => setTimeout(r, 400));
      setCloudConnected(true);
      setCloudMode(true);
      setStatus("浏览器 mock 模式 · 已登录");
      return;
    }
    try {
      setStatus("云端登录中…");
      const result = await codex.cloudLogin({
        username: cloudUser,
        password: cloudPass,
      });
      if (result.ok && result.token) {
        setCloudConnected(true);
        setCloudMode(true);
        setStatus("云端模式 · 已登录");
        // 健康检查
        try {
          const h = await codex.cloudHealth();
          if (h.ok) setStatus(`云端模式 · 已连接 (${h.latencyMs}ms)`);
        } catch { /* */ }
      } else {
        setStatus("登录失败：请检查用户名和密码");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      setStatus(`云端登录失败: ${msg}`);
    }
  }

  // ------- 发送消息 -------
  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    if (!codexHome) { setStatus("运行路径尚未就绪，请稍后"); return; }
    if (cloudMode && !cloudConnected) { setStatus("请先登录云端"); return; }
    if (!cloudMode && !connected) { setStatus("本地 codex 尚未就绪，请稍后"); return; }

    // ---- 浏览器开发 mock 模式 ----
    const isTauriEnv = (typeof (window as any).__TAURI_INTERNALS__ !== "undefined" || typeof (window as any).__TAURI__ !== "undefined");
    if (!isTauriEnv) {
      setPending(true); setInput(""); setLastError(null);
      const next = [...msgsRef.current, { role: "user" as const, text }];
      setMessages(next);
      setTerminalLines((prev) => [
        ...prev, { ts: Date.now(), text: `[mock user]: ${text.slice(0, 160)}`, stream: "meta" as const },
      ].slice(-500));

      setTimeout(() => {
        const reply = `（浏览器 mock 模式）你说："${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"

这是一个模拟的 AI 回复。在真实 Tauri 桌面应用中，这里会显示由 codex app-server 生成的真实响应。

当前运行于 **浏览器开发环境**（非 Tauri 桌面），所有 Tauri invoke 调用不可用，因此用 mock 逻辑替代。`;
        setMessages((prev) => [...prev, { role: "assistant" as const, text: reply }]);
        setTerminalLines((prev) => [
          ...prev, { ts: Date.now(), text: `[mock assistant] 回复已生成`, stream: "meta" as const },
        ].slice(-500));
        setPending(false);
        setStatus("mock 回复完成");
      }, 600);
      return;
    }

    setPending(true); setInput(""); setLastError(null);

    const userMsg: Msg = { role: "user", text };
    const next = [...msgsRef.current, userMsg];
    setMessages(next);
    setTerminalLines((prev) => [
      ...prev, { ts: Date.now(), text: `[user]: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`, stream: "meta" as const },
    ].slice(-500));

    try {
      const promptText = text;

      // ===== B2 云端模式分支 =====
      if (cloudMode && cloudConnected) {
        setStatus("云端发送中…");
        try {
          // 以 activeThread 作为云端 session id；新会话（activeThread 为空）时创建
          let sid: string = activeThreadRef.current ?? "";
          if (!sid) {
            sid = await codex.cloudThreadStart();
            // 先把用户消息写入新会话缓存，避免 setActiveThread 触发的 load effect 把消息冲掉
            sessionMessagesRef.current[sid] = next;
            activeThreadRef.current = sid;
            cloudSessionRef.current = sid;
            setActiveThread(sid);
            setSessions((s) => [...s, {
              id: sid,
              title: text.slice(0, 24) + (text.length > 24 ? "…" : ""),
              provider: "cloud", model, status: "running",
            }]);
            setTerminalLines((prev) => [
              ...prev, { ts: Date.now(), text: `[cloud/session] → ${sid}`, stream: "meta" as const },
            ].slice(-500));
          } else {
            // 已有会话：把用户消息追加到该会话缓存
            sessionMessagesRef.current[sid] = next;
          }

          // 发送到云端 codex 桥（SSE 在后台消费）
          runningSessionIdRef.current = sid;
          await codex.cloudTurnStart({
            sessionId: sid,
            text: promptText,
            brief: selectedSkill ? { skill: selectedSkill } : undefined,
          });
          setTerminalLines((prev) => [
            ...prev, { ts: Date.now(), text: `[cloud/turn] ok，等待 SSE 回流…`, stream: "meta" as const },
          ].slice(-500));
          setRunning(true);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setLastError(msg);
          setStatus(`云端发送失败: ${msg}`);
          setTerminalLines((prev) => [
            ...prev, { ts: Date.now(), text: `[cloud/turn] 失败: ${msg}`, stream: "stderr" as const },
          ].slice(-500));
        }
        return;
      }

      // ===== 本地 codex 模式（原有逻辑） =====

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
    cloudSessionRef.current = null;
  }

  function requestDelete(id: string, title: string) {
    setConfirmDel({ open: true, id, title });
  }

  async function confirmDeleteSession() {
    const { id, title } = confirmDel;
    setConfirmDel({ open: false, id: "", title: "" });
    // 云端模式：会话由云端维护，本地只清理 UI 状态与缓存
    if (cloudMode) {
      delete sessionMessagesRef.current[id];
      setSessions((prev) => prev.filter((x) => x.id !== id));
      if (id === activeThread) {
        activeThreadRef.current = null;
        cloudSessionRef.current = null;
        setActiveThread(null);
        setMessages([]);
      }
      setStatus(`已删除「${title}」`);
      return;
    }
    try {
      await codex.sessionDelete(codexHome, id);
      setSessions((prev) => prev.filter((x) => x.id !== id));
      if (id === activeThread) {
        setActiveThread("");
        setMessages([]);
      }
      setStatus(`已删除「${title}」`);
    } catch (err) {
      setStatus(`删除失败：${err}`);
    }
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
    // 云端模式：会话由云端维护，本地没有 session 文件；直接切换 activeThread，
    // 消息缓存 effect 会从 sessionMessagesRef 恢复该会话的历史。
    if (cloudMode) {
      activeThreadRef.current = id;
      cloudSessionRef.current = id;
      setActiveThread(id);
      setApprovals([]);
      threadProviderRef.current = null;
      return;
    }
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

  // 未登录时只显示登录界面，不能进入其他页面
  if (!cloudConnected) {
    return (
      <div className="cloud-login-overlay cloud-login-fullscreen">
        <div className="cloud-login-modal">
          <h2>登录云端 Codex 服务</h2>
          <p className="cloud-login-hint">
            使用你的账号登录后即可开始对话。
          </p>
          <input
            className="cloud-login-input"
            type="text"
            placeholder="用户名"
            value={cloudUser}
            onChange={(e) => setCloudUser(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCloudLogin(); }}
            autoFocus
          />
          <input
            className="cloud-login-input"
            type="password"
            placeholder="密码"
            value={cloudPass}
            onChange={(e) => setCloudPass(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCloudLogin(); }}
          />
          <div className="cloud-login-actions">
            <button
              className="primary"
              onClick={handleCloudLogin}
              disabled={!cloudUser || !cloudPass}
            >
              登录
            </button>
          </div>
          {lastError && <p className="cloud-login-error">{lastError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* ============ 顶部栏 (42px) ============ */}
      <header className="topbar" style={{ "-webkit-app-region": "drag" } as React.CSSProperties}>
        <button
          className="tb-icon-btn tb-sidebar-toggle"
          data-tauri-drag-region="false"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "显示任务栏" : "隐藏任务栏"}
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
            <button className="sb-menu-item" onClick={() => setPluginsOpen(true)}>
              <span className="ic-wrap gr">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8.11 2.79a3 3 0 0 1 4.24 4.24 3 3 0 0 1 4.24 4.24 3 3 0 0 1 4.62 4.62z"/></svg>
              </span>
              <span>插件管理</span>
            </button>
            <button className="sb-menu-item" onClick={() => setTemplateOpen(true)}>
              <span className="ic-wrap bl">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
              </span>
              <span>模板库</span>
            </button>
            <button className={`sb-menu-item ${automationOpen ? "active" : ""}`} onClick={() => setAutomationOpen((v) => !v)}>
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
                    <button
                      className="s-del-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete(s.id, s.title);
                      }}
                      title="删除此任务"
                      aria-label="删除任务"
                    >
                      ×
                    </button>
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
                {cloudMode ? (cloudConnected ? "在线" : "离线") : (connected ? "在线" : "离线")}
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
              <span className="model-crumb" title={modelInfo(model).name}>
                <img src={modelLogo(model)} alt="" className="crumb-logo" /> {model}
              </span>
              <button className="tb-icon-btn tiny" title="分享（v0.2 占位）" onClick={() => setStatus("分享：敬请期待（v0.2）")}>{IconShare}</button>
              <button className="tb-icon-btn tiny" title="全屏阅读" onClick={() => setStatus("全屏模式：敬请期待（v0.2）")}>{IconFullscreen}</button>
            </div>
          </div>

          {/* ============ 自动化面板（Trae Work 风格：定时任务管理） ============ */}
          {automationOpen ? (
            <div className="automation-panel">
              <div className="ap-top">
                <div className="ap-top-left">
                  <button className="ap-back-btn" onClick={() => setAutomationOpen(false)} title="返回对话 (Esc)">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                    <span>返回对话</span>
                  </button>
                  <div className="ap-tabs">
                    {([
                      ["configured", "已配置"],
                      ["templates", "任务模板"],
                      ["history", "执行历史"],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={`ap-tab ${autoTab === k ? "on" : ""}`}
                        onClick={() => setAutoTab(k)}
                      >{label}</button>
                    ))}
                  </div>
                </div>
                <div className="ap-actions">
                  <button className="ap-btn ghost" onClick={() => setStatus("从对话中创建：输入需求即可")}>在对话中创建</button>
                  <button className="ap-btn primary" onClick={() => setShowNewTaskModal(true)}>+ 手动新建</button>
                </div>
              </div>

              {/* ---- 已配置 ---- */}
              {autoTab === "configured" && (
                <div className="ap-list">
                  {autoTasks.length === 0 ? (
                    <div className="ap-empty">
                      <div className="ap-empty-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      </div>
                      <div className="ap-empty-title">暂无自动化任务</div>
                      <div className="ap-empty-desc">点击右上角「手动新建」或「在对话中创建」来添加你的第一个定时任务</div>
                    </div>
                  ) : autoTasks.map((t) => (
                    <div key={t.id} className="ap-row">
                      <div className="ap-row-main">
                        <div className="ap-row-title">
                          <span className={`ap-status-dot ${t.on ? "on" : "off"}`} />
                          {t.name}
                        </div>
                        <div className="ap-row-meta">
                          <span>⏱ {t.trigger}</span>
                          {t.outputPath && <span>📁 {t.outputPath}</span>}
                          {t.lastStatus && <span className={`ap-status-chip ${t.lastStatus}`}>{t.lastStatus === "success" ? "✓ 最近成功" : "✕ 最近失败"}</span>}
                        </div>
                      </div>
                      <div className="ap-row-right">
                        <div className="ap-row-next">
                          <div className="ap-row-next-label">下次执行</div>
                          <div className="ap-row-next-val">{formatNextRun(t.nextRun)}</div>
                        </div>
                        <div className="ap-row-last">上次：{formatTimeAgo(t.lastRun)}</div>
                        <div className="ap-row-ops">
                          <button className="ap-row-btn" title="立即运行" onClick={() => runAutoTaskNow(t.id)}>▶</button>
                          <button className="ap-row-btn danger" title="删除" onClick={() => deleteAutoTask(t.id)}>×</button>
                        </div>
                        <label className={`ap-switch ${t.on ? "on" : ""}`}>
                          <input type="checkbox" checked={t.on} onChange={() => toggleAutoTask(t.id)} />
                          <span className="ap-switch-track" />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ---- 任务模板 ---- */}
              {autoTab === "templates" && (
                <div className="ap-list">
                  <div className="ap-empty">
                    <div className="ap-empty-icon">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div className="ap-empty-title">暂无可用模板</div>
                    <div className="ap-empty-desc">后续会把脚本生成、飞书同步、影刀触发等高频场景做成内置模板</div>
                  </div>
                </div>
              )}

              {/* ---- 执行历史 ---- */}
              {autoTab === "history" && (
                <div className="ap-list">
                  {autoHistory.length === 0 ? (
                    <div className="ap-empty">
                      <div className="ap-empty-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><polyline points="12 7 12 12 15 15"/></svg>
                      </div>
                      <div className="ap-empty-title">暂无执行记录</div>
                      <div className="ap-empty-desc">运行过的定时任务会在这里留下历史记录</div>
                    </div>
                  ) : autoHistory.map((h) => {
                    const d = new Date(h.time);
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const timeStr = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    const durStr = h.note ? h.note : `${Math.max(0, Math.round(h.durMs / 1000))}s`;
                    return (
                      <div key={h.id} className="ap-row ap-row-history">
                        <div className="ap-row-main">
                          <div className="ap-row-title">
                            <span className={`ap-badge ${h.status}`}>{h.status === "success" ? "✓ 成功" : h.status === "failed" ? "✕ 失败" : "… 执行中"}</span>
                            {h.taskName}
                          </div>
                          <div className="ap-row-meta">
                            <span>{timeStr}</span>
                            <span>⏱ {durStr}</span>
                            <span>🎯 {h.trigger}</span>
                            {h.note && h.status === "success" && <span>📁 {h.note}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ---- 新建定时任务 Modal ---- */}
              {showNewTaskModal && (
                <div className="modal-backdrop" onClick={() => setShowNewTaskModal(false)}>
                  <div className="ap-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="ap-modal-head">
                      <h3>新建自动化任务</h3>
                      <button className="ap-row-btn" onClick={() => setShowNewTaskModal(false)}>×</button>
                    </div>
                    <div className="ap-modal-body">
                      <label className="ap-field">
                        <span className="ap-label">任务名称</span>
                        <input className="ap-input" value={mName} onChange={(e) => setMName(e.target.value)} placeholder="例如：每日投放数据简报" autoFocus />
                      </label>
                      <label className="ap-field">
                        <span className="ap-label">触发时间（自然语言）</span>
                        <input className="ap-input" value={mTrigger} onChange={(e) => setMTrigger(e.target.value)} placeholder="每天 09:00 / 每 30 分钟 / 工作日 10:00" />
                        <div className="ap-hint">支持：每天 HH:MM、每 N 分钟/小时、工作日 HH:MM、每周 N HH:MM</div>
                      </label>
                      <label className="ap-field">
                        <span className="ap-label">任务内容</span>
                        <textarea className="ap-input ap-textarea" rows={3} value={mContent} onChange={(e) => setMContent(e.target.value)} placeholder="用自然语言描述这个任务要做什么，或直接引用 Skill 名称"></textarea>
                      </label>
                      <label className="ap-field">
                        <span className="ap-label">输出文件存储路径（可选）</span>
                        <input className="ap-input" value={mOutput} onChange={(e) => setMOutput(e.target.value)} placeholder="例如：/workspace/outputs/daily-brief/" />
                        <div className="ap-hint">留空则输出由 Agent 自行决定。支持绝对路径或项目内相对路径。</div>
                      </label>
                    </div>
                    <div className="ap-modal-foot">
                      <button className="ap-btn ghost" onClick={() => setShowNewTaskModal(false)}>取消</button>
                      <button
                        className="ap-btn primary"
                        disabled={!mName.trim() || !mTrigger.trim() || !mContent.trim()}
                        onClick={() => {
                          addAutoTask(mName, mTrigger, mContent, mOutput);
                          setShowNewTaskModal(false);
                          setStatus("定时任务已创建 ✅");
                        }}
                      >创建</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (<>

          {/* 有审批待处理且在自动模式时 → 审批界面替代对话框 */}
          {approvals.length > 0 && accessMode === "auto" ? (
            <section className="msglist" style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 24px" }}>
              <div style={{ width: "100%", maxWidth: 560 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: "#F59E0B", display: "inline-block", animation: "pulse 1.4s infinite" }} />
                  等待审批（{approvals.length} 条）
                </div>
                <ApprovalPanel
                  approvals={approvals}
                  onRespond={(id, dec) => respondApproval(id, dec)}
                />
                <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-muted)" }}>
                  提示：想让后续操作自动执行？点击左下角的「自动审批」切换为「完全访问」模式。
                </div>
              </div>
            </section>
          ) : (
          <section className="msglist" ref={msgsListRef}>
            {messages.length === 0 ? (
              <div className="placeholder">
                <h1 className="hero-title">今天想做什么？</h1>
                <div className="hero-sub">用自然语言下达任务，Harness 会自动完成</div>

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
          )}

          {/* 发送器 composer · v0.6.0 新布局 */}
          <footer className="composer">
            {/* 主输入栏：左工具 + textarea + 右发送 */}
            <div className="composer-bar">
              {/* 左侧：📎 多模态附件 / 插件 Skill / 手动审批 / Auto Mode */}
              <div className="bar-left">
                {/* 📎 多模态附件：图片 / 视频 / 文档 */}
                <button
                  className="bar-btn-plus"
                  title={modelInfo(model).multiModal ? "上传图片 / 视频 / 文档" : `⚠ 当前模型不支持多模态（${modelInfo(model).name}）`}
                  onClick={() => openFilePicker()}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,video/*,.pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.json,.zip"
                  style={{ display: "none" }}
                  onChange={onFilesPicked}
                />

                {/* 插件 / Skill 选择入口 */}
                <button
                  className="bar-btn-plus"
                  title="选择 Skill / 模板"
                  onClick={() => setTemplateOpen(true)}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
                </button>

                {/* 访问模式切换：自动审批 ↔ 完全访问 */}
                <div className="bar-btn-approval-wrap">
                  <button
                    className={`bar-btn-approval ${accessMode === "full" ? "is-full" : ""}`}
                    onClick={() => {
                      const next: "auto" | "full" = accessMode === "auto" ? "full" : "auto";
                      setAccessMode(next);
                      setStatus(next === "full" ? "已切换为完全访问模式" : "已切换回自动审批模式");
                    }}
                    title={accessMode === "auto" ? "当前：自动审批（有操作时会弹窗请你批准）" : "当前：完全访问（自动批准所有操作）"}
                  >
                    {IconApproval}
                    <span>
                      {accessMode === "full" ? "完全访问" : (
                        approvals.length > 0 ? `${approvals.length} 条待审` : "自动审批"
                      )}
                    </span>
                    {accessMode !== "full" && approvals.length > 0 && (
                      <span className="approval-count-badge">{approvals.length}</span>
                    )}
                  </button>
                </div>
              </div>

              {/* textarea 主输入 */}
              <textarea
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="告诉 Harness 你想做什么，用自然语言下达任务"
                disabled={pending || running || !paths}
                className="composer-input"
              />

              {/* 右侧：Auto Mode 模型选择 + 发送按钮 */}
              <div className="bar-right">
                {/* Auto Mode 模型选择下拉 */}
                <div className="auto-mode-pill-wrap">
                  <button
                    className="auto-mode-pill"
                    onClick={() => setAutoModeOpen((v) => !v)}
                    title={`切换模型 · ${modelInfo(model).name}`}
                  >
                    <span className="auto-logo">
                      <img src={modelLogo(model)} alt="" className="auto-logo-img" />
                    </span>
                    <span className="auto-label">{modelInfo(model).name}</span>
                    <span className="caret" style={{ transform: autoModeOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
                      {IconCaretDown}
                    </span>
                  </button>
                  {/* 下拉浮层 */}
                  {autoModeOpen && (
                    <>
                      <div className="auto-mode-backdrop" onClick={() => setAutoModeOpen(false)} />
                      <div className="auto-mode-menu">
                        {ALL_MODELS.map((m) => {
                          const isActive = m.id === model;
                          return (
                            <button
                              key={m.id}
                              className={`auto-item ${isActive ? "active" : ""}`}
                              onClick={() => {
                                setModel(m.id);
                                setAutoModeOpen(false);
                              }}
                            >
                              <span className="auto-item-logo">
                                <img src={modelLogo(m.id)} alt="" className="auto-item-logo-img" />
                              </span>
                              <span className="auto-item-name">{m.name}</span>
                              {m.multiModal && <span className="auto-mm-tag" title="支持图片 / 视频 / 文档">多模态</span>}
                              {isActive && <span className="auto-item-check">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>

                {/* 发送按钮 */}
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

            {/* 附件预览条（多模态文件） */}
            {attachments.length > 0 && (
              <div className="attach-bar">
                {attachments.map((a, i) => (
                  <div key={i} className={`attach-chip attach-${a.kind}`}>
                    {a.kind === "image" && a.preview
                      ? <img src={a.preview} alt="" className="attach-thumb" />
                      : <span className="attach-ico">{a.kind === "video" ? "🎬" : "📄"}</span>}
                    <div className="attach-info">
                      <div className="attach-name">{a.name}</div>
                      <div className="attach-size">{(a.size / 1024).toFixed(1)} KB</div>
                    </div>
                    <button className="attach-remove" onClick={() => removeAttachment(i)} title="移除">×</button>
                  </div>
                ))}
                <button className="attach-add" onClick={() => openFilePicker()}>+ 继续添加</button>
              </div>
            )}

            {/* 薄状态栏：左状态 / 右日志 + 语音 */}
            <div className="composer-meta">
              <div className="meta-left">
                <span className="status-chip" title={status}>{status}</span>
                {cloudStage && (
                  <span className="cloud-stage-chip" title={`云端阶段：${cloudStage}`}>
                    {cloudStage === "intake" ? "📋 采集" : cloudStage === "retrieving" ? "🔍 检索" : cloudStage === "generating" ? "✍️ 生成" : cloudStage === "guard" ? "🛡️ 守卫" : cloudStage}
                  </span>
                )}
                {errCount > 0 && (
                  <span className="err-chip" title="有错误，点击日志查看详情">
                    ⚠ {errCount}
                  </span>
                )}
              </div>
              <div className="meta-right">
                <button className={`log-toggle ${errCount > 0 ? "has-err" : ""}`} onClick={() => setLogOpen((v) => !v)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-6-6-6M12 19h8"/></svg>
                  <span>{logOpen ? "收起" : "日志"}</span>
                  {errCount > 0 && <span className="log-badge">{errCount}</span>}
                </button>
                <button className="tb-icon-btn tiny" title="语音输入（v0.2 占位）" onClick={() => setStatus("语音：敬请期待（v0.2）")}>
                  {IconMic}
                </button>
              </div>
            </div>

            {/* 可折叠错误/日志面板 */}
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
          </>
          )}
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

      {/* ============ 审批弹窗（Trae Work 图一风格，直接嵌入 styled ApprovalPanel） ============ */}
      {approvalOpen && (
        <div className="modal-backdrop" onClick={() => setApprovalOpen(false)}>
          <div
            className="approval-modal-wrap"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="approval-modal-close"
              onClick={() => setApprovalOpen(false)}
              title="稍后处理（保留 toast 通知）"
              aria-label="close"
            >×</button>
            <ApprovalPanel
              approvals={approvals}
              codexHome={paths?.codexHome}
              onRespond={(id, dec) => respondApproval(id, dec)}
            />
          </div>
        </div>
      )}

      {/* ============ Modals（保留全部）============ */}





      {/* ============ T6 模板库抽屉 ============ */}
      {templateOpen && (
        <div className="modal-backdrop" onClick={() => setTemplateOpen(false)}>
          <div className="tpl-panel" onClick={(e) => e.stopPropagation()}>
            <div className="tpl-head">
              <h2>模板库 / Skill</h2>
              <button className="sp-close" onClick={() => setTemplateOpen(false)}>×</button>
            </div>

            {/* Skill 选择 */}
            <div className="tpl-skill-row">
              <span className="tpl-skill-label">工作流</span>
              <div className="tpl-skill-opts">
                {[
                  { id: "talk-script", label: "脚本生成" },
                  { id: "", label: "自由对话" },
                ].map((s) => (
                  <button
                    key={s.id || "free"}
                    className={`tpl-skill-opt ${selectedSkill === s.id ? "on" : ""}`}
                    onClick={() => setSelectedSkill(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="sp-desc" style={{ marginTop: 0 }}>
              选一个模板填入输入框，直接开始任务。
            </p>
            <div className="tpl-grid">
              {TEMPLATES.map((t) => (
                <div key={t.id} className="tpl-card">
                  <div className="tpl-card-title">
                    <span className="tpl-icon">{t.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{t.title}</div>
                      <div style={{ fontSize: 12, color: "#6B7280", marginTop: 4 }}>{t.subtitle}</div>
                    </div>
                    {t.tag && <span className="tpl-tag">{t.tag}</span>}
                  </div>
                  <pre className="tpl-preview">
                    {t.prompt.length > 280 ? `${t.prompt.slice(0, 280)}…` : t.prompt}
                  </pre>
                  <div className="tpl-actions">
                    <button className="sp-btn sp-btn-ghost" onClick={() => {
                      navigator.clipboard?.writeText(t.prompt).catch(() => {});
                      setStatus(`已复制「${t.title}」到剪贴板`);
                    }}>复制</button>
                    <button className="sp-btn sp-btn-primary" onClick={() => applyTemplate(t.id)}>
                      填入输入框
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ============ 首次启动向导 ============ */}
      {onboardingOpen && (
        <div className="onboarding">
          <div className="onboarding-inner">
            <h1>欢迎使用 Harness AI 工作台</h1>
            <div className="sub">
              你的本地 Agent 工作台，Work/Code/Design 三模式切换。
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
                  已预置默认模型，可直接开箱使用。
                  你稍后可以在输入栏切换其他模型。
                </p>
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
                    <input type="password" value={oboKey} onChange={(e) => setOboKey(e.target.value)} placeholder="自定义 API Key（可选）" />
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

      {/* 插件管理：独立模态页面（v0.5.3 起与设置面板解耦） */}
      <PluginsPanel
        open={pluginsOpen}
        onClose={() => setPluginsOpen(false)}
        codexHome={codexHome}
        onStatus={setStatus}
      />

      {/* ============ B2 云端登录弹窗（已移至未登录全屏界面） ============ */}

      {/* ============ 删除确认弹窗（图一样式：暗色警告 + 红按钮） ============ */}
      {confirmDel.open && (
        <div className="modal-backdrop" onClick={() => setConfirmDel({ open: false, id: "", title: "" })}>
          <div className="confirm-delete" onClick={(e) => e.stopPropagation()}>
            <div className="cd-head">
              <div className="cd-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <span className="cd-title">确认删除</span>
              <button className="cd-close" onClick={() => setConfirmDel({ open: false, id: "", title: "" })}>×</button>
            </div>
            <div className="cd-body">
              删除后，这个会话及其所有内容将从本地或云端移除，包括聊天记录和代码，且无法恢复。
            </div>
            <div className="cd-foot">
              <button className="cd-btn ghost" onClick={() => setConfirmDel({ open: false, id: "", title: "" })}>取消</button>
              <button className="cd-btn danger" onClick={confirmDeleteSession}>删除</button>
            </div>
          </div>
        </div>
      )}
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