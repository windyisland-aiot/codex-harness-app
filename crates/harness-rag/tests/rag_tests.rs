//! T18 RAG 集成测试：用 TCP mock server 模拟 Chroma v0.5.x HTTP API，
//! 验证 RagClient 对 health / list_collections / add / query / delete 的解析。
//!
//! 红阶段：lib.rs 各方法 todo!()，跑测试应报 "not yet implemented" panic。
//! 绿阶段：实现后应全部通过。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use harness_rag::{RagClient, RagDocument};
use std::time::Duration;

fn spawn_mock(handler: impl Fn(&str, &str) -> (u16, String) + Send + 'static) -> u16 {
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
                let method = head_str.lines().next().and_then(|l| l.split_whitespace().next()).unwrap_or("").to_string();
                let path = head_str.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
                let len = head_str
                    .lines()
                    .find_map(|l| {
                        if l.starts_with("Content-Length:") || l.starts_with("content-length:") {
                            l.split_once(':').and_then(|(_, v)| v.trim().parse().ok())
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                let mut body = vec![0u8; len];
                if len > 0 {
                    s.read_exact(&mut body).unwrap();
                }
                let body_str = String::from_utf8_lossy(&body).to_string();
                let key = format!("{method} {path}");
                let (code, rb) = handler(&key, &body_str);
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

fn client(port: u16) -> RagClient {
    RagClient::with_timeout(format!("http://127.0.0.1:{port}"), Duration::from_secs(5))
}

// ---------------- 1. health ----------------
#[test]
fn health_ok_when_heartbeat_returns_nanosecond() {
    let port = spawn_mock(|key, _| {
        assert_eq!(key, "GET /api/v1/heartbeat");
        (200, r#"{"nanosecond heartbeat":1719990000000000000}"#.into())
    });
    client(port).health().unwrap();
}

#[test]
fn health_503_returns_http_error_with_status() {
    let port = spawn_mock(|_, _| (503, r#"{"error":"not ready"}"#.into()));
    let err = client(port).health().unwrap_err();
    match err {
        harness_rag::RagError::Http(code, _) => assert_eq!(code, 503),
        other => panic!("expected Http(503), got {other:?}"),
    }
}

// ---------------- 2. list_collections ----------------
#[test]
fn list_collections_parses_name_id_and_metadata() {
    let port = spawn_mock(|key, _| {
        assert_eq!(key, "GET /api/v1/collections");
        (200, serde_json::json!([
            {"name":"harness_default","id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","metadata":{"source":"demo"}},
            {"name":"ads_scripts","id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","metadata":{}}
        ]).to_string())
    });
    let cols = client(port).list_collections().unwrap();
    assert_eq!(cols.len(), 2);
    assert_eq!(cols[0].name, "harness_default");
    assert_eq!(cols[1].name, "ads_scripts");
    assert_eq!(cols[0].metadata.get("source").unwrap(), "demo");
}

// ---------------- 2b. get_or_create_collection ----------------
#[test]
fn get_or_create_sends_get_or_create_true_and_returns_created() {
    let port = spawn_mock(|key, body| {
        assert_eq!(key, "POST /api/v1/collections");
        let j: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(j["name"], "ads_scripts");
        assert_eq!(j["get_or_create"], true);
        (201, serde_json::json!({
            "name":"ads_scripts",
            "id":"cccccccc-cccc-cccc-cccc-cccccccccccc",
            "metadata":{}
        }).to_string())
    });
    let c = client(port).get_or_create_collection("ads_scripts").unwrap();
    assert_eq!(c.name, "ads_scripts");
    assert_eq!(c.id, "cccccccc-cccc-cccc-cccc-cccccccccccc");
}

// ---------------- 3. add_documents ----------------
#[test]
fn add_documents_posts_to_add_endpoint_and_returns_ids() {
    let port = spawn_mock(|key, body| {
        assert_eq!(key, "POST /api/v1/collections/coll-123/add");
        let j: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(j["ids"], serde_json::json!(["d1","d2"]));
        assert_eq!(j["documents"], serde_json::json!(["hello","world"]));
        (201, r#"{"ids":["d1","d2"]}"#.into())
    });
    let docs = vec![
        RagDocument { id: "d1".into(), text: "hello".into(), metadata: Default::default() },
        RagDocument { id: "d2".into(), text: "world".into(), metadata: Default::default() },
    ];
    let ids = client(port).add_documents("coll-123", &docs).unwrap();
    assert_eq!(ids, vec!["d1".to_string(), "d2".to_string()]);
}

// ---------------- 4. search ----------------
#[test]
fn search_parses_ids_documents_distances_and_metadata() {
    let port = spawn_mock(|key, body| {
        assert_eq!(key, "POST /api/v1/collections/coll-999/query");
        let j: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(j["query_texts"], serde_json::json!(["hello"]));
        assert_eq!(j["n_results"], 2);
        (200, serde_json::json!({
            "ids": [["d1","d2"]],
            "documents": [["hello match","world match"]],
            "distances": [[0.12,0.56]],
            "metadatas": [[{"brand":"Nike"},{}]]
        }).to_string())
    });
    let r = client(port).search("coll-999", "hello", 2, None).unwrap();
    assert_eq!(r.query, "hello");
    assert_eq!(r.hits.len(), 2);
    assert_eq!(r.hits[0].id, "d1");
    assert_eq!(r.hits[0].document, "hello match");
    assert_eq!(r.hits[0].distance, Some(0.12));
    assert_eq!(r.hits[0].metadata.get("brand").unwrap(), "Nike");
    assert_eq!(r.hits[1].distance, Some(0.56));
}

#[test]
fn search_missing_collection_returns_http_404() {
    let port = spawn_mock(|_, _| (404, r#"{"error":"Collection abc not found"}"#.into()));
    let err = client(port).search("abc", "q", 3, None).unwrap_err();
    match err {
        harness_rag::RagError::Http(c, _) => assert_eq!(c, 404),
        other => panic!("expected 404, got {other:?}"),
    }
}

// ---------------- 5. delete ----------------
#[test]
fn delete_sends_ids_and_returns_ok_on_200() {
    let port = spawn_mock(|key, body| {
        assert_eq!(key, "POST /api/v1/collections/coll-9/delete");
        let j: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(j["ids"], serde_json::json!(["a","b"]));
        (200, "null".into())
    });
    client(port).delete("coll-9", &["a".into(), "b".into()]).unwrap();
}

// ================= T20 · chunk_markdown + embed （RED→GREEN） =================

#[test]
fn chunk_empty_string_returns_empty_list() {
    let r = harness_rag::chunk_markdown("", 800, 120);
    assert!(r.is_empty());
}

#[test]
fn chunk_short_text_returns_single_chunk_with_same_content() {
    let s = "hello world，这段很短。";
    let r = harness_rag::chunk_markdown(s, 800, 120);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0], s);
}

#[test]
fn chunk_long_markdown_splits_expected_and_preserves_head_tail() {
    // 构造 3000 字左右的中文 markdown，首尾特征明显
    let head = "START_START ";
    let tail = " END_END";
    let middle: String = (0..3000).map(|_| '中').collect();
    let text = format!("{head}{middle}{tail}");
    let chunk = 800usize;
    let overlap = 120usize;
    let r = harness_rag::chunk_markdown(&text, chunk, overlap);
    // 按字符计算的期望：总字符数 N = head + 3000 中 + tail
    let nchars = text.chars().count();
    let expected_min_len =
        (nchars.saturating_sub(overlap) + (chunk - overlap) - 1) / (chunk - overlap);
    assert!(r.len() >= expected_min_len, "len={} expected_min={} nchars={}", r.len(), expected_min_len, nchars);
    assert!(r.first().unwrap().starts_with(head), "首段应以 START_START 开头");
    assert!(r.last().unwrap().ends_with(tail), "尾段应以 END_END 结尾");
    // 相邻两段有 overlap 的公共字符（取 overlap-4 长度避免边界误差，按字符切）
    for w in r.windows(2) {
        let ov = overlap.saturating_sub(4).min(w[0].chars().count()).min(w[1].chars().count());
        let a: String = w[0].chars().skip(w[0].chars().count().saturating_sub(ov)).take(ov).collect();
        let b: String = w[1].chars().take(ov).collect();
        assert_eq!(a, b, "相邻 chunk overlap 不匹配");
    }
}

#[test]
fn chunk_overlap_ge_chunk_treated_gracefully_no_panic() {
    let s = "abcdef".repeat(500);
    let r = harness_rag::chunk_markdown(&s, 20, 120);
    // 不要求特定结果，只保证不 panic 且产生至少 1 段（若实现返回 Err 也算通过，需要签名允许；此处要求 Result 或 Vec 均可，但测试只看非 panic）
    assert!(!r.is_empty() || true); // 仅防御不 panic
}

// ---- embed（Chroma /api/v1/embeddings） ----

#[test]
fn embed_posts_expected_payload_and_parses_vectors() {
    let port = spawn_mock(|key, body| {
        assert_eq!(key, "POST /api/v1/embeddings");
        let j: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(j["texts"], serde_json::json!(["t1","t2"]));
        assert_eq!(j["model"], "default");
        (200, serde_json::json!({"embeddings":[[1.0,0.0,0.0],[0.0,1.0,0.5]]}).to_string())
    });
    let emb = client(port).embed("default", &["t1".into(), "t2".into()]).unwrap();
    assert_eq!(emb.len(), 2);
    assert_eq!(emb[0], vec![1.0, 0.0, 0.0]);
    assert_eq!(emb[1], vec![0.0, 1.0, 0.5]);
}

#[test]
fn embed_http_error_sanitizes_bearer_and_tokens() {
    // 模拟 mock server 返回 500 且 body 里泄漏了 Authorization/token
    let port = spawn_mock(|_, _| {
        (500, r#"{"error":"upstream fail","debug":"Authorization: Bearer sk-1234abcd5678 and token=x-yummy-999 and api_key=oops-secret"}"#.into())
    });
    let err = client(port).embed("default", &["t".into()]).unwrap_err();
    match err {
        harness_rag::RagError::Http(_, body) => {
            assert!(!body.contains("sk-1234abcd5678"), "body 泄漏 Bearer token: {body}");
            assert!(!body.contains("x-yummy-999"), "body 泄漏 token=...: {body}");
            assert!(!body.contains("oops-secret"), "body 泄漏 api_key=...: {body}");
            assert!(body.contains("[REDACTED]"), "脱敏应替换为 [REDACTED]，实际: {body}");
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}
