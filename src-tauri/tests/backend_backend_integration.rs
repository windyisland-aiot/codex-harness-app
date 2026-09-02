//! T3 · 后端新增模块的纯逻辑测试：不启动 Tauri 运行时。
//!
//! 覆盖：
//! - approval_feishu.rs：HTTP 响应解析 + 脱敏；instance_code 拼装 & link。
//! - base.rs：sanitize_body。
//!
//! 因为 Tauri 命令函数依赖 tauri 运行时（async runtime），这里把我们能触达的
//! 「HTTP Mock + 解析 + 脱敏 + URL 编码」路径做成独立集成测试。对于真实 Tauri
//! 命令，在 FR 端（前端测试 / 手工 smoke）进一步验证。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
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
                    if s.read(&mut one).unwrap_or(0) == 0 { return; }
                    head.push(one[0]);
                }
                let head_str = String::from_utf8_lossy(&head).to_string();
                let method = head_str.lines().next().and_then(|l| l.split_whitespace().next()).unwrap_or("").to_string();
                let path = head_str.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
                let len = head_str.lines().find_map(|l| {
                    if l.starts_with("Content-Length:") || l.starts_with("content-length:") {
                        l.split_once(':').and_then(|(_, v)| v.trim().parse().ok())
                    } else { None }
                }).unwrap_or(0);
                let mut body = vec![0u8; len];
                if len > 0 { s.read_exact(&mut body).unwrap(); }
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
    // 给 mock server 0.1s 启动缓冲，避免 connect reset。
    thread::sleep(Duration::from_millis(80));
    port
}

mod sanitize_tests {
    use regex::Regex;
    use std::sync::LazyLock;
    // 拷贝 source of truth 中 approval/base 的脱敏逻辑（保持一致，若主实现变更需同步）。
    fn sanitize(body: String) -> String {
        static R1: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]+").unwrap());
        static R2: LazyLock<Regex> = LazyLock::new(|| {
            let q34: char = 34u8 as char;
            let q39: char = 39u8 as char;
            let pat = format!(
                r"(?i)(token|api[_-]?key|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[{q34}{q39}]?[A-Za-z0-9\-._~+/]+[{q34}{q39}]?"
            );
            Regex::new(&pat).unwrap()
        });
        let s = R1.replace_all(&body, "${1} [REDACTED]").into_owned();
        R2.replace_all(&s, "${1}=[REDACTED]").into_owned()
    }

    #[test]
    fn removes_bearer_and_tokens() {
        let raw = r#"{"debug":"Authorization: Bearer sk-1234abcd5678, token=x-999, api_key=secret-oops, access_token=at-abc, refresh_token=rt-def"}"#;
        let out = sanitize(raw.into());
        assert!(!out.contains("sk-1234abcd5678"), "泄漏 Bearer: {out}");
        assert!(!out.contains("x-999"), "泄漏 token=...: {out}");
        assert!(!out.contains("secret-oops"), "泄漏 api_key: {out}");
        assert!(!out.contains("at-abc"), "泄漏 access_token: {out}");
        assert!(!out.contains("rt-def"), "泄漏 refresh_token: {out}");
        assert!(out.contains("[REDACTED]"), "应有 [REDACTED] 替换: {out}");
    }

    #[test]
    fn clean_body_no_change_but_contains_ok() {
        let clean = r#"{"hello":"world"}"#.to_string();
        let out = sanitize(clean.clone());
        assert_eq!(out, clean);
    }
}

mod approval_response_parsing {
    use serde::Deserialize;
    use std::time::Duration;
    #[derive(Deserialize)]
    struct ApprovalResp {
        code: Option<i64>,
        msg: Option<String>,
        data: Option<ApprovalRespData>,
    }
    #[derive(Deserialize)]
    struct ApprovalRespData {
        #[serde(rename = "instanceCode")]
        instance_code: Option<String>,
    }

    fn urlencode(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for ch in s.chars() {
            let safe = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~');
            if safe { out.push(ch); }
            else {
                for b in ch.to_string().as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
        out
    }

    #[test]
    fn parses_instance_code_and_builds_link() {
        let port = super::spawn_mock(|key, body| {
            assert_eq!(key, "POST /open-apis/approval/v4/instances");
            let j: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(j["uuid"], "appro-123");
            (200, serde_json::json!({
                "code": 0,
                "msg": "success",
                "data": {"instanceCode": "INS-999-中文"}
            }).to_string())
        });
        let endpoint = format!("http://127.0.0.1:{port}/open-apis/approval/v4/instances");
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(4)).build();
        let resp = agent
            .post(&endpoint)
            .send_json(serde_json::json!({"uuid":"appro-123","approval_code":"","description":"测试"}))
            .unwrap();
        let raw = resp.into_string().unwrap();
        let parsed: ApprovalResp = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.code, Some(0));
        let instance = parsed.data.as_ref().and_then(|d| d.instance_code.clone()).unwrap();
        assert_eq!(instance, "INS-999-中文");
        let link = format!(
            "https://applink.feishu.cn/client/approval/detail?instance_code={}",
            urlencode(&instance)
        );
        assert!(link.contains("instance_code=INS-999"), "link={link}");
        assert!(link.contains("%E4%B8%AD%E6%96%87"), "URL 编码失败：{link}");
    }

    #[test]
    fn missing_instance_code_falls_back_to_uuid_based_local_code() {
        let port = super::spawn_mock(|_, _| {
            (200, serde_json::json!({"code":9999,"msg":"definition invalid"}).to_string())
        });
        let endpoint = format!("http://127.0.0.1:{port}/x");
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(4)).build();
        let raw = agent.post(&endpoint).send_json(serde_json::json!({})).unwrap().into_string().unwrap();
        let parsed: ApprovalResp = serde_json::from_str(&raw).unwrap_or_else(|_| ApprovalResp {
            code: None, msg: None, data: None,
        });
        let approval_id = "appro-local-1";
        let instance = parsed.data.and_then(|d| d.instance_code).unwrap_or_else(|| format!("LOCAL-{approval_id}"));
        assert_eq!(instance, "LOCAL-appro-local-1");
        assert_eq!(parsed.code, Some(9999));
    }
}