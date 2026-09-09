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

/**
 * 启动 codex app-server（本地子进程）。返回 userAgent。
 *
 * v0.7.0：模型鉴权不再由前端传递。Rust 侧会自动读取登录态（cloud_bridge）的
 * token 与 api_base，拉起本地 Ark 网关并把 config.toml 的 base_url 指向它，
 * 由服务端 `/api/v1/llm` 代理转发到管理员配置的真实模型上游。
 * 因此调用前必须已 `cloudLogin()` 成功，否则模型请求会被服务端拒绝。
 */
export function start(server: {
  codexBin: string;
  codexHome: string;
  /** 额外注入 codex 子进程的环境变量（不含模型密钥）。 */
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

/** 开启一轮对话。images 为 data URL 列表（多模态图片输入）。 */
export function turnStart(input: {
  threadId: string;
  cwd: string;
  text: string;
  images?: string[];
  model?: string;
}): Promise<unknown> {
  return invoke("appserver_turn_start", {
    threadId: input.threadId,
    cwd: input.cwd,
    text: input.text,
    images: input.images ?? null,
    model: input.model ?? null,
  });
}

/** 取走自上次以来缓冲的通知。 */
export function pollEvents(): Promise<AppEvent[]> {
  return invoke<AppEvent[]>("appserver_poll_events");
}

/** 打断正在运行的 turn（对话打断）。turnId 来自 turn/started 通知。 */
export function turnInterrupt(threadId: string, turnId: string): Promise<void> {
  return invoke("appserver_turn_interrupt", { threadId, turnId });
}

/** 恢复磁盘上的历史线程到当前 app-server 进程（重启后旧会话发消息前必须调用）。 */
export function threadResume(threadId: string): Promise<unknown> {
  return invoke("appserver_thread_resume", { threadId });
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
  version?: string;
  /** 来源：bundled（随安装包分发）/ codex-home / custom（v0.5.3） */
  source?: "bundled" | "codex-home" | "custom" | string;
}
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  version?: string;
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

// --- T20 云端市场 & 本地导入（v0.6.0） ---

export interface CloudMarketItem {
  id: string;
  name: string;
  type: "skill" | "plugin";
  version: string;
  author?: string;
  description: string;
  tags?: string[];
  downloadUrl: string;
  size?: number;
  updatedAt?: string;
}
export interface CloudMarketResponse {
  ok: boolean;
  items: CloudMarketItem[];
  message?: string;
}
export interface CloudHealth {
  ok: boolean;
  baseUrl: string;
  message: string;
  latencyMs?: number;
}

/** 云端服务器健康检查（云服务器 118.31.107.214）。 */
export function pluginsCloudHealth(baseUrl?: string): Promise<CloudHealth> {
  return invoke<CloudHealth>("plugins_cloud_health", { baseUrl: baseUrl ?? null });
}

/** 拉取云端市场可下载的插件/技能清单。 */
export function pluginsCloudList(baseUrl?: string): Promise<CloudMarketResponse> {
  return invoke<CloudMarketResponse>("plugins_cloud_list", { baseUrl: baseUrl ?? null });
}

/** 从云端下载并安装单个插件/skill 到 codex_home 下对应目录。 */
export function pluginsCloudInstall(input: {
  codexHome: string;
  itemId: string;
  baseUrl?: string;
}): Promise<{ ok: boolean; installedDir: string; message?: string }> {
  return invoke("plugins_cloud_install", {
    codexHome: input.codexHome,
    itemId: input.itemId,
    baseUrl: input.baseUrl ?? null,
  });
}

/** 打开本地文件选择器，导入 SKILL.md 目录或 plugin.toml 插件（ZIP/文件夹）。 */
export function pluginsImportLocal(input: {
  codexHome: string;
  /** 为空时打开文件对话框让用户选 */
  sourcePath?: string;
  kind?: "skill" | "plugin" | "auto";
}): Promise<{ ok: boolean; installedDir: string; message?: string }> {
  return invoke("plugins_import_local", {
    codexHome: input.codexHome,
    sourcePath: input.sourcePath ?? null,
    kind: input.kind ?? "auto",
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

/** 写入二进制文件（base64），返回落地绝对路径。用于把非图片附件放进 workspace。 */
export function fsWriteFileB64(
  root: string,
  relPath: string,
  b64: string,
): Promise<string> {
  return invoke<string>("fs_write_file_b64", { root, relPath, b64 });
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

export interface RagSearchHit {
  id: string;
  document: string;
  distance: number;
  metadata?: unknown;
}
export interface RagSearchResult {
  collection: string;
  query: string;
  hits: RagSearchHit[];
}
/** 直接调用 Chroma 相似度检索（用于前端做检索预嗅/入库校验）。 */
export function ragSearch(opts: {
  codexHome?: string;
  baseUrl?: string;
  collection?: string;
  query: string;
  topK?: number;
}): Promise<RagSearchResult> {
  return invoke<RagSearchResult>("rag_search", {
    codexHome: opts.codexHome ?? null,
    baseUrl: opts.baseUrl ?? null,
    collection: opts.collection ?? null,
    query: opts.query,
    topK: opts.topK ?? null,
  });
}

// --- T19 飞书多维表格 Base MCP ---

export interface BaseStatus {
  registered: boolean;
  enabled: boolean;
  command?: string;
}
export interface BaseHealth {
  ok: boolean;
  message: string;
  hint?: string;
}
/** 一键注册 `[mcp_servers.base]`；默认启用 lark-openapi-mcp + bitable。 */
export function baseRegisterMcp(opts: {
  codexHome: string;
  command?: string;
  args?: string[];
  envVars?: string[];
}): Promise<BaseStatus> {
  return invoke<BaseStatus>("base_register_mcp", {
    codexHome: opts.codexHome,
    command: opts.command ?? null,
    args: opts.args ?? null,
    envVars: opts.envVars ?? null,
  });
}
export function baseStatus(codexHome: string): Promise<BaseStatus> {
  return invoke<BaseStatus>("base_status", { codexHome });
}
export function baseHealth(): Promise<BaseHealth> {
  return invoke<BaseHealth>("base_health");
}

// --- T22 审批 → 飞书审批直连 ---

export interface ApprovalFeishuResult {
  ok: boolean;
  instanceCode: string;
  link?: string;
  /** 若飞书侧返回错误代码，这里透传。 */
  code?: number;
  message: string;
}
/**
 * 把一条等待审批的 codex 内部审批请求，直接走飞书「提交审批实例」API 提单，
 * 便于审批人在飞书统一处理。返回审批实例 instance_code 和 applink 链接。
 */
export function approvalSendToFeishu(opts: {
  codexHome?: string;
  requestId: number;
  /** 审批定义 code；空串时走默认 "HarnessApproval"（后端兜底）。 */
  approvalCode?: string;
  /** 审批说明（Markdown 纯文本）。 */
  description: string;
  /** 审批单据关键字段（用于飞书审批表单/列表筛选）。 */
  fields?: Record<string, string>;
  /** 审批 UUID（幂等键）；不传后端用 requestId 兜底。 */
  uuid?: string;
}): Promise<ApprovalFeishuResult> {
  return invoke<ApprovalFeishuResult>("approval_send_to_feishu", {
    codexHome: opts.codexHome ?? null,
    requestId: opts.requestId,
    approvalCode: opts.approvalCode ?? null,
    description: opts.description,
    fields: opts.fields ?? null,
    uuid: opts.uuid ?? null,
  });
}

// --- 云端登录与鉴权 ---

export interface CloudModeStatus {
  enabled: boolean;
  hasToken: boolean;
  apiBase: string;
}

export interface CloudLoginResult {
  ok: boolean;
  token: string;
  user?: { id: string; username: string; role?: string };
}

export interface CloudHealthResult {
  ok: boolean;
  reachable: boolean;
  latencyMs?: number;
  message?: string;
  data?: unknown;
}


/** 登录 bibike 云端，获取 Bearer token。 */
export function cloudLogin(input: {
  apiBase?: string;
  username: string;
  password: string;
}): Promise<CloudLoginResult> {
  return invoke<CloudLoginResult>("cloud_login", {
    apiBase: input.apiBase ?? null,
    username: input.username,
    password: input.password,
  });
}

/** 开关云端模式。 */
export function cloudModeSet(enabled: boolean): Promise<void> {
  return invoke("cloud_mode_set", { enabled });
}

/** 读取云端模式状态。 */
export function cloudModeGet(): Promise<CloudModeStatus> {
  return invoke<CloudModeStatus>("cloud_mode_get");
}

/** 云端健康检查。 */
export function cloudHealth(): Promise<CloudHealthResult> {
  return invoke<CloudHealthResult>("cloud_health");
}



/** 从云端同步 skill 列表。 */
export function cloudSkillsSync(): Promise<{ ok: boolean; synced?: string[] }> {
  return invoke("cloud_skills_sync");
}
