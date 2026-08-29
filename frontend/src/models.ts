//! 单模型配置：只保留「火山方舟 Ark」。
//!
//! 需求说明（用户 2026-08-30）：
//!   - 模型选择目前只留火山方舟，其他全部去掉。
//!   - 火山方舟的 URL 原生支持 Responses API，不需要走本地网关翻译 / 路由。
//!
//! base_url 直接指向火山方舟 Responses 官方端点：
//!   https://ark.cn-beijing.volces.com/api/v3
//! wire_api 为 responses，codex 直接向该端点发起 `/responses` 请求。
//! env_key = "VOLCENGINE_ARK_API_KEY"，用户在面板 / 凭据里设置即可。

export interface ModelPreset {
  id: string;
  name: string;
  base_url: string;
  env_key: string;
  wire_api: "responses" | "chat";
  models: string[];
  /** 首次选中时默认使用的模型。 */
  default_model: string;
}

/** 内置预设 — 目前仅保留火山方舟 Ark。 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "volcengine-ark",
    name: "火山方舟 Ark Code",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    env_key: "VOLCENGINE_ARK_API_KEY",
    wire_api: "responses",
    models: ["ark-code-latest", "ark-code-250815"],
    default_model: "ark-code-latest",
  },
  // 本地离线调试用（不参与 UI 列表？保留在数组里让调试时仍可用，UI 只显示 Ark）
  {
    id: "mock",
    name: "Mock（本地测试）",
    base_url: "http://127.0.0.1:8791/v1",
    env_key: "MOCK_KEY",
    wire_api: "responses",
    models: ["mock-model"],
    default_model: "mock-model",
  },
];

/** UI 展示给用户的 provider（只含真实供应商，mock 不在对话框里出现）。 */
export const VISIBLE_MODEL_PRESETS: ModelPreset[] = MODEL_PRESETS.filter((p) => p.id !== "mock");

export function presetFor(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
