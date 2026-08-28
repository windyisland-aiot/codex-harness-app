//! codex app-server 的 Tauri IPC 客户端封装（T05/T06 前端侧）。

import { invoke } from "@tauri-apps/api/core";

export interface AppEvent {
  method: string;
  params: Record<string, unknown>;
}

/** 启动 codex app-server（子进程）。返回 userAgent。 */
export function start(server: {
  codexBin: string;
  codexHome: string;
  /** T07：注入 codex 子进程的 provider API key 等环境变量（安全传递，不写 config）。 */
  env?: Record<string, string>;
}): Promise<string> {
  return invoke<string>("appserver_start", {
    codex_bin: server.codexBin,
    codex_home: server.codexHome,
    env: server.env ?? {},
  });
}

/**
 * 创建新会话，返回 thread id。
 * `model`/`modelProvider` 为空串时交给 codex 从 config.toml 解析（T07 单模型配置驱动）。
 */
export function threadStart(input: {
  model: string;
  modelProvider: string;
  cwd: string;
}): Promise<string> {
  return invoke<string>("appserver_thread_start", {
    model: input.model,
    model_provider: input.modelProvider,
    cwd: input.cwd,
  });
}

/** 开启一轮对话。 */
export function turnStart(input: {
  threadId: string;
  cwd: string;
  text: string;
}): Promise<unknown> {
  return invoke("appserver_turn_start", {
    thread_id: input.threadId,
    cwd: input.cwd,
    text: input.text,
  });
}

/** T10：切换当前线程的模型（覆盖随后的 turn；provider 不变）。 */
export function threadSetModel(threadId: string, model: string): Promise<void> {
  return invoke("appserver_thread_set_model", { thread_id: threadId, model });
}

/** 取走自上次以来缓冲的通知。 */
export function pollEvents(): Promise<AppEvent[]> {
  return invoke<AppEvent[]>("appserver_poll_events");
}

/** T08：取走待处理的审批请求。 */
export interface ApprovalRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}
export function pollApprovals(): Promise<ApprovalRequest[]> {
  return invoke<ApprovalRequest[]>("appserver_poll_approvals");
}

/** T08：回复审批（decision ∈ accept / acceptForSession / decline / cancel）。 */
export function respondApproval(requestId: number, decision: string): Promise<void> {
  return invoke("appserver_respond_approval", {
    request_id: requestId,
    decision,
  });
}

/** 停止 app-server。 */
export function stop(): Promise<void> {
  return invoke("appserver_stop");
}

// --- T11 模型路由 ---

export interface RouteDecision {
  provider: string;
  model: string;
  reason: string;
}

/**
 * 调用模型路由：按任务类型 / 上下文长度 / 成本 / 敏感度推荐模型。
 * `taskType` 为空时由后端自动识别；`maxCost` 为空表示不设成本上限。
 */
export function route(
  prompt: string,
  opt?: {
    taskType?: string;
    ctxTokens?: number;
    sensitive?: boolean;
    maxCost?: number;
  }
): Promise<RouteDecision> {
  return invoke<RouteDecision>("router_resolve", {
    prompt,
    task_type: opt?.taskType ?? "",
    estimated_context_tokens: opt?.ctxTokens ?? 0,
    sensitive: opt?.sensitive ?? false,
    max_cost: opt?.maxCost ?? null,
  });
}

// --- T09 配置面板 ---

export interface ProviderConfig {
  id: string;
  name: string;
  base_url: string;
  env_key: string;
  wire_api: string;
}

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  /** 每条 `KEY=value`，序列化为 `env = { KEY = "value" }`。 */
  env: string[];
  /** 透传进程环境变量名。 */
  env_vars: string[];
  enabled: boolean;
}

export interface AppConfig {
  model: string;
  model_provider: string;
  approval_policy: string;
  model_providers: ProviderConfig[];
  mcp_servers: McpServerConfig[];
}

/** 读取当前 `CODEX_HOME` 下的配置。 */
export function configRead(codexHome: string): Promise<AppConfig> {
  return invoke<AppConfig>("config_read", { codex_home: codexHome });
}

/** 合并写回配置。 */
export function configWrite(codexHome: string, config: AppConfig): Promise<void> {
  return invoke("config_write", { codex_home: codexHome, config });
}

// --- T12 飞书 MCP ---

export interface FeishuStatus {
  registered: boolean;
  command?: string;
  args?: string[];
  env_keys?: string[];
  env_vars?: string[];
  enabled?: boolean;
}

/** 注册（或覆写）`[mcp_servers.feishu]`，env 为直接注入、env_vars 为透传。 */
export function feishuRegisterMcp(input: {
  codexHome: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  envVars: string[];
}): Promise<McpServerConfig> {
  return invoke<McpServerConfig>("feishu_register_mcp", {
    codex_home: input.codexHome,
    command: input.command,
    args: input.args,
    env: input.env,
    env_vars: input.envVars,
  });
}

/** 回读飞书 MCP 注册状态。 */
export function feishuStatus(codexHome: string): Promise<FeishuStatus> {
  return invoke<FeishuStatus>("feishu_status", { codex_home: codexHome });
}

// --- T13 飞书 OAuth ---

/** OAuth 命令公共参数（app_id/app_secret 为空时回退到环境变量）。 */
export interface OAuthParams {
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  baseUrl?: string;
}

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  exp_ts: number;
}

/** 用 app_id/app_secret 取 `app_access_token`（校验应用凭据）。 */
export function feishuAppToken(p: OAuthParams): Promise<{ app_access_token: string; expire: number }> {
  return invoke("feishu_oauth_app_token", { params: p });
}

/** 生成用户授权页 URL（`state` 用于回调防 CSRF）。 */
export function feishuAuthorizeUrl(p: OAuthParams, state: string): Promise<string> {
  return invoke<string>("feishu_oauth_authorize_url", { params: p, state });
}

/** 用回调 `code` 换取 `user_access_token` + `refresh_token`。 */
export function feishuExchange(p: OAuthParams, code: string): Promise<TokenBundle> {
  return invoke<TokenBundle>("feishu_oauth_exchange", { params: p, code });
}

/** 用 `refresh_token` 刷新，返回滚动后的新 token。 */
export function feishuRefresh(p: OAuthParams, refreshToken: string): Promise<TokenBundle> {
  return invoke<TokenBundle>("feishu_oauth_refresh", { params: p, refresh_token: refreshToken });
}

/** 从通知中抽取某个 method 携带的文本增量（用于流式渲染）。 */
export function textDelta(e: AppEvent): string | null {
  if (e.method === "item/agentMessage/delta") {
    const d = e.params?.delta;
    return typeof d === "string" ? d : null;
  }
  if (e.method === "item/completed") {
    const item = e.params?.item as { type?: string; text?: unknown } | undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return null;
}