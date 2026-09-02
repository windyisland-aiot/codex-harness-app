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
  group?: string;
  /** 供应商 logo 图像 URL（/public/logos/ 下的真实品牌 SVG）。 */
  logoUrl?: string;
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

/** 供应商 logo 元信息（真实品牌 logo，走 /public/logos/*.svg）。 */
export interface ProviderLogo {
  id: string;
  name: string;
  /** 主色（用于选中边框/标签等）。 */
  color: string;
  /** 彩色官方 logo（lobehub 官方品牌图标 / 各公司 Favicon）。 */
  logoUrl: string;
}

/**
 * 所有 logo SVG 均来自 lobehub/lobe-icons 开源图标库（MIT License），
 * 已下载到 /public/logos/ 目录。这是目前最完整的中文 AI 模型官方 logo 集合。
 *
 * 具体文件：
 *   doubao(-color).svg      → 字节跳动 豆包
 *   deepseek(-color).svg    → DeepSeek
 *   minimax(-color).svg     → MiniMax
 *   moonshot.svg            → Moonshot AI（Kimi 母公司）
 *   zhipu(-color).svg       → 智谱 AI（GLM）
 *   volcengine(-color).svg  → 火山引擎（Ark 平台）
 */
export const PROVIDER_LOGOS: Record<string, ProviderLogo> = {
  "volcengine-ark": {
    id: "volcengine-ark",
    name: "火山方舟",
    color: "#00E5E5",
    logoUrl: "/logos/volcengine-color.svg",
  },
  "ark": {
    id: "ark",
    name: "Ark Auto",
    color: "#00E5E5",
    logoUrl: "/logos/volcengine-color.svg",
  },
  "doubao": {
    id: "doubao",
    name: "豆包",
    color: "#1E37FC",
    logoUrl: "/logos/doubao-color.svg",
  },
  "deepseek": {
    id: "deepseek",
    name: "DeepSeek",
    color: "#4B6BFF",
    logoUrl: "/logos/deepseek-color.svg",
  },
  "minimax": {
    id: "minimax",
    name: "MiniMax",
    color: "#E2167E",
    logoUrl: "/logos/minimax-color.svg",
  },
  "glm": {
    id: "glm",
    name: "智谱 GLM",
    color: "#2C5AF7",
    logoUrl: "/logos/zhipu-color.svg",
  },
  "kimi": {
    id: "kimi",
    name: "Kimi",
    color: "#2D6BFF",
    logoUrl: "/logos/moonshot.svg",
  },
};

/** 根据模型名推断供应商 logo（用于下拉 / pill 中显示）。 */
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
export const VISIBLE_MODEL_PRESETS: ModelPreset[] = MODEL_PRESETS;
export const ALL_MODELS: string[] = VOLCES_PROVIDER.models;

export function presetFor(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}

/** 全局硬编码的 API key（前端展示 / 写入配置用）。 */
export const ARK_HARDCODED: { api_key: string; base_url: string; env_key: string; wire_api: "responses" | "chat" } = {
  api_key: "ark-504d682a-6c53-4ee5-9c63-6ce31ffb8fa3-fd87a",
  base_url: VOLCES_PROVIDER.base_url,
  env_key: VOLCES_PROVIDER.env_key,
  wire_api: VOLCES_PROVIDER.wire_api,
};

/** 默认 provider id（唯一的那个）。 */
export const DEFAULT_PROVIDER_ID = VOLCES_PROVIDER.id;
export const DEFAULT_MODEL = VOLCES_PROVIDER.default_model;
