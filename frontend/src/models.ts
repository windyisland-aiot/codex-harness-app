//! 单模型配置 — 所有模型都走火山方舟统一端点。
//!
//! 硬编码（前端不暴露给用户编辑，后端自动注入）：
//!   BASE_URL    = https://ark.cn-beijing.volces.com/api/plan/v3
//!   ENV_KEY     = VOLCENGINE_ARK_API_KEY
//!   API_KEY     = ark-504d682a-6c53-4ee5-9c63-6ce31ffb8fa3-fd87a
//!   WIRE_API    = responses

/** 单模型条目（扁平列表，无品牌分组）。 */
export interface ModelEntry {
  id: string;
  /** 显示名（下拉里展示）。 */
  name: string;
  /** 是否支持多模态（图片 / 视频 / 文档）。 */
  multiModal: boolean;
  /** 是否为 Auto 路由（ark-code-latest）。 */
  isAuto?: boolean;
}

/** 硬编码的单一 provider — 火山方舟。 */
const VOLCES_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const VOLCES_ENV_KEY  = "VOLCENGINE_ARK_API_KEY";

/**
 * 火山方舟上可用模型列表（扁平、不分品牌）。
 *
 * 多模态能力来源：
 *   https://www.volcengine.com/docs/82379/1330310  模型列表（支持能力表）
 *   https://www.volcengine.com/docs/82379/2615194  精调数据格式（输入模态说明）
 *   https://www.volcengine.com/docs/82379/1362931  图片理解教程
 *
 *   ✅ 多模态：doubao-seed-2.0-lite/mini、minimax 系列、deepseek-v4 系列、
 *             glm 5.x、kimi-k2.5/k3 均支持 文本 + 图片（部分还支持视频）。
 *   ❌ 纯文本：ark-code-latest（Coding Plan Auto 路由，仅文本）。
 */
export const ALL_MODELS: ModelEntry[] = [
  { id: "ark-code-latest",          name: "ark-code-latest（Auto）",      multiModal: false, isAuto: true },

  { id: "doubao-seed-2.0-lite",     name: "doubao-seed-2.0-lite",          multiModal: true  },
  { id: "doubao-seed-2.0-mini",     name: "doubao-seed-2.0-mini",          multiModal: true  },

  { id: "minimax-m3",               name: "minimax-m3",                     multiModal: true  },
  { id: "minimax-seed-evolving",    name: "minimax-seed-evolving",          multiModal: true  },

  { id: "deepseek-v4-flash",        name: "deepseek-v4-flash",              multiModal: true  },
  { id: "deepseek-v4-pro",          name: "deepseek-v4-pro",                multiModal: true  },

  { id: "glm-5.3",                  name: "glm-5.3",                        multiModal: true  },
  { id: "glm-5-flash",              name: "glm-5-flash",                    multiModal: true  },

  { id: "kimi-k2.5",                name: "kimi-k2.5",                      multiModal: true  },
  { id: "kimi-k3",                  name: "kimi-k3",                        multiModal: true  },
];

/** Model ID → ModelEntry 快速查找。 */
export function modelInfo(id: string): ModelEntry {
  return ALL_MODELS.find((m) => m.id === id) ?? ALL_MODELS[0];
}

/** 对外兼容字段 — 纯 model id 列表（旧代码仍引用）。 */
export const MODEL_IDS: string[] = ALL_MODELS.map((m) => m.id);

/** 兼容旧代码的 provider 对象（保持一个假结构）。 */
export interface ModelPreset {
  id: string;
  name: string;
  base_url: string;
  env_key: string;
  wire_api: "responses" | "chat";
  models: string[];
  default_model: string;
}
export const MODEL_PRESETS: ModelPreset[] = [{
  id: "volcengine-ark",
  name: "火山方舟 Ark",
  base_url: VOLCES_BASE_URL,
  env_key: VOLCES_ENV_KEY,
  wire_api: "responses",
  models: MODEL_IDS,
  default_model: "ark-code-latest",
}];
export const VISIBLE_MODEL_PRESETS: ModelPreset[] = MODEL_PRESETS;
export function presetFor(_id: string): ModelPreset | undefined { return MODEL_PRESETS[0]; }

/** 全局硬编码的 API key（前端展示 / 写入配置用）。 */
export const ARK_HARDCODED = {
  api_key: "ark-504d682a-6c53-4ee5-9c63-6ce31ffb8fa3-fd87a",
  base_url: VOLCES_BASE_URL,
  env_key: VOLCES_ENV_KEY,
  wire_api: "responses" as const,
};
export const DEFAULT_PROVIDER_ID = "volcengine-ark";
export const DEFAULT_MODEL = "ark-code-latest";
