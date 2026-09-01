//! 单模型配置 — 所有模型都走火山方舟统一端点。
//!
//! 硬编码（前端不暴露给用户编辑，后端自动注入）：
//!   BASE_URL    = https://ark.cn-beijing.volces.com/api/plan/v3
//!   ENV_KEY     = VOLCENGINE_ARK_API_KEY
//!   API_KEY     = ark-504d682a-6c53-4ee5-9c63-6ce31ffb8fa3-fd87a
//!   WIRE_API    = responses
//!
//! 模型列表（v0.6.0 图二）：
//!   [Auto] ark-code-latest（方舟 Coding Plan 企业版，Auto 路由）
//!   豆包系列、deepseek 系列、minimax、kimi-k 系列、glm 系列
//!   全部在火山方舟平台上托管，通过统一的 base_url 区分 model 名称即可。

export interface ModelPreset {
  id: string;
  name: string;
  base_url: string;
  env_key: string;
  wire_api: "responses" | "chat";
  models: string[];
  default_model: string;
  /** 在选择器中分组展示（可选）。 */
  group?: string;
  /** 供应商 logo（inline SVG 或 emoji）。 */
  logo?: string;
}

/** 硬编码的单一 provider — 火山方舟。 */
const VOLCES_PROVIDER: ModelPreset = {
  id: "volcengine-ark",
  name: "火山方舟 Ark",
  base_url: "https://ark.cn-beijing.volces.com/api/plan/v3",
  env_key: "VOLCENGINE_ARK_API_KEY",
  wire_api: "responses",
  // 图二完整模型列表
  models: [
    "ark-code-latest",
    // 豆包（字节跳动 / Doubao）
    "doubao-seed-2.0-lite",
    "doubao-seed-2.0-mini",
    // minimax
    "minimax-m3",
    "minimax-seed-evolving",
    // deepseek
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    // glm（智谱 / Zhipu）
    "glm-5.3",
    "glm-5-flash",
    // kimi（月之暗面 / Moonshot AI）
    "kimi-k2.5",
    "kimi-k3",
  ],
  default_model: "ark-code-latest",
};

/** 模型分组（供 Auto Mode 下拉使用）。 */
export interface ModelGroup {
  label: string;
  models: string[];
}
export const MODEL_GROUPS: ModelGroup[] = [
  { label: "Auto Mode（默认）",  models: ["ark-code-latest"] },
  { label: "豆包 · Doubao",      models: ["doubao-seed-2.0-lite", "doubao-seed-2.0-mini"] },
  { label: "MiniMax",            models: ["minimax-m3", "minimax-seed-evolving"] },
  { label: "DeepSeek",           models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { label: "GLM · 智谱",         models: ["glm-5.3", "glm-5-flash"] },
  { label: "Kimi · 月之暗面",    models: ["kimi-k2.5", "kimi-k3"] },
];

/** 供应商 logo（inline SVG，24×24 适合做小徽章）。 */
export interface ProviderLogo {
  id: string;
  name: string;
  /** 主色（用于标签背景、选中边框等）。 */
  color: string;
  /** 单色 SVG 用于 light mode；另用 CSS filter 适配 dark mode。 */
  svg: string;
}

export const PROVIDER_LOGOS: Record<string, ProviderLogo> = {
  "volcengine-ark": {
    id: "volcengine-ark",
    name: "火山方舟",
    color: "#4F46E5",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none">
      <rect x="2.5" y="3" width="19" height="18" rx="4" fill="#4F46E5"/>
      <path d="M7 15.5c1.8 1.5 4.5 1.7 6.6.4 2.1-1.3 2.6-3.8 1.1-5.2-1.1-1-2.5-1.2-4-.5l1 .6-4.5 5.1z" fill="#fff"/>
      <circle cx="17" cy="7.5" r="1.8" fill="#fff"/>
    </svg>`,
  },
  // 按模型名匹配 → 供应商 logo
  "doubao": {
    id: "doubao", name: "豆包", color: "#1677FF",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#1677FF"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">豆</text></svg>`,
  },
  "deepseek": {
    id: "deepseek", name: "DeepSeek", color: "#0ECB81",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#0ECB81"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">DS</text></svg>`,
  },
  "minimax": {
    id: "minimax", name: "MiniMax", color: "#6366F1",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#6366F1"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="8" font-weight="700">MX</text></svg>`,
  },
  "glm": {
    id: "glm", name: "智谱 GLM", color: "#FF6B35",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#FF6B35"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="8" font-weight="700">GLM</text></svg>`,
  },
  "kimi": {
    id: "kimi", name: "Kimi", color: "#F59E0B",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#F59E0B"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">K</text></svg>`,
  },
  "ark": {
    id: "ark", name: "Ark Auto", color: "#7C3AED",
    svg: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#7C3AED"/><text x="12" y="16" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">AUTO</text></svg>`,
  },
};

/** 根据模型名推断供应商 logo（用于下拉中显示）。 */
export function logoForModel(model: string): ProviderLogo {
  if (model.startsWith("ark")) return PROVIDER_LOGOS["ark"];
  if (model.startsWith("doubao")) return PROVIDER_LOGOS["doubao"];
  if (model.startsWith("deepseek")) return PROVIDER_LOGOS["deepseek"];
  if (model.startsWith("minimax")) return PROVIDER_LOGOS["minimax"];
  if (model.startsWith("glm")) return PROVIDER_LOGOS["glm"];
  if (model.startsWith("kimi")) return PROVIDER_LOGOS["kimi"];
  return PROVIDER_LOGOS["volcengine-ark"];
}

/** 对外导出：所有预设（目前就一个）。 */
export const MODEL_PRESETS: ModelPreset[] = [VOLCES_PROVIDER];

/** UI 展示用（同上）。 */
export const VISIBLE_MODEL_PRESETS: ModelPreset[] = MODEL_PRESETS;

/** 所有可用模型名的扁平化列表。 */
export const ALL_MODELS: string[] = VOLCES_PROVIDER.models;

export function presetFor(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}

/** 全局硬编码的 API key（前端展示/写入配置用）。 */
export const ARK_HARDCODED: { api_key: string; base_url: string; env_key: string; wire_api: "responses" | "chat" } = {
  api_key: "ark-504d682a-6c53-4ee5-9c63-6ce31ffb8fa3-fd87a",
  base_url: VOLCES_PROVIDER.base_url,
  env_key: VOLCES_PROVIDER.env_key,
  wire_api: VOLCES_PROVIDER.wire_api,
};

/** 默认 provider id（唯一的那个）。 */
export const DEFAULT_PROVIDER_ID = VOLCES_PROVIDER.id;
export const DEFAULT_MODEL = VOLCES_PROVIDER.default_model;
