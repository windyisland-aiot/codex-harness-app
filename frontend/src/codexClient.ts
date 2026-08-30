//! codex app-server 的 Tauri IPC 客户端封装（T05/T06 前端侧）。
//!
//! 注意：IPC 参数命名约定：Tauri 2.x 默认按 `rename_all = "camelCase"` 反序列化。
//! 因此 Rust 端 `fn xxx(codex_home: String, thread_id: String, …)` 对应的 JS key 必须是
//! `codexHome` / `threadId` / ……（驼峰），不要写 snake_case，否则会 `missing required key`。

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
    codexBin: server.codexBin,
    codexHome: server.codexHome,
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
    modelProvider: input.modelProvider,
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
    threadId: input.threadId,
    cwd: input.cwd,
    text: input.text,
  });
}

/** T10：切换当前线程的模型（覆盖随后的 turn；provider 不变）。 */
export function threadSetModel(threadId: string, model: string): Promise<void> {
  return invoke("appserver_thread_set_model", { threadId, model });
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
    requestId,
    decision,
  });
}

/** 停止 app-server。 */
export function stop(): Promise<void> {
  return invoke("appserver_stop");
}

// --- T09 配置面板 ---

export interface ProviderConfig {
  id: string;
  name: string;
  /** codex 要求每个自定义 provider 显式声明 type="Custom"；缺省由后端回退。 */
  type?: string;
  baseUrl: string;
  envKey: string;
  wireApi: string;
}

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  /** 每条 `KEY=value`，序列化为 `env = { KEY = "value" }`。 */
  env: string[];
  /** 透传进程环境变量名。 */
  envVars: string[];
  enabled: boolean;
}

export interface AppConfig {
  model: string;
  modelProvider: string;
  approvalPolicy: string;
  modelProviders: ProviderConfig[];
  mcpServers: McpServerConfig[];
}

/** 读取当前 `CODEX_HOME` 下的配置。 */
export function configRead(codexHome: string): Promise<AppConfig> {
  return invoke<AppConfig>("config_read", { codexHome });
}

/** 合并写回配置。 */
export function configWrite(codexHome: string, config: AppConfig): Promise<void> {
  return invoke("config_write", { codexHome, config });
}

// --- T12 飞书 MCP ---

export interface FeishuStatus {
  registered: boolean;
  command?: string;
  args?: string[];
  envKeys?: string[];
  envVars?: string[];
  enabled?: boolean;
}

/** 注册（或覆写）`[mcp_servers.feishu]`，env 为直接注入、envVars 为透传。 */
export function feishuRegisterMcp(input: {
  codexHome: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  envVars: string[];
}): Promise<McpServerConfig> {
  return invoke<McpServerConfig>("feishu_register_mcp", {
    codexHome: input.codexHome,
    command: input.command,
    args: input.args,
    env: input.env,
    envVars: input.envVars,
  });
}

/** 回读飞书 MCP 注册状态。 */
export function feishuStatus(codexHome: string): Promise<FeishuStatus> {
  return invoke<FeishuStatus>("feishu_status", { codexHome });
}

// --- T13 飞书 OAuth ---

/** OAuth 命令公共参数（appId/appSecret 为空时回退到环境变量）。 */
export interface OAuthParams {
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  baseUrl?: string;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expTs: number;
}

/** 用 appId/appSecret 取 `app_access_token`（校验应用凭据）。 */
export function feishuAppToken(p: OAuthParams): Promise<{ appAccessToken: string; expire: number }> {
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

/** 用 `refresh_token` 刷新，返回滚动后的新 token（含新 refreshToken）。 */
export function feishuRefresh(p: OAuthParams, refreshToken: string): Promise<TokenBundle> {
  return invoke<TokenBundle>("feishu_oauth_refresh", { params: p, refreshToken });
}

// --- T14 插件与 Skill 系统 ---

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
}
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
}
export interface PluginsList {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  bundledSkillsEnabled: boolean;
  skillsIncludeInstructions: boolean | null;
}

/** 扫描磁盘 skills/插件，并结合当前配置返回清单。 */
export function pluginsList(input: {
  codexHome: string;
  skillRoots: string[];
  pluginRoots: string[];
}): Promise<PluginsList> {
  return invoke<PluginsList>("plugins_list", {
    codexHome: input.codexHome,
    skillRoots: input.skillRoots,
    pluginRoots: input.pluginRoots,
  });
}

/** 写回 skills 规则与插件开关。 */
export function pluginsApply(input: {
  codexHome: string;
  skills: { name: string; path: string; enabled: boolean }[];
  plugins: Record<string, boolean>;
  bundledSkillsEnabled?: boolean | null;
  skillsIncludeInstructions?: boolean | null;
}): Promise<AppConfig> {
  return invoke<AppConfig>("plugins_apply", {
    codexHome: input.codexHome,
    skills: input.skills,
    plugins: input.plugins,
    bundledSkillsEnabled: input.bundledSkillsEnabled ?? null,
    skillsIncludeInstructions: input.skillsIncludeInstructions ?? null,
  });
}

/** 追加一个自定义 skill 目录为 path 规则。 */
export function pluginsAddSkillDir(
  codexHome: string,
  dir: string,
  enabled: boolean
): Promise<AppConfig> {
  return invoke<AppConfig>("plugins_add_skill_dir", {
    codexHome,
    dir,
    enabled,
  });
}

// --- T15 联网搜索 ---

export interface SearchResult {
  title: string;
  url: string;
  score: number | null;
  content: string;
}
export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

/** 直接执行一次网页搜索（provider=tavily|serper，baseUrl 可指向内部网关/mock）。 */
export function searchExecute(input: {
  query: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  maxResults?: number;
}): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_execute", {
    query: input.query,
    provider: input.provider ?? null,
    apiKey: input.apiKey ?? null,
    baseUrl: input.baseUrl ?? null,
    maxResults: input.maxResults ?? 5,
  });
}

export interface SearchMcpStatus {
  registered: boolean;
  command?: string;
  args?: string[];
  envKeys?: string[];
  envVars?: string[];
  enabled?: boolean;
}
export interface SearchStatus {
  tavily: SearchMcpStatus;
  serper: SearchMcpStatus;
}

/** 注册 `[mcp_servers.tavily|serper]`（合并写入 config.toml）。 */
export function searchRegisterMcp(
  codexHome: string,
  provider: string,
  apiKey?: string
): Promise<McpServerConfig> {
  return invoke<McpServerConfig>("search_register_mcp", {
    codexHome,
    provider,
    apiKey: apiKey ?? null,
  });
}

/** 回读搜索 MCP 注册状态。 */
export function searchStatus(codexHome: string): Promise<SearchStatus> {
  return invoke<SearchStatus>("search_status", { codexHome });
}

// --- T16 会话持久化 (SQLite) ---

export interface SessionMsg {
  seq: number;
  role: string;
  text: string;
}
export interface SessionMeta {
  id: string;
  title: string;
  provider: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}
export interface SessionDetail {
  meta: SessionMeta;
  messages: SessionMsg[];
}

/** 整会话保存（create + upsert 消息 + 元数据）。 */
export function sessionSave(input: {
  codexHome: string;
  id: string;
  title: string;
  provider: string;
  model: string;
  cwd: string;
  messages: SessionMsg[];
}): Promise<SessionDetail> {
  return invoke<SessionDetail>("session_save", {
    codexHome: input.codexHome,
    id: input.id,
    title: input.title,
    provider: input.provider,
    model: input.model,
    cwd: input.cwd,
    messages: input.messages,
  });
}

/** 列出全部会话。 */
export function sessionList(codexHome: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("session_list", { codexHome });
}

/** 按关键词搜索会话（标题或内容）。 */
export function sessionSearch(codexHome: string, keyword: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("session_search", { codexHome, keyword });
}

/** 读取会话详情用于恢复。 */
export function sessionGet(codexHome: string, id: string): Promise<SessionDetail> {
  return invoke<SessionDetail>("session_get", { codexHome, id });
}

/** 重命名会话。 */
export function sessionRename(codexHome: string, id: string, title: string): Promise<SessionMeta> {
  return invoke<SessionMeta>("session_rename", { codexHome, id, title });
}

/** 删除会话。 */
export function sessionDelete(codexHome: string, id: string): Promise<void> {
  return invoke("session_delete", { codexHome, id });
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

// --- 运行时路径（避免写死 Linux /workspace/... 路径，Windows 也能跑） ---

export interface ResolvedPaths {
  /** `<appDataDir>/codex-home` — CODEX_HOME 根（config.toml、threads、mcp_servers、SQLite）。 */
  codexHome: string;
  /** codex 二进制的绝对路径：资源目录中的 codex.exe > env HARNESS_CODEX_BIN > PATH codex。 */
  codexBin: string;
  /** `<appDataDir>/workspace` — Codex 沙箱 `cwd`（exec_command 默认工作目录）。 */
  defaultCwd: string;
}

/** 由 Tauri 后端按平台返回正确的 codex 运行路径（跨平台安全）。 */
export function resolvePaths(): Promise<ResolvedPaths> {
  return invoke<ResolvedPaths>("harness_resolve_paths");
}

// --- T18 文件资源管理器（功能树）---
// 所有操作锚定在 root(= defaultCwd)，避免越权访问系统路径。
// rel_path 为空串表示根目录本身，子目录形如 "src/components" 或 "src\\components"。

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  ext: string | null;
}

/** 列出目录条目（目录优先，按名字排序）。 */
export function fsListDir(root: string, relPath: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("fs_list_dir", { root, relPath });
}

/** 读取小型文本文件（默认最多 4MB）。 */
export function fsReadFile(
  root: string,
  relPath: string,
  maxBytes?: number
): Promise<string> {
  return invoke<string>("fs_read_file", { root, relPath, maxBytes: maxBytes ?? null });
}

/** 写入文本文件（父目录自动创建）。 */
export function fsWriteFile(
  root: string,
  relPath: string,
  content: string
): Promise<void> {
  return invoke("fs_write_file", { root, relPath, content });
}

// ---------- v0.3.0 凭据（API key）读写 ----------

/** 读取 `<codexHome>/.env-provider`：env_key → api_value。 */
export function credsRead(codexHome: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("harness_creds_read", { codexHome });
}

/** 写凭据（合并进现有文件，保留未列出的 key；空值等于跳过）。 */
export function credsWrite(
  codexHome: string,
  creds: Record<string, string>
): Promise<void> {
  return invoke("harness_creds_write", { codexHome, creds });
}

/** 重启 app-server：更新 API key / provider 后必须重启才能生效。 */
export async function restart(opts: { codexBin: string; codexHome: string; env?: Record<string, string> }): Promise<string> {
  try { await stop(); } catch { /* 初次启动时本来就没跑 */ }
  return start(opts);
}

// --- T18 知识库 RAG ---

export interface RagStatus {
  registered: boolean;
  enabled: boolean;
  baseUrl?: string;
  collection?: string;
  command?: string;
}
export interface RagHealth {
  ok: boolean;
  baseUrl: string;
  message: string;
  hint?: string;
}

/** 一键注册 `[mcp_servers.rag]`；默认 base/collection 为空时由后端使用预设。 */
export function ragRegister(opts: {
  codexHome: string;
  baseUrl?: string;
  defaultCollection?: string;
  envVars?: string[];
}): Promise<RagStatus> {
  return invoke<RagStatus>("rag_register", {
    codexHome: opts.codexHome,
    baseUrl: opts.baseUrl ?? null,
    defaultCollection: opts.defaultCollection ?? null,
    envVars: opts.envVars ?? null,
  });
}

/** 回读 RAG 注册状态。 */
export function ragStatus(codexHome: string): Promise<RagStatus> {
  return invoke<RagStatus>("rag_status", { codexHome });
}

/** 检查 Chroma 服务存活；不传 baseUrl 时回退到默认值。 */
export function ragHealth(baseUrl?: string): Promise<RagHealth> {
  return invoke<RagHealth>("rag_health", { baseUrl: baseUrl ?? null });
}
