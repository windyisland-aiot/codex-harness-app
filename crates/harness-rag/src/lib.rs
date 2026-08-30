//! # harness-rag (T18 · MVP 第一期)
//!
//! 知识库 RAG 能力：
//! 1. [`RagClient`] —— Chroma v0.5.x HTTP API 薄封装（ureq 同步客户端）。
//! 2. [`RagMcpConfig`] —— 生成 `[mcp_servers.rag]` 的一键配置，由前端设置面板调用。
//! 3. `src/bin/harness_rag_mcp.rs` —— 面向 Codex 的 stdio JSON-RPC MCP Server（后续补齐）。
//!
//! Embedding 策略：第一期全部交给 Chroma 服务端内部默认嵌入（all-MiniLM-L6-v2）。
//! Harness 侧只传 `documents: Vec<String>` 与 metadata，不负责向量计算，体积最小。

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 默认集合名。
pub const DEFAULT_COLLECTION: &str = "harness_default";
/// 默认 Chroma 本地 HTTP base。
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:18763";

// ================= 公共类型 =================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagCollection {
    pub name: String,
    /// Chroma 内部 collection id，36 位 UUID。
    pub id: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagDocument {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchHit {
    pub id: String,
    pub document: String,
    /// 距离：越小越相关（Chroma 默认 l2）。
    pub distance: Option<f64>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchResponse {
    pub collection: String,
    pub query: String,
    pub hits: Vec<RagSearchHit>,
}

// ================= RagError =================

#[derive(Debug, Clone, PartialEq)]
pub enum RagError {
    MissingBaseUrl,
    Transport(String),
    Http(u16, String),
    Parse(String),
}
impl std::fmt::Display for RagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RagError::MissingBaseUrl => write!(f, "missing base_url"),
            RagError::Transport(s) => write!(f, "transport: {s}"),
            RagError::Http(c, m) => write!(f, "http {c}: {m}"),
            RagError::Parse(s) => write!(f, "parse: {s}"),
        }
    }
}
impl std::error::Error for RagError {}

// ================= RagClient =================

#[derive(Debug, Clone)]
pub struct RagClient {
    pub base_url: String,
    pub timeout: Duration,
    agent: ureq::Agent,
}
impl RagClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self::with_timeout(base_url, Duration::from_secs(30))
    }
    pub fn with_timeout(base_url: impl Into<String>, timeout: Duration) -> Self {
        let base: String = base_url.into();
        let agent = ureq::AgentBuilder::new().timeout(timeout).build();
        Self { base_url: base.trim_end_matches('/').to_string(), timeout, agent }
    }
}

// ================= RagClient: 实现 =================

#[derive(Deserialize)]
struct Heartbeat {
    #[serde(rename = "nanosecond heartbeat", default)]
    _ns: Option<u64>,
}

#[derive(Deserialize)]
struct ChromaCollection {
    name: String,
    id: String,
    #[serde(default)]
    metadata: Option<BTreeMap<String, Value>>,
}
impl From<ChromaCollection> for RagCollection {
    fn from(c: ChromaCollection) -> Self {
        RagCollection {
            name: c.name,
            id: c.id,
            metadata: c.metadata.unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
struct AddResp {
    #[serde(default)]
    ids: Vec<String>,
}

#[derive(Deserialize)]
struct QueryResp {
    ids: Vec<Vec<String>>,
    documents: Vec<Vec<String>>,
    distances: Option<Vec<Vec<Option<f64>>>>,
    metadatas: Option<Vec<Vec<Option<BTreeMap<String, Value>>>>>,
}

impl RagClient {
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn do_req(&self, req: ureq::Request, body: Option<Value>) -> Result<(u16, String), RagError> {
        let result = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        match result {
            Ok(resp) => {
                let code = resp.status();
                let body = resp
                    .into_string()
                    .map_err(|e| RagError::Transport(format!("read body: {e}")))?;
                Ok((code, body))
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp
                    .into_string()
                    .unwrap_or_else(|_| String::new());
                Ok((code, body))
            }
            Err(e) => Err(RagError::Transport(e.to_string())),
        }
    }

    /// 把 (code, body) 映射为 RagError：非 2xx 走 Http(code,body)，否则返回 body。
    fn check_ok(&self, code: u16, body: String) -> Result<String, RagError> {
        if (200..300).contains(&code) {
            Ok(body)
        } else {
            Err(RagError::Http(code, body))
        }
    }

    pub fn health(&self) -> Result<(), RagError> {
        if self.base_url.is_empty() {
            return Err(RagError::MissingBaseUrl);
        }
        let (code, body) = self.do_req(self.agent.get(&self.url("/api/v1/heartbeat")), None)?;
        let body = self.check_ok(code, body)?;
        // 只要 JSON 能解析为带 heartbeat 字段即可（Chroma 0.5.x 里叫 "nanosecond heartbeat"）。
        serde_json::from_str::<Heartbeat>(&body)
            .map_err(|e| RagError::Parse(format!("heartbeat JSON: {e}")))?;
        Ok(())
    }

    pub fn list_collections(&self) -> Result<Vec<RagCollection>, RagError> {
        if self.base_url.is_empty() {
            return Err(RagError::MissingBaseUrl);
        }
        let (code, body) = self.do_req(self.agent.get(&self.url("/api/v1/collections")), None)?;
        let body = self.check_ok(code, body)?;
        let raw: Vec<ChromaCollection> =
            serde_json::from_str(&body).map_err(|e| RagError::Parse(format!("collections: {e}")))?;
        Ok(raw.into_iter().map(RagCollection::from).collect())
    }

    pub fn get_or_create_collection(&self, name: &str) -> Result<RagCollection, RagError> {
        if self.base_url.is_empty() {
            return Err(RagError::MissingBaseUrl);
        }
        let payload = serde_json::json!({
            "name": name,
            "get_or_create": true,
        });
        let (code, body) = self.do_req(
            self.agent.post(&self.url("/api/v1/collections")),
            Some(payload),
        )?;
        let body = self.check_ok(code, body)?;
        let raw: ChromaCollection =
            serde_json::from_str(&body).map_err(|e| RagError::Parse(format!("collection: {e}")))?;
        Ok(raw.into())
    }

    pub fn add_documents(&self, coll_id: &str, docs: &[RagDocument]) -> Result<Vec<String>, RagError> {
        if self.base_url.is_empty() {
            return Err(RagError::MissingBaseUrl);
        }
        let ids: Vec<&str> = docs.iter().map(|d| d.id.as_str()).collect();
        let documents: Vec<&str> = docs.iter().map(|d| d.text.as_str()).collect();
        let metadatas: Vec<&BTreeMap<String, Value>> = docs.iter().map(|d| &d.metadata).collect();
        let payload = serde_json::json!({
            "ids": ids,
            "documents": documents,
            "metadatas": metadatas,
        });
        let url = self.url(&format!("/api/v1/collections/{coll_id}/add"));
        let (code, body) = self.do_req(self.agent.post(&url), Some(payload))?;
        let body = self.check_ok(code, body)?;
        let r: AddResp =
            serde_json::from_str(&body).map_err(|e| RagError::Parse(format!("add: {e}")))?;
        Ok(r.ids)
    }

    pub fn search(
        &self,
        coll_id: &str,
        query: &str,
        n_results: usize,
        where_clause: Option<&Value>,
    ) -> Result<RagSearchResponse, RagError> {
        if self.base_url.is_empty() {
            return Err(RagError::MissingBaseUrl);
        }
        let mut payload = serde_json::json!({
            "query_texts": [query],
            "n_results": n_results,
            "include": ["documents","distances","metadatas"],
        });
        if let Some(w) = where_clause {
            payload["where"] = w.clone();
        }
        let url = self.url(&format!("/api/v1/collections/{coll_id}/query"));
        let (code, body) = self.do_req(self.agent.post(&url), Some(payload))?;
        let body = self.check_ok(code, body)?;
        let r: QueryResp =
            serde_json::from_str(&body).map_err(|e| RagError::Parse(format!("query: {e}")))?;
        let ids = r.ids.into_iter().next().unwrap_or_default();
        let documents = r.documents.into_iter().next().unwrap_or_default();
        let distances = r.distances.and_then(|v| v.into_iter().next()).unwrap_or_default();
        let metadatas = r.metadatas.and_then(|v| v.into_iter().next()).unwrap_or_default();
        let len = ids.len().min(documents.len());
        let mut hits = Vec::with_capacity(len);
        for i in 0..len {
            hits.push(RagSearchHit {
                id: ids[i].clone(),
                document: documents[i].clone(),
                distance: distances.get(i).copied().flatten(),
                metadata: metadatas.get(i).cloned().flatten().unwrap_or_default(),
            });
        }
        Ok(RagSearchResponse {
            collection: coll_id.into(),
            query: query.into(),
            hits,
        })
    }

    pub fn delete(&self, coll_id: &str, ids: &[String]) -> Result<(), RagError> {
        if self.base_url.is_empty() {
            return Err(RagError::MissingBaseUrl);
        }
        let payload = serde_json::json!({ "ids": ids });
        let url = self.url(&format!("/api/v1/collections/{coll_id}/delete"));
        let (code, body) = self.do_req(self.agent.post(&url), Some(payload))?;
        self.check_ok(code, body)?;
        Ok(())
    }
}

// ================= RagMcpConfig =================

/// 生成 `[mcp_servers.rag]` 的一键配置。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagMcpConfig {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub env_vars: Vec<String>,
    pub enabled: bool,
}

impl RagMcpConfig {
    /// 一键构造：`id=rag`；command 为随 MSI 分发的 stdio MCP binary；args 包含
    /// `--base-url` 与 `--default-collection`；env 暂空；env_vars 可透传
    /// `CHROMA_SERVER_AUTHN_CREDENTIALS` 等。
    pub fn build(base_url: Option<&str>, default_collection: Option<&str>) -> Self {
        let mut args = vec![
            "--base-url".into(),
            base_url.unwrap_or(DEFAULT_BASE_URL).into(),
            "--default-collection".into(),
            default_collection.unwrap_or(DEFAULT_COLLECTION).into(),
        ];
        // 开发/调试开关：MCP server 内部写 JSON 日志到用户数据目录下的 rag-mcp.log。
        args.push("--log-level".into());
        args.push("info".into());
        RagMcpConfig {
            id: "rag".into(),
            command: "./harness-rag-mcp".into(),
            args,
            env: Vec::new(),
            env_vars: vec![
                "CHROMA_SERVER_AUTHN_CREDENTIALS".into(),
                "CHROMA_SERVER_AUTHN_PROVIDER".into(),
            ],
            enabled: true,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.command.is_empty() {
            return Err("RAG MCP id/command 不能为空".into());
        }
        if !self.args.windows(2).any(|w| w[0] == "--base-url") {
            return Err("RAG MCP args 中必须包含 --base-url".into());
        }
        Ok(())
    }

    /// 转成 `harness-config::McpServerConfig` 的同名字段结构；由 tauri 侧依赖
    /// harness-config 时使用。此处不直接 import，避免 crate 耦合（前端侧 JSON 同
    /// 结构也能直接 consume）。
    pub fn into_mcp_parts(self) -> (String, String, Vec<String>, Vec<String>, Vec<String>, bool) {
        (self.id, self.command, self.args, self.env, self.env_vars, self.enabled)
    }
}

#[cfg(test)]
mod unit_config_tests {
    use super::*;

    #[test]
    fn build_defaults_populate_expected_args_and_env_vars() {
        let c = RagMcpConfig::build(None, None);
        assert_eq!(c.id, "rag");
        assert_eq!(c.command, "./harness-rag-mcp");
        assert!(c.args.contains(&"--base-url".into()));
        assert!(c.args.contains(&DEFAULT_BASE_URL.into()));
        assert!(c.args.contains(&"--default-collection".into()));
        assert!(c.args.contains(&DEFAULT_COLLECTION.into()));
        assert!(c.env_vars.iter().any(|v| v == "CHROMA_SERVER_AUTHN_CREDENTIALS"));
        c.validate().unwrap();
    }

    #[test]
    fn build_accepts_custom_base_and_collection() {
        let c = RagMcpConfig::build(Some("http://10.0.0.1:9999"), Some("ads"));
        assert!(c.args.contains(&"http://10.0.0.1:9999".into()));
        assert!(c.args.contains(&"ads".into()));
    }

    #[test]
    fn validate_rejects_missing_base_url_flag() {
        let mut c = RagMcpConfig::build(None, None);
        c.args.clear();
        c.args.push("--default-collection".into());
        c.args.push("foo".into());
        assert!(c.validate().unwrap_err().contains("--base-url"));
    }
}
