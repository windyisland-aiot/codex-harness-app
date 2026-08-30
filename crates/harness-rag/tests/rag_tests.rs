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
