//! T10 多模型切换：内置 OpenAI / DeepSeek / GLM / Qwen / Claude / Moonshot / Doubao 预设提供商。

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

/** 内置预设（企业常用 OpenAI 兼容模型供应商）。
 *  首个预设为「火山方舟 Ark Code」——用户指定先把该 API 写死接入，后期可通过配置面板更换。 */
export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "volcengine-ark",
    name: "火山方舟 Ark Code",
    // base_url 指向本机内嵌网关（127.0.0.1:18762），网关负责把
    // Responses SSE 归一化（过滤 reasoning、补 content）；真实 Ark
    // 端点与 API key 只由网关持有。改回真实地址请同步 wire_api=responses。
    base_url: "http://127.0.0.1:18762/v1",
    env_key: "VOLCENGINE_ARK_API_KEY",
    wire_api: "responses",
    models: ["ark-code-latest", "ark-code-250815"],
    default_model: "ark-code-latest",
  },
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
    id: "openai-custom",
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
    wire_api: "responses",
    models: ["deepseek-chat", "deepseek-reasoner"],
    default_model: "deepseek-chat",
  },
  {
    id: "glm",
    name: "GLM（智谱）",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    env_key: "ZHIPUAI_API_KEY",
    wire_api: "responses",
    models: ["glm-4-plus", "glm-4-air"],
    default_model: "glm-4-plus",
  },
  {
    id: "qwen",
    name: "Qwen（阿里百炼）",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    env_key: "DASHSCOPE_API_KEY",
    // wire_api=responses：若百炼该端点暂不直接兼容 Responses，
    // codex 侧仍会走统一 wire；遇到兼容问题时可在网关侧加翻译层（参照 ark_gateway）。
    wire_api: "responses",
    models: ["qwen-max", "qwen-plus", "qwen-coder-turbo"],
    default_model: "qwen-plus",
  },
  {
    id: "claude",
    name: "Claude（Anthropic）",
    base_url: "https://api.anthropic.com/v1",
    env_key: "ANTHROPIC_API_KEY",
    // wire_api=responses：Anthropic Messages API 并非完全兼容 Responses，
    // 实际生产建议通过兼容代理（如 OpenRouter 或自建类似 ark_gateway 的翻译层）接入；
    // 此处保留统一 wire_api=responses，便于 codex 侧调用链一致。
    wire_api: "responses",
    models: ["claude-3-5-sonnet-latest", "claude-3-opus-latest", "claude-3-haiku-20240307"],
    default_model: "claude-3-5-sonnet-latest",
  },
  {
    id: "moonshot",
    name: "Moonshot（月之暗面）",
    base_url: "https://api.moonshot.cn/v1",
    env_key: "MOONSHOT_API_KEY",
    wire_api: "responses",
    models: ["moonshot-v1-auto", "moonshot-v1-128k", "moonshot-v1-8k"],
    default_model: "moonshot-v1-auto",
  },
  {
    id: "doubao",
    name: "Doubao（字节豆包）",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    env_key: "ARK_API_KEY",
    wire_api: "responses",
    models: ["doubao-pro-32k", "doubao-1-5-pro-32k-250115"],
    default_model: "doubao-pro-32k",
  },
];

export function presetFor(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((p) => p.id === id);
}
