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

/** 取走自上次以来缓冲的通知。 */
export function pollEvents(): Promise<AppEvent[]> {
  return invoke<AppEvent[]>("appserver_poll_events");
}

/** 停止 app-server。 */
export function stop(): Promise<void> {
  return invoke("appserver_stop");
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