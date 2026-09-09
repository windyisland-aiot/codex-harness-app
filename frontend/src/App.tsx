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

/** 思考过程里展示的动作类型：规划 / 命令 / 文件 / 插件工具。 */
type ActivityKind = "plan" | "cmd" | "file" | "tool";
interface ActivityStep {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  done: boolean;
}
interface TurnActivity {
  steps: ActivityStep[];
  reasoning: string;
}

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

const STARTER_CHIPS: Array<{
  title: string;
  desc: string;
  text: string;
  skill?: string;
}> = [
  {
    title: "飞书审批推送",
    desc: "把结果写入多维表格并提交审批",
    text: "把这次的产出写入飞书多维表格，并向指定审批人提交一条飞书审批，说明里带上标题和正文预览。",
  },
  {
    title: "影刀 RPA 集成",
    desc: "生成影刀流程参数并触发执行",
    text: "帮我准备影刀 RPA 的流程入参（JSON），然后调用影刀接口触发对应流程，并回报执行结果。",
  },
  {
    title: "广告脚本生成",
    desc: "检索品牌话术 → 初稿 → 润色定稿",
    text: "帮我生成一条广告口播脚本：先检索品牌话术与历史案例，再出 3 版初稿，最后挑一版按品牌语气润色定稿。",
    skill: "talk-script",
  },
  {
    title: "本地文件整理",
    desc: "读写本地目录、批量处理文档",
    text: "帮我整理当前工作目录下的文档：列出结构、找出重复与过期文件，并给出清理建议。",
  },
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
  const codexBin = paths?.codexBin ?? "";
  const cwd = paths?.defaultCwd ?? "";

  // ------- 默认模型 -------
  const [model, setModel] = useState("ark-code-latest");
  const [provider, setProvider] = useState("volcengine-ark");
  const [autoModeOpen, setAutoModeOpen] = useState(false);

  // ------- 附件（多模态文件上传） -------
  interface Attachment { name: string; size: number; kind: "image" | "video" | "doc"; preview?: string; file?: File; }
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
        file: f,
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

  const readAsDataURL = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
  const readAsText = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(f);
    });
  /** 只保留文件名安全字符，避免路径穿越。 */
  const safeFileName = (name: string) =>
    name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").slice(0, 120) || "attachment";

  /** 把本轮附件整理成 codex 可消费的形式：图片→dataURL，文本文档→内联，其它→workspace 文件。 */
  async function prepareAttachments(workspace: string, multimodal: boolean) {
    const imageUrls: string[] = [];
    const inlineTexts: string[] = [];
    const savedPaths: string[] = [];
    const textExt = /\.(txt|md|csv|json|log)$/i;
    for (const a of attachments) {
      const f = a.file;
      if (!f) continue;
      if (a.kind === "image") {
        if (!multimodal) {
          throw new Error(`当前模型不支持图片，无法发送 ${a.name}，请切换多模态模型`);
        }
        imageUrls.push(await readAsDataURL(f));
      } else if (textExt.test(a.name)) {
        const body = await readAsText(f);
        inlineTexts.push(`【附件：${a.name}】\n${body.slice(0, 20000)}`);
      } else {
        const buf = await f.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        const b64 = btoa(bin);
        const rel = `_attachments/${Date.now()}-${safeFileName(a.name)}`;
        const abs = await codex.fsWriteFileB64(workspace, rel, b64);
        savedPaths.push(abs);
      }
    }
    return { imageUrls, inlineTexts, savedPaths };
  }

  // ------- 设置面板开关（v0.3.0 统一成单个 SettingsPanel） -------
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ------- 插件管理：独立页面（v0.5.3 起不再挂在设置面板里） -------
  const [pluginsOpen, setPluginsOpen] = useState(false);
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
  // 当前轮的「思考过程」：规划/命令/文件/插件动作 + 模型推理流（内部滚动、限高）
  const [activity, setActivity] = useState<TurnActivity>({ steps: [], reasoning: "" });
  const [sideSearch, setSideSearch] = useState("");
  const sideSearchRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [appVersion, setAppVersion] = useState("0.7.4");

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

  // ------- 登录态（模型走服务端代理，需登录 token 鉴权） -------
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudUser, setCloudUser] = useState("");
  const [cloudPass, setCloudPass] = useState("");
  // 当前选用的 skill（空 = 自由对话；talk-script = 脚本生成工作流，SKILL.md 在本地）
  const [selectedSkill, setSelectedSkill] = useState<string>("");

  // ------- Skill 选择器（composer 左侧「工作流」按钮） -------
  // 列表来自本地安装目录扫描（<codexHome>/skills 下的 SKILL.md），
  // 服务端导入的 skill 经「插件管理 → 云端市场」下载后即出现在这里。
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillOptions, setSkillOptions] = useState<Array<{ id: string; label: string; desc: string }>>([]);
  const [skillLoading, setSkillLoading] = useState(false);

  async function loadSkillOptions(home: string) {
    if (!home) return;
    setSkillLoading(true);
    try {
      const list = await codex.pluginsList({ codexHome: home, skillRoots: [], pluginRoots: [] });
      setSkillOptions(
        list.skills
          .filter((sk) => sk.enabled)
          .map((sk) => ({ id: sk.name, label: sk.name, desc: sk.description || "" })),
      );
    } catch {
      setSkillOptions([]);
    } finally {
      setSkillLoading(false);
    }
  }

  const skillLabel = (id: string) => {
    if (!id) return "自由对话";
    const hit = skillOptions.find((sk) => sk.id === id);
    return hit?.label ?? id;
  };

  // ------- Trae Work v5：左栏 collapsed、终端输出、浏览器 URL -------
  const [collapsed, setCollapsed] = useState(false);
  const [terminalLines, setTerminalLines] = useState<
    Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }>
  >([]);
  const [confirmDel, setConfirmDel] = useState<{ open: boolean; id: string; title: string }>({ open: false, id: "", title: "" });
  // 审批模式：auto=逐条弹窗确认；full=完全访问（自动批准）。
  // 持久化，避免每次重启又退回逐条确认。
  const [accessMode, setAccessMode] = useState<"auto" | "full">(() => {
    if (typeof window === "undefined") return "auto";
    return window.localStorage.getItem("harness.accessMode") === "full" ? "full" : "auto";
  });
  const [automationOpen, setAutomationOpen] = useState(false);
  const [autoTab, setAutoTab] = useState<"configured" | "templates" | "history">("configured");
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);

  // ESC 快捷键：退出自动化面板 / 关闭 modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (renameOpen) { setRenameOpen(false); return; }
      if (helpOpen) { setHelpOpen(false); return; }
      if (showNewTaskModal) { setShowNewTaskModal(false); return; }
      if (automationOpen) { setAutomationOpen(false); return; }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [automationOpen, showNewTaskModal, helpOpen, renameOpen]);

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
  const activityRef = useRef<TurnActivity>({ steps: [], reasoning: "" });
  const reasoningBufRef = useRef<Record<string, string>>({});
  const thinkReasonRef = useRef<HTMLDivElement>(null);
  /** 当前正在运行的 turn id（来自 turn/started），用于对话打断。 */
  const activeTurnIdRef = useRef<string>("");
  // 轮询 interval 闭包捕获的是创建时的 accessMode，改用 ref 读最新值，
  // 否则切到「完全访问」后仍按旧模式挂起审批。
  const accessModeRef = useRef<"auto" | "full">(accessMode);
  const termRef = useRef(terminalLines);
  const msgsListRef = useRef<HTMLDivElement>(null);
  const lastErrMergeRef = useRef<{ text: string; count: number } | null>(null);
  // 会话消息缓存：每个 thread id 对应一份消息历史，切换会话时恢复
  const sessionMessagesRef = useRef<Record<string, Msg[]>>({});
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
  useEffect(() => {
    accessModeRef.current = accessMode;
    if (typeof window !== "undefined") window.localStorage.setItem("harness.accessMode", accessMode);
  }, [accessMode]);
  useEffect(() => { termRef.current = terminalLines; }, [terminalLines]);

  // 会话消息缓存：消息变化时按当前 activeThread 存盘
  useEffect(() => {
    const tid = activeThreadRef.current;
    if (tid) {
      sessionMessagesRef.current[tid] = messages;
    }
  }, [messages]);

  // 切换会话时：从缓存恢复该会话的消息历史。
  // 缓存缺失时保持现状而非清空——新建会话拿到 id 的瞬间缓存可能还没落，
  // 直接清空会把用户刚发的消息抹掉。
  useEffect(() => {
    const tid = activeThread;
    if (!tid) {
      setMessages([]);
      return;
    }
    const cached = sessionMessagesRef.current[tid];
    if (cached) setMessages(cached);
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

  // 活动流更新时只滚思考块自身（内部滚动），不顶动整条消息
  useEffect(() => {
    if (thinkReasonRef.current) {
      thinkReasonRef.current.scrollTop = thinkReasonRef.current.scrollHeight;
    }
  }, [activity]);


  // ------- 拉起本地 codex app-server -------
  //
  // Rust 侧 appserver_start 会自动：
  //   1) 从登录态取 token + api_base；
  //   2) 把 config.toml 各 provider 的 base_url 改写为服务端 /api/v1/llm 代理；
  //   3) 注入登录 token 作模型鉴权（客户端不含任何内置模型密钥）。
  // 所以这里无需传 key，只要保证调用前已登录。
  const bootLocalCodex = async (home: string, bin: string) => {
    setStatus("启动本地 codex…");
    try {
      const ua = await codex.start({ codexBin: bin, codexHome: home });
      setConnected(true);
      setStatus(`本地 codex 就绪 · ${ua}`);
      setTerminalLines((prev) => [
        ...prev, { ts: Date.now(), text: `[appserver] ${ua}（模型经服务端代理）`, stream: "meta" as const },
      ].slice(-500));
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnected(false);
      setLastError(msg);
      setStatus(`本地 codex 启动失败: ${msg}`);
      setTerminalLines((prev) => [
        ...prev, { ts: Date.now(), text: `[appserver] 启动失败: ${msg}`, stream: "stderr" as const },
      ].slice(-500));
      return false;
    }
  };

  // ------- 启动首步：解析路径 + 检查登录 + 拉起本地 codex -------
  //
  // v0.7.0 架构：codex 跑在本地（保留文件读写 / 命令执行 / 飞书·影刀 MCP 的全部能力），
  // 只把「模型推理」这一步转发到服务端 /api/v1/llm 代理。服务端持有真实模型
  // base_url / api_key（管理员在后台配置），客户端只带登录 token。
  // 因此必须「先登录 → 再启动 codex」。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await codex.resolvePaths();
        if (cancelled) return;
        setPaths(p);
        setStatus("路径就绪");

        // 关闭云端执行模式：codex 在本地跑，服务端只做模型代理 / 知识库 / 账号
        try {
          await codex.cloudModeSet(false);
        } catch { /* 首次安装可能未就绪 */ }

        // 读取本地配置（模型 / provider）
        try {
          const cfg = await codex.configRead(p.codexHome);
          const savedModel = (() => { try { return window.localStorage.getItem("harness.model"); } catch { return null; } })();
          if (savedModel && ALL_MODELS.some((mm) => mm.id === savedModel)) setModel(savedModel);
          else if (cfg.model) setModel(cfg.model);
          if (cfg.modelProvider) setProvider(cfg.modelProvider);
        } catch { /* 首次无配置用前端默认 */ }

        // 登录态：有 token 才能启动 codex（模型请求需要它做鉴权）
        let hasToken = false;
        try {
          const cs = await codex.cloudModeGet();
          hasToken = cs.hasToken;
        } catch { /* */ }

        if (!hasToken) {
          setStatus("请先登录");
          return;
        }
        setCloudConnected(true);
        if (cancelled) return;
        await bootLocalCodex(p.codexHome, p.codexBin);

        // 本地会话列表（codex 在本地跑，会话文件也在本地）
        try {
          const list = await codex.sessionList(p.codexHome);
          if (!cancelled) {
            setSessions(list.map((m) => ({
              id: m.id, title: m.title || m.id,
              provider: m.provider, model: m.model, status: "done" as const,
              updatedAt: m.updatedAt,
            })));
          }
        } catch { /* 首次无会话 */ }
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
      const upsert = (steps: ActivityStep[], step: ActivityStep): ActivityStep[] =>
        steps.some((x) => x.id === step.id)
          ? steps.map((x) => (x.id === step.id ? { ...x, ...step } : x))
          : [...steps, step];
      try {
        const events = await codex.pollEvents();
        const termAccum: Array<{ ts: number; text: string; stream?: "stdout" | "stderr" | "meta" }> = [];
        for (const e of events) {
          if (e.method === "turn/started") {
            const p = e.params as any;
            const tid = String(p?.turn?.id ?? p?.turnId ?? "");
            if (tid) activeTurnIdRef.current = tid;
            continue;
          }
          if (e.method === "turn/completed") {
            // 收尾：把还挂着的动作标记完成
            patchActivity((a) => ({ ...a, steps: a.steps.map((x) => ({ ...x, done: true })) }));
            activeTurnIdRef.current = "";
            setRunning(false); setLastError(null);
            lastErrMergeRef.current = null;
            continue;
          }
          // ------- 思考过程：规划 / 推理流 / 工具动作 -------
          if (e.method === "item/plan/delta") {
            const d = typeof (e.params as any)?.delta === "string" ? (e.params as any).delta : "";
            const iid = String((e.params as any)?.itemId ?? "plan");
            if (d) {
              const buf = (reasoningBufRef.current[iid] ?? "") + d;
              reasoningBufRef.current[iid] = buf;
              patchActivity((a) => ({ ...a, steps: upsert(a.steps, {
                id: iid, kind: "plan", title: "制定执行计划", detail: buf.length > 400 ? buf.slice(0, 400) + "…" : buf, done: false,
              }) }));
            }
            continue;
          }
          if (e.method === "item/reasoning/textDelta" || e.method === "item/reasoning/summaryTextDelta") {
            const d = typeof (e.params as any)?.delta === "string" ? (e.params as any).delta : "";
            if (d) {
              patchActivity((a) => ({ ...a, reasoning: a.reasoning + d }));
            }
            continue;
          }
          if (e.method === "item/started") {
            const step = stepFromThreadItem((e.params as any)?.item);
            if (step) upsertActivityStep(step);
            continue;
          }
          if (e.method === "item/completed") {
            const it = (e.params as any)?.item;
            const step = stepFromThreadItem(it);
            // 工具/动作类条目进活动流并消费；普通正文消息继续往下走 textDelta 兜底渲染
            if (step) {
              upsertActivityStep({ ...step, done: true });
              continue;
            }
            if (it?.type === "reasoning" && Array.isArray(it.summary)) {
              const joined = it.summary.join("\n");
              if (joined.trim()) patchActivity((a) => ({ ...a, reasoning: joined }));
              continue;
            }
          }
          if (e.method === "item/mcpToolCall/progress") {
            const prm = (e.params as any) ?? {};
            upsertActivityStep({
              id: String(prm.itemId ?? prm.toolCallId ?? "mcp"),
              kind: "tool",
              title: prm.server && prm.tool ? `调用插件 · ${prm.server}/${prm.tool}` : "调用插件",
              detail: String(prm.message ?? prm.progress ?? "执行中…"),
              done: false,
            });
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
        if (list.length === 0) return;

        // 完全访问：直接回 acceptForSession，不入 UI 队列。
        // 之前只是隐藏面板而不应答，codex 会一直等审批 → 表现为「允许全部无效」。
        if (accessModeRef.current === "full") {
          for (const item of list) {
            try {
              await codex.respondApproval(item.id, "acceptForSession");
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              setTerminalLines((prev) => [
                ...prev, { ts: Date.now(), text: `[审批 #${item.id}] 自动批准失败: ${msg}`, stream: "stderr" as const },
              ].slice(-500));
            }
          }
          setTerminalLines((prev) => [
            ...prev, { ts: Date.now(), text: `[审批] 完全访问模式，已自动批准 ${list.length} 条`, stream: "meta" as const },
          ].slice(-500));
          return;
        }

        setApprovals((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...list.filter((a) => !seen.has(a.id))];
        });
      } catch { /* 静默 */ }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [connected]);

  // ------- 思考过程（活动流） -------
  function patchActivity(fn: (a: TurnActivity) => TurnActivity) {
    setActivity((prev) => {
      const next = fn(prev);
      activityRef.current = next;
      return next;
    });
  }
  function resetActivity() {
    const empty: TurnActivity = { steps: [], reasoning: "" };
    activityRef.current = empty;
    reasoningBufRef.current = {};
    setActivity(empty);
  }
  function upsertActivityStep(step: ActivityStep) {
    patchActivity((a) => ({
      ...a,
      steps: a.steps.some((x) => x.id === step.id)
        ? a.steps.map((x) => (x.id === step.id ? { ...x, ...step } : x))
        : [...a.steps, step],
    }));
  }
  /** 把 codex 的 ThreadItem 映射成一条动作；纯消息/推理条目返回 null。 */
  function stepFromThreadItem(it: any): ActivityStep | null {
    if (!it || typeof it !== "object" || it.id == null) return null;
    const id = String(it.id);
    const clip = (v: unknown, n = 220) => {
      const str = String(v ?? "").replace(/\s+/g, " ").trim();
      return str.length > n ? str.slice(0, n) + "…" : str;
    };
    switch (it.type) {
      case "plan":
        return { id, kind: "plan", title: "制定执行计划", detail: clip(it.text, 400), done: false };
      case "commandExecution":
        return { id, kind: "cmd", title: "执行命令", detail: clip(it.command), done: false };
      case "fileChange": {
        const paths = Array.isArray(it.changes)
          ? it.changes.map((c: any) => c?.path).filter(Boolean)
          : [];
        return {
          id, kind: "file",
          title: paths.length ? `修改文件（${paths.length}）` : "修改文件",
          detail: clip(paths.join("、"), 300),
          done: false,
        };
      }
      case "mcpToolCall":
        return {
          id, kind: "tool",
          title: `调用插件 · ${it.server ?? "?"}/${it.tool ?? "?"}`,
          detail: it.status === "failed" ? "调用失败" : clip(JSON.stringify(it.arguments ?? ""), 200),
          done: it.status === "completed",
        };
      case "dynamicToolCall":
      case "customToolCall":
        return {
          id, kind: "tool",
          title: `调用工具 · ${it.name ?? it.tool ?? "?"}`,
          detail: clip(JSON.stringify(it.arguments ?? it.args ?? ""), 200),
          done: false,
        };
      default:
        return null;
    }
  }

  // ------- 顶栏按钮：搜索 / 编辑重命名 / 帮助 / 退出账号 -------
  function focusSessionSearch() {
    if (collapsed) setCollapsed(false);
    requestAnimationFrame(() => {
      sideSearchRef.current?.focus();
      sideSearchRef.current?.select();
    });
  }
  function openRename() {
    if (!activeThread) { setStatus("请先选择一个任务再重命名"); return; }
    const cur = sessions.find((x) => x.id === activeThread)?.title ?? "";
    setRenameValue(cur);
    setRenameOpen(true);
  }
  async function submitRename() {
    const title = renameValue.trim();
    const id = activeThread;
    if (!title || !id) { setRenameOpen(false); return; }
    setRenameOpen(false);
    setSessions((prev) => prev.map((x) => (x.id === id ? { ...x, title } : x)));
    try {
      await codex.sessionRename(codexHome, id, title);
      setStatus("已重命名");
    } catch (e) {
      setStatus(`重命名失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function switchModel(next: string) {
    if (next === model) { setAutoModeOpen(false); return; }
    setModel(next);
    setAutoModeOpen(false);
    try { window.localStorage.setItem("harness.model", next); } catch {}
    // 该版本 app-server 没有 thread/settings/update（调用会报 RPC -32601）。
    // 协议上模型覆盖由 turn/start 的 model 参数完成，下一条消息即生效并延续后续轮次。
    setStatus(`已切换模型：${modelInfo(next).isAuto ? "Auto Model" : modelInfo(next).name}（下条消息生效）`);
  }

  function handleLogout() {
    setCloudConnected(false);
    setConnected(false);
    setRunning(false);
    setPending(false);
    setActiveThread(null);
    activeThreadRef.current = null;
    setMessages([]);
    setApprovals([]);
    setCloudPass("");
    setStatus("已退出登录");
  }

  // 读取应用版本号（Tauri 运行时），失败兜底 package 版本
  useEffect(() => {
    (async () => {
      try {
        const app = await import("@tauri-apps/api/app");
        const v = await app.getVersion();
        if (v) setAppVersion(v);
      } catch { /* 浏览器开发模式保留默认值 */ }
    })();
  }, []);

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

  /** 批准当前队列里的全部待审批项，并切到完全访问模式。 */
  async function approveAllAndGoFull() {
    const current = approvalsRef.current;
    let failed = 0;
    for (const a of current) {
      try {
        await codex.respondApproval(a.id, "acceptForSession");
      } catch {
        failed += 1;
      }
    }
    setApprovals([]);
    setApprovalOpen(false);
    setAccessMode("full");
    accessModeRef.current = "full";
    setTerminalLines((prev) => [
      ...prev,
      {
        ts: Date.now(),
        text: `[审批] 已批准 ${current.length - failed}/${current.length} 条并切换为完全访问`,
        stream: "meta" as const,
      },
    ].slice(-500));
    setStatus(
      failed > 0
        ? `完全访问已开启，但有 ${failed} 条批准失败（可能已过期）`
        : "已切换为完全访问模式，后续操作自动批准",
    );
  }

  // ------- 登录（登录成功后拉起本地 codex） -------
  async function handleCloudLogin() {
    const isTauriEnv = (typeof (window as any).__TAURI_INTERNALS__ !== "undefined" || typeof (window as any).__TAURI__ !== "undefined");
    // 浏览器开发模式：invoke 不可用，直接 mock 登录成功
    if (!isTauriEnv) {
      setStatus("登录中…");
      await new Promise((r) => setTimeout(r, 400));
      setCloudConnected(true);
      setStatus("浏览器 mock 模式 · 已登录");
      return;
    }
    try {
      setStatus("登录中…");
      const result = await codex.cloudLogin({
        username: cloudUser,
        password: cloudPass,
      });
      if (!result.ok || !result.token) {
        setStatus("登录失败：请检查用户名和密码");
        return;
      }
      setCloudConnected(true);
      setStatus("已登录");

      // 登录拿到 token 后才能启动 codex（模型请求靠它鉴权）
      if (codexHome && codexBin) {
        await bootLocalCodex(codexHome, codexBin);
        try {
          const list = await codex.sessionList(codexHome);
          setSessions(list.map((m) => ({
            id: m.id, title: m.title || m.id,
            provider: m.provider, model: m.model, status: "done" as const,
            updatedAt: m.updatedAt,
          })));
        } catch { /* 首次无会话 */ }
      } else {
        setStatus("已登录，等待运行路径就绪…");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      setStatus(`登录失败: ${msg}`);
    }
  }

  // ------- 发送消息 -------
  async function send() {
    const text = input.trim();
    const hasFiles = attachments.length > 0;
    if ((!text && !hasFiles) || pending) return;
    if (!codexHome) { setStatus("运行路径尚未就绪，请稍后"); return; }
    if (!cloudConnected) { setStatus("请先登录"); return; }
    if (!connected) { setStatus("本地 codex 尚未就绪，请稍后"); return; }

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
    resetActivity();

    // 先把附件转成 codex 能用的形式（图片 dataURL / 文本内联 / 其它落 workspace）
    let imageUrls: string[] = [];
    let attachmentNote = "";
    try {
      const prepared = await prepareAttachments(cwd, modelInfo(model).multiModal);
      imageUrls = prepared.imageUrls;
      const parts: string[] = [];
      if (prepared.inlineTexts.length) parts.push(prepared.inlineTexts.join("\n\n"));
      if (prepared.savedPaths.length) {
        parts.push(
          "用户已附上以下本地文件，可用你的文件工具读取处理：\n" +
            prepared.savedPaths.map((x) => `- ${x}`).join("\n"),
        );
      }
      attachmentNote = parts.join("\n\n");
    } catch (e) {
      setPending(false);
      setStatus(e instanceof Error ? e.message : String(e));
      setLastError(e instanceof Error ? e.message : String(e));
      return;
    }
    const fileNames = attachments.map((a) => a.name);
    const displayText = text || `（发送了 ${fileNames.length} 个文件：${fileNames.join("、")}）`;
    setAttachments([]);

    const userMsg: Msg = { role: "user", text: displayText };
    const next = [...msgsRef.current, userMsg];
    setMessages(next);
    setTerminalLines((prev) => [
      ...prev, { ts: Date.now(), text: `[user]: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`, stream: "meta" as const },
    ].slice(-500));

    try {
      const promptText = text;

      // ===== 本地 codex 模式（v0.7.0 增强） =====
      // 模型经服务端 /api/v1/llm 代理（Responses 直连，tool_calls 无损）；
      // 文件读写、命令执行、MCP（飞书/影刀）全部在本地，不受云端影响。

      // 若有选中的 skill，把它注入 prompt 头部（codex 会读取 $CODEX_HOME/skills 中的 SKILL.md 指引）
      const bodyText = attachmentNote ? `${promptText}${promptText ? "\n\n" : ""}${attachmentNote}` : promptText;
      const finalText = selectedSkill ? `[skill: ${selectedSkill}]
${bodyText}` : bodyText;

      // --- 阶段 1：建线程（如果需要） ---
      let threadId = activeThreadRef.current;
      if (!threadId) {
        setStatus("创建会话…");
        try {
          const nid = await codex.threadStart({ model, modelProvider: provider, cwd });
          threadId = nid;
          threadProviderRef.current = provider;
          // 先把本轮消息写进新会话的缓存并同步 ref，否则 setActiveThread 触发的
          // 恢复 effect 会读到空缓存，把刚发出的用户消息清掉（新建对话后不跳转的根因）。
          sessionMessagesRef.current[nid] = next;
          activeThreadRef.current = nid;
          setActiveThread(nid);
          setSessions((s) => [...s, {
            id: nid,
            title: (text || fileNames[0] ? (text || `附件：${fileNames[0]}`) : "新任务").slice(0, 24) + ((text || "").length > 24 ? "…" : ""),
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
        await codex.turnStart({ threadId: tid, cwd, text: finalText, images: imageUrls, model });
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

  /** 对话打断：向 codex 发 turn/interrupt，停掉当前生成/命令执行。 */
  async function interruptTurn() {
    const tid = activeThreadRef.current;
    const turnId = activeTurnIdRef.current;
    if (!tid) { setRunning(false); return; }
    setStatus("正在打断…");
    try {
      if (turnId) await codex.turnInterrupt(tid, turnId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`打断失败: ${msg}`);
      setTerminalLines((prev) => [
        ...prev, { ts: Date.now(), text: `[turn/interrupt] 失败: ${msg}`, stream: "stderr" as const },
      ].slice(-500));
      return;
    }
    // 本地立即停转；codex 随后还会发 turn/completed（interrupted），走同一收尾
    activeTurnIdRef.current = "";
    patchActivity((a) => ({ ...a, steps: a.steps.map((x) => ({ ...x, done: true })) }));
    setRunning(false);
    setStatus("已打断当前任务");
    setTerminalLines((prev) => [
      ...prev, { ts: Date.now(), text: `[turn/interrupt] 已打断`, stream: "meta" as const },
    ].slice(-500));
  }

  function newChat() {
    setActiveThread(null); setMessages([]); setApprovals([]); setRunning(false);
    setLastError(null); threadProviderRef.current = null;
  }

  function requestDelete(id: string, title: string) {
    setConfirmDel({ open: true, id, title });
  }

  async function confirmDeleteSession() {
    const { id, title } = confirmDel;
    setConfirmDel({ open: false, id: "", title: "" });
    // codex 跑在本地，会话文件也在本地：删文件 + 清 UI 缓存
    try {
      await codex.sessionDelete(codexHome, id);
    } catch { /* 未落盘的新会话没有文件，忽略 */ }
    delete sessionMessagesRef.current[id];
    setSessions((prev) => prev.filter((x) => x.id !== id));
    if (id === activeThread) {
      activeThreadRef.current = null;
      setActiveThread(null);
      setMessages([]);
    }
    setStatus(`已删除「${title}」`);
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
    // 先看本地内存缓存（本轮未落盘的会话），再回落到 SQLite
    const cached = sessionMessagesRef.current[id];
    try {
      const d = await codex.sessionGet(codexHome, id);
      handleLoadSession(d);
    } catch {
      activeThreadRef.current = id;
      setActiveThread(id);
      setMessages(cached ?? []);
      setApprovals([]);
      threadProviderRef.current = null;
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
          <h2>Codex Harness 登录</h2>
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
          onClick={focusSessionSearch}
          title="搜索任务"
        >
          {IconSearch}
        </button>
        <button
          className="tb-menu-btn"
          data-tauri-drag-region="false"
          onClick={openRename}
          title="重命名当前任务"
        >
          编辑<span className="mn">(E)</span>
        </button>
        <button
          className="tb-menu-btn"
          data-tauri-drag-region="false"
          onClick={() => setHelpOpen(true)}
          title="帮助与快捷键"
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
              ref={sideSearchRef}
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
                    <span className="s-text">{s.title}</span>
                  </div>
                  <div className="s-meta">
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
            <div className="avatar" title={cloudUser || "当前账号"}>
              {(cloudUser || "U").slice(0, 1).toUpperCase()}
            </div>
            <div className="user-info">
              <span className="n">{cloudUser || "未登录"}</span>
              <span className="r" title={status}>v{appVersion}{connected ? " · 在线" : ""}</span>
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
            <button
              className="tb-icon-btn tiny"
              onClick={handleLogout}
              title="退出登录 / 切换账号"
              aria-label="退出登录"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
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

          <section className="msglist" ref={msgsListRef}>
            {/* 审批提示条：不再顶掉对话内容，点击进入审批弹窗 */}
            {approvals.length > 0 && accessMode === "auto" && (
              <div className="approval-banner" onClick={() => setApprovalOpen(true)}>
                <span className="ab-dot" />
                <span className="ab-text">有 {approvals.length} 条操作等待批准</span>
                <button className="ab-btn" onClick={(e) => { e.stopPropagation(); setApprovalOpen(true); }}>去处理</button>
                <button
                  className="ab-btn ab-btn-ghost"
                  onClick={(e) => { e.stopPropagation(); void approveAllAndGoFull(); }}
                >全部允许</button>
              </div>
            )}
            {messages.length === 0 ? (
              <div className="placeholder">
                <h1 className="hero-title">今天想做什么？</h1>

                <div className="shortcuts">
                  {STARTER_CHIPS.map((c) => (
                    <div
                      key={c.title}
                      className="chip"
                      title={c.text}
                      onClick={() => {
                        setInput(c.text);
                        setSelectedSkill(c.skill ?? "");
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{c.desc}</div>
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
                {(activity.steps.length > 0 || activity.reasoning.trim()) && (
                  <div className="msg assistant">
                    <div className="msg-avatar harness">H</div>
                    <div className="think-inline">
                      {activity.steps.length > 0 && (() => {
                        const cur = activity.steps[activity.steps.length - 1];
                        return (
                          <div className="think-action">
                            {running && !cur.done
                              ? <span className="think-spinner" />
                              : <span className="think-tick">✓</span>}
                            <span className="think-action-title">{cur.title}</span>
                            {cur.detail && <span className="think-action-detail" title={cur.detail}>{cur.detail}</span>}
                          </div>
                        );
                      })()}
                      {activity.reasoning.trim() && (
                        <div className="think-stream" ref={thinkReasonRef}>{activity.reasoning}</div>
                      )}
                    </div>
                  </div>
                )}
                {running && !(activity.steps.length > 0 || activity.reasoning.trim()) && (
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

                {/* 插件 / Skill 选择：下拉列出本地已启用的 skill */}
                <div className="skill-pick-wrap">
                  <button
                    className={`bar-btn-plus ${selectedSkill ? "is-on" : ""}`}
                    title={selectedSkill ? `当前工作流：${skillLabel(selectedSkill)}` : "选择工作流 / 插件"}
                    onClick={() => {
                      const next = !skillMenuOpen;
                      setSkillMenuOpen(next);
                      if (next) loadSkillOptions(codexHome);
                    }}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
                  </button>
                  {skillMenuOpen && (
                    <>
                      <div className="auto-mode-backdrop" onClick={() => setSkillMenuOpen(false)} />
                      <div className="skill-pick-menu">
                        <div className="auto-group-label">工作流 / 插件</div>
                        <button
                          className={`auto-item ${selectedSkill === "" ? "active" : ""}`}
                          onClick={() => { setSelectedSkill(""); setSkillMenuOpen(false); }}
                        >
                          <span className="auto-item-name skill-pick-name">自由对话</span>
                          {selectedSkill === "" && <span className="auto-item-check">✓</span>}
                        </button>
                        {skillOptions.map((sk) => (
                          <button
                            key={sk.id}
                            className={`auto-item ${selectedSkill === sk.id ? "active" : ""}`}
                            title={sk.desc}
                            onClick={() => { setSelectedSkill(sk.id); setSkillMenuOpen(false); }}
                          >
                            <span className="auto-item-name skill-pick-name">{sk.label}</span>
                            {selectedSkill === sk.id && <span className="auto-item-check">✓</span>}
                          </button>
                        ))}
                        {!skillLoading && skillOptions.length === 0 && (
                          <div className="skill-pick-empty">
                            未检测到已启用的 skill
                            <button
                              className="skill-pick-link"
                              onClick={() => { setSkillMenuOpen(false); setPluginsOpen(true); }}
                            >去插件管理安装</button>
                          </div>
                        )}
                        {skillLoading && <div className="skill-pick-empty">扫描中…</div>}
                      </div>
                    </>
                  )}
                </div>

                {/* 访问模式切换：自动审批 ↔ 完全访问 */}
                <div className="bar-btn-approval-wrap">
                  <button
                    className={`bar-btn-approval ${accessMode === "full" ? "is-full" : ""}`}
                    onClick={() => {
                      if (accessMode === "auto") { void approveAllAndGoFull(); return; }
                      setAccessMode("auto");
                      accessModeRef.current = "auto";
                      setStatus("已切换回自动审批模式");
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
                    title={modelInfo(model).isAuto ? "切换模型 · Auto Model" : `切换模型 · ${modelInfo(model).name}`}
                  >
                    {modelInfo(model).isAuto ? (
                      <span className="auto-label">Auto Model</span>
                    ) : (
                      <>
                        <span className="auto-logo">
                          <img src={modelLogo(model)} alt="" className="auto-logo-img" />
                        </span>
                        <span className="auto-label">{modelInfo(model).name}</span>
                      </>
                    )}
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
                          const label = m.isAuto ? "Auto Model" : m.name;
                          return (
                            <button
                              key={m.id}
                              className={`auto-item ${isActive ? "active" : ""}`}
                              title={m.multiModal ? "支持图片输入" : "纯文本模型"}
                              onClick={() => { void switchModel(m.id); }}
                            >
                              {!m.isAuto && (
                                <span className="auto-item-logo">
                                  <img src={modelLogo(m.id)} alt="" className="auto-item-logo-img" />
                                </span>
                              )}
                              <span className="auto-item-name">{label}</span>
                              {m.multiModal && <span className="auto-mm-tag" title="支持图片输入">多模态</span>}
                              {isActive && <span className="auto-item-check">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>

                {/* 发送 / 打断按钮（运行中显示停止方块） */}
                {running ? (
                  <button
                    className="btn-send btn-stop"
                    onClick={() => { void interruptTurn(); }}
                    title="打断当前任务"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>
                  </button>
                ) : (
                  <button
                    className="btn-send"
                    disabled={pending || !paths || (!input.trim() && attachments.length === 0)}
                    onClick={send}
                    title="发送 (Enter)"
                  >
                    {IconSend}
                  </button>
                )}
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

          </footer>
          </>
          )}
        </main>

        {/* 右栏：完全删除（原 ToolPanel / 审批/会话/终端/浏览器/画布/快捷键 Tabs 整体移除） */}
      </div>

      {/* ============ 审批浮层（右下角） ============ */}
      {approvals.length > 0 && accessMode === "auto" && !approvalOpen && (
        <div className="approval-toast">
          <div className="at-card">
            <div className="at-title">
              <span className="at-dot" /> 有 {approvals.length} 条审批待处理
            </div>
            <div className="at-actions">
              <button className="btn sm" onClick={() => setApprovalOpen(true)}>查看</button>
              <button
                className="btn sm primary"
                onClick={() => void approveAllAndGoFull()}
              >全部允许</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 审批弹窗（Trae Work 图一风格，直接嵌入 styled ApprovalPanel） ============ */}
      {approvalOpen && approvals.length > 0 && (
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
              onApproveAll={() => void approveAllAndGoFull()}
            />
          </div>
        </div>
      )}

      {/* ============ Modals（保留全部）============ */}





      {/* ============ 首次启动向导 ============ */}
      {onboardingOpen && (
        <div className="onboarding">
          <div className="onboarding-inner">
            <h1>欢迎使用 Harness AI 工作台</h1>
            <div className="sub">飞书 · 影刀 · 脚本生成，一句话下达任务</div>
            <div className="steps">
              <div className={`step ${onboardingStep >= 1 ? "done" : onboardingStep === 0 ? "now" : ""}`} />
              <div className={`step ${onboardingStep >= 2 ? "done" : onboardingStep === 1 ? "now" : ""}`} />
              <div className={`step ${onboardingStep === 2 ? "now" : ""}`} />
            </div>

            {onboardingStep === 0 && (
              <div className="onboarding-card">
                <h3>模型已就绪</h3>
                <p>已预置默认模型，可在输入栏随时切换。</p>
              </div>
            )}

            {onboardingStep === 1 && (
              <div className="onboarding-card">
                <h3>账号信息</h3>
                <p>仅用于界面展示。</p>
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
                <ul style={{ color: "var(--text-secondary)", fontSize: 13, paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
                  <li>生成广告口播脚本并写入飞书多维表格</li>
                  <li>提交一条飞书审批并回报审批结果</li>
                  <li>准备影刀 RPA 入参并触发流程</li>
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

      {/* ============ 重命名当前任务 ============ */}
      {renameOpen && (
        <div className="modal-backdrop" onClick={() => setRenameOpen(false)}>
          <div className="confirm-delete" onClick={(e) => e.stopPropagation()}>
            <div className="cd-head">
              <span className="cd-title">重命名任务</span>
              <button className="cd-close" onClick={() => setRenameOpen(false)}>×</button>
            </div>
            <div className="cd-body">
              <input
                className="rename-input"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitRename(); }}
                placeholder="输入新的任务名称"
              />
            </div>
            <div className="cd-foot">
              <button className="cd-btn ghost" onClick={() => setRenameOpen(false)}>取消</button>
              <button className="cd-btn primary" onClick={submitRename} disabled={!renameValue.trim()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 帮助 / 快捷键 ============ */}
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="confirm-delete help-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-head">
              <span className="cd-title">帮助 · Codex Harness v{appVersion}</span>
              <button className="cd-close" onClick={() => setHelpOpen(false)}>×</button>
            </div>
            <div className="cd-body">
              <ul className="help-list">
                <li><kbd>Enter</kbd> 发送消息</li>
                <li><kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</li>
                <li><kbd>Esc</kbd> 关闭弹窗</li>
                <li>顶部「搜索」可快速查找任务，「编辑」可重命名当前任务</li>
                <li>输入框左侧可附加图片 / 文档、切换工作流与审批模式</li>
                <li>文件读写、命令执行、飞书 / 影刀等能力均在本地由 codex 完成</li>
              </ul>
            </div>
            <div className="cd-foot">
              <button className="cd-btn primary" onClick={() => setHelpOpen(false)}>知道了</button>
            </div>
          </div>
        </div>
      )}

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
