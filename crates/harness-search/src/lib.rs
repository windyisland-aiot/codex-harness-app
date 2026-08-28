//! # harness-search
//!
//! T15 联网搜索：为 Agent 桌面应用集成第三方网页搜索能力。
//!
//! ## 两条通道
//!
//! 1. **直接 REST**：通过 [`TavilySearchClient`]（POST `{base}/search`）执行搜索并
//!    规整出 [`SearchResult`]（含 url / title / score / content），供前端展示“来源”。
//!    `base_url` 可注入，故单测可指向本地 mock 服务，无需真实触网。
//! 2. **MCP 通道**（对接 codex）：按 [`SearchMcpConfig::build`] 生成
//!    `[mcp_servers.tavily]` 的 `command/args/env`，注册后 codex 即可在 Agent 对话中
//!    调用 Tavily/Serper 的 `web_search` 工具。
//!
//! ## 安全提示
//!
//! API key 只通过环境变量注入 MCP 进程（`TAVILY_API_KEY`），不写入 config.toml 明文以外的
//! 不该落地位置；直接 REST 优先从环境读取 key，避免在命令行/日志中暴露。

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 内置搜索供应商。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    #[serde(rename = "tavily")]
    Tavily,
    #[serde(rename = "serper")]
    Serper,
}

impl SearchProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            SearchProvider::Tavily => "tavily",
            SearchProvider::Serper => "serper",
        }
    }
}

/// 一条搜索结果（供“来源展示”）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    /// 相关度（0..1，越高越相关；缺失为 None）。
    pub score: Option<f64>,
    /// 内容摘要。
    pub content: String,
}

/// 一次搜索的聚合返回。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<SearchResult>,
}

/// 搜索客户端配置。
#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub provider: SearchProvider,
    /// REST 基础地址（默认 `https://api.tavily.com`）。
    pub base_url: String,
    /// API key（为空时从 `TAVILY_API_KEY` / `SERPER_API_KEY` 环境变量读取）。
    pub api_key: String,
    pub timeout: Duration,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            provider: SearchProvider::Tavily,
            base_url: "https://api.tavily.com".to_string(),
            api_key: String::new(),
            timeout: Duration::from_secs(20),
        }
    }
}

impl SearchConfig {
    pub fn tavily(api_key: impl Into<String>) -> Self {
        Self {
            provider: SearchProvider::Tavily,
            api_key: api_key.into(),
            ..Self::default()
        }
    }
}

/// 解析出的 API key（从显式参数或进程环境）。
pub fn resolve_api_key(config: &SearchConfig) -> Result<String, String> {
    if !config.api_key.is_empty() {
        return Ok(config.api_key.clone());
    }
    let var = match config.provider {
        SearchProvider::Tavily => "TAVILY_API_KEY",
        SearchProvider::Serper => "SERPER_API_KEY",
    };
    std::env::var(var).map_err(|_| format!("缺少 {var}（或显式传入 api_key）"))
}

/// Tavily / Serper 网页搜索客户端。
#[derive(Debug, Clone)]
pub struct SearchClient {
    pub config: SearchConfig,
    agent: ureq::Agent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SearchError {
    MissingApiKey(String),
    Transport(String),
    Http(String),
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchError::MissingApiKey(m) => write!(f, "missing api key: {m}"),
            SearchError::Transport(e) => write!(f, "transport: {e}"),
            SearchError::Http(e) => write!(f, "http/parse: {e}"),
        }
    }
}

/// Tavily REST `POST /search` 的原生响应结构。
#[derive(Deserialize)]
struct TavilyRaw {
    #[serde(default)]
    query: String,
    #[serde(default)]
    results: Vec<TavilyResult>,
}

#[derive(Deserialize)]
struct TavilyResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    content: String,
}

impl SearchClient {
    pub fn new(config: SearchConfig) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(config.timeout).build();
        Self { config, agent }
    }

    /// 执行一次搜索。返回规整后的结果与来源。
    pub fn search(&self, query: &str, max_results: usize) -> Result<SearchResponse, SearchError> {
        let key = resolve_api_key(&self.config).map_err(SearchError::MissingApiKey)?;
        let url = format!("{}/search", self.config.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "api_key": key,
            "query": query,
            "max_results": max_results,
            "include_answer": true,
        });
        let resp = match self.agent.post(&url).send_json(body) {
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) => {
                return Err(SearchError::Http(format!(
                    "search endpoint returned status {code}"
                )))
            }
            Err(e) => return Err(SearchError::Transport(e.to_string())),
        };
        let raw: TavilyRaw = resp
            .into_json()
            .map_err(|e| SearchError::Http(format!("parse json: {e}")))?;
        let results = raw
            .results
            .into_iter()
            .filter(|r| !r.url.is_empty())
            .map(|r| SearchResult {
                title: r.title,
                url: r.url,
                score: r.score,
                content: r.content,
            })
            .collect();
        Ok(SearchResponse {
            query: if raw.query.is_empty() {
                query.to_string()
            } else {
                raw.query
            },
            results,
        })
    }
}

// --- MCP 注册配置生成 ---

/// 生成某个搜索供应商的 codex `[mcp_servers.<id>]` 配置。
///
/// 返回 `(id, command, args, env)`。env 仅含 API key 注入项，未提供 key 时缺省地
/// 使用 `env_vars` 透传同名环境变量（由 harness-config 支持）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchMcpConfig {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    /// 直接注入 `KEY=value`。
    pub env: Vec<String>,
    /// 透传的环境变量名。
    pub env_vars: Vec<String>,
}

impl SearchMcpConfig {
    /// 为给定供应商生成 MCP server 配置。
    pub fn build(provider: SearchProvider, api_key: Option<&str>) -> SearchMcpConfig {
        match provider {
            SearchProvider::Tavily => SearchMcpConfig {
                id: "tavily".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "tavily-mcp@latest".into()],
                env: match api_key {
                    Some(k) if !k.is_empty() => vec![format!("TAVILY_API_KEY={k}")],
                    _ => Vec::new(),
                },
                env_vars: vec!["TAVILY_API_KEY".into()],
            },
            SearchProvider::Serper => SearchMcpConfig {
                id: "serper".into(),
                command: "npx".into(),
                args: vec!["-y".into(), "serper-mcp@latest".into()],
                env: match api_key {
                    Some(k) if !k.is_empty() => vec![format!("SERPER_API_KEY={k}")],
                    _ => Vec::new(),
                },
                env_vars: vec!["SERPER_API_KEY".into()],
            },
        }
    }

    /// 校验配置可用（id 非空、且提供了可直接注入的 key 或允许透传）。
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.command.is_empty() {
            return Err("MCP server id/command 不能为空".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// 极简 mock HTTP 服务：解析请求体，返回固定 JSON。
    fn spawn_mock(handler: impl Fn(&str) -> (u16, String) + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if let Ok(mut s) = stream {
                    let mut head = Vec::new();
                    let mut one = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if s.read(&mut one).unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(one[0]);
                    }
                    let head_str = String::from_utf8_lossy(&head).to_string();
                    let len = head_str
                        .lines()
                        .find_map(|l| {
                            l.split_once(':').and_then(|(_, v)| {
                                if l.split(':').next().unwrap_or("").eq_ignore_ascii_case("content-length") {
                                    v.trim().parse().ok()
                                } else {
                                    None
                                }
                            })
                        })
                        .unwrap_or(0);
                    let mut body = vec![0u8; len];
                    if len > 0 {
                        let mut read = 0;
                        while read < len {
                            let n = s.read(&mut body[read..]).unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            read += n;
                        }
                    }
                    let req = String::from_utf8_lossy(&body).to_string();
                    let (code, rb) = handler(&req);
                    let resp = format!(
                        "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{rb}",
                        rb.len()
                    );
                    let _ = s.write_all(resp.as_bytes());
                }
            }
        });
        port
    }

    #[test]
    fn search_success_returns_parsed_results() {
        let port = spawn_mock(|req| {
            let j: serde_json::Value = serde_json::from_str(req).unwrap();
            assert_eq!(j["api_key"], "k123");
            assert_eq!(j["query"], "rust sqlite");
            assert_eq!(j["max_results"], 3);
            (
                200,
                r#"{"query":"rust sqlite","results":[{"title":"SQLite 官网","url":"https://sqlite.org/","score":0.9,"content":"SQLite is a C-language library."}]}"#.into(),
            )
        });
        let client = SearchClient::new(SearchConfig {
            api_key: "k123".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            timeout: Duration::from_secs(5),
            ..Default::default()
        });
        let resp = client.search("rust sqlite", 3).unwrap();
        assert_eq!(resp.results.len(), 1);
        let r = &resp.results[0];
        assert_eq!(r.title, "SQLite 官网");
        assert_eq!(r.url, "https://sqlite.org/");
        assert_eq!(r.score, Some(0.9));
        assert!(r.content.contains("SQLite"), "content: {}", r.content);
    }

    #[test]
    fn search_drops_empty_url_and_keeps_sources_sorted() {
        let port = spawn_mock(|_| {
            (
                200,
                r#"{"results":[{"title":"ok","url":"https://a.example/","score":0.5,"content":"x"},{"title":"no-url","url":"","score":0.2,"content":"drop me"}]}"#.into(),
            )
        });
        let client = SearchClient::new(SearchConfig {
            api_key: "k".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            ..Default::default()
        });
        let resp = client.search("q", 5).unwrap();
        assert_eq!(resp.results.len(), 1);
        assert_eq!(resp.results[0].title, "ok");
    }

    #[test]
    fn search_missing_key_errors_cleanly() {
        let client = SearchClient::new(SearchConfig {
            api_key: String::new(),
            base_url: "http://127.0.0.1:9".into(), // 不应命中网络
            ..Default::default()
        });
        match client.search("q", 3) {
            Err(SearchError::MissingApiKey(_)) => {}
            other => panic!("expected missing key, got {other:?}"),
        }
    }

    #[test]
    fn search_non_200_reports_http_error() {
        let port = spawn_mock(|_| (429, r#"{"detail":"rate limit"}"#.into()));
        let client = SearchClient::new(SearchConfig {
            api_key: "k".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            ..Default::default()
        });
        match client.search("q", 3) {
            Err(SearchError::Http(msg)) => assert!(msg.contains("429"), "{msg}"),
            other => panic!("expected http error, got {other:?}"),
        }
    }

    #[test]
    fn mcp_config_generation_for_tavily_and_serper() {
        let t = SearchMcpConfig::build(SearchProvider::Tavily, Some("abc"));
        assert_eq!(t.id, "tavily");
        assert_eq!(t.command, "npx");
        assert_eq!(t.args, vec!["-y", "tavily-mcp@latest"]);
        assert_eq!(t.env, vec!["TAVILY_API_KEY=abc".to_string()]);
        assert_eq!(t.env_vars, vec!["TAVILY_API_KEY".to_string()]);
        t.validate().unwrap();

        // 未提供 key 时应走透传。
        let t = SearchMcpConfig::build(SearchProvider::Serper, None);
        assert!(t.env.is_empty());
        assert_eq!(t.env_vars, vec!["SERPER_API_KEY".to_string()]);
        assert_eq!(t.id, "serper");
        t.validate().unwrap();
    }
}