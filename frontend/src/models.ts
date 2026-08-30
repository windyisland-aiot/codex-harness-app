//! 单模型配置：只保留「火山方舟 Ark Coding Plan 企业版」。
//!
//! 需求说明（用户 2026-08-30）：
//!   - 移除"自动路由"：模型名直接由设置面板指定，不按 prompt 分类切换。
//!   - Coding Plan 企业版唯一合法别名：`ark-code-latest`（底层模型由控制台 Auto 模式分配）。
//!   - Responses 协议兼容端点必须带 `/api/coding/v3` 路径前缀（不是普通大模型 /api/v3）。
//!
//! base_url（Coding Plan 企业版，Responses 兼容）：
//!   https://ark.cn-beijing.volces.com/api/coding/v3
//! wire_api = "responses"，codex 直接发 `/responses` 请求。
//! env_key = "VOLCENGINE_ARK_API_KEY"（Coding Plan 控制台生成的专属 Key）。

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

/** 内置预设 — 目前仅保留火山方舟 Ark Coding Plan 企业版。 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "volcengine-ark",
    name: "火山方舟 Ark Code",
    base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
    env_key: "VOLCENGINE_ARK_API_KEY",
    wire_api: "responses",
    models: ["ark-code-latest"],
    default_model: "ark-code-latest",
  },
  // 本地离线调试用（不参与 UI 列表）
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
