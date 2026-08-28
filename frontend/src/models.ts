//! T10 多模型切换：内置 OpenAI / DeepSeek / GLM 预设提供商。

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

/** 内置预设（企业常用 OpenAI 兼容模型供应商）。 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "mock",
    name: "Mock（本地测试）",
    base_url: "http://127.0.0.1:8791/v1",
    env_key: "MOCK_KEY",
    wire_api: "responses",
    models: ["mock-model"],
    default_model: "mock-model",
  },
  {
    id: "openai",
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    env_key: "OPENAI_API_KEY",
    wire_api: "responses",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o3"],
    default_model: "gpt-4.1",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    env_key: "DEEPSEEK_API_KEY",
    wire_api: "chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    default_model: "deepseek-chat",
  },
  {
    id: "glm",
    name: "GLM（智谱）",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    env_key: "ZHIPUAI_API_KEY",
    wire_api: "chat",
    models: ["glm-4-plus", "glm-4-air"],
    default_model: "glm-4-plus",
  },
];

export function presetFor(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}