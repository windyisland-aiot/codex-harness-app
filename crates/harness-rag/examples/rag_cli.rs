//! T18+T20 · RAG CLI 冒烟：
//!   list → get_or_create → [ingest <file.md>] → add → search → delete
//!
//! 用法（Chroma 起在 18763 时）：
//!   # 直接指定文档
//!   cargo run --example rag_cli -- \
//!       --base-url http://127.0.0.1:18763 \
//!       --collection harness_default \
//!       --index "苹果营销脚本：主打夏季清凉..." \
//!       --search "夏日 海边" --n 3
//!
//!   # 读一个 Markdown 文件（按 chunk=800, overlap=120 切片后入库）
//!   cargo run --example rag_cli -- \
//!       --collection ads_scripts \
//!       ingest ./docs/brand.md \
//!       --chunk 800 --overlap 120 --model default

use clap::{Parser, Subcommand};
use harness_rag::{chunk_markdown, RagClient, RagDocument, DEFAULT_BASE_URL, DEFAULT_COLLECTION};
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, default_value = DEFAULT_BASE_URL, global = true)]
    base_url: String,
    #[arg(long, default_value = DEFAULT_COLLECTION, global = true)]
    collection: String,
    #[arg(long, num_args = 0.., global = true)]
    index: Vec<String>,
    #[arg(long, global = true)]
    search: Option<String>,
    #[arg(long, default_value_t = 5, global = true)]
    n: usize,

    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// 读取文件后切片入库（服务端自动嵌入）
    Ingest {
        /// 目标文件（Markdown / 纯文本）
        file: String,
        /// 单段字符数
        #[arg(long, default_value_t = 800)]
        chunk: usize,
        /// 相邻段重叠字符数
        #[arg(long, default_value_t = 120)]
        overlap: usize,
        /// Chroma embedding 模型名（默认 default）
        #[arg(long, default_value = "default")]
        model: String,
    },
}

fn main() {
    let a = Args::parse();
    let client = RagClient::with_timeout(&a.base_url, Duration::from_secs(60));

    println!(">> health ...");
    client.health().expect("chroma 没起？先跑：chroma run --host 127.0.0.1 --port 18763");
    println!("   OK");

    println!(">> list collections ...");
    for c in client.list_collections().unwrap() {
        println!("   - {} ({})", c.name, c.id);
    }

    println!(">> get_or_create collection = {:?}", a.collection);
    let coll = client.get_or_create_collection(&a.collection).unwrap();
    println!("   id = {}", coll.id);

    // 1) Ingest 子命令
    if let Some(Cmd::Ingest { file, chunk, overlap, model: _model }) = &a.cmd {
        println!(">> ingest file={file} (chunk={chunk}, overlap={overlap})");
        let src = std::fs::read_to_string(file)
            .unwrap_or_else(|e| panic!("读 {file} 失败: {e}"));
        let chunks = chunk_markdown(&src, *chunk, *overlap);
        println!("   chunks = {}", chunks.len());
        let pid = std::process::id();
        let docs: Vec<RagDocument> = chunks
            .into_iter()
            .enumerate()
            .map(|(i, text)| RagDocument {
                id: format!("ingest-{pid}-{i}"),
                text,
                metadata: {
                    let mut m = BTreeMap::new();
                    m.insert("source".into(), serde_json::Value::String(file.clone()));
                    m.insert("chunk_index".into(), serde_json::Value::from(i as i64));
                    m.insert("chunk_size".into(), serde_json::Value::from(*chunk as i64));
                    m
                },
            })
            .collect();
        if !docs.is_empty() {
            let ids = client.add_documents(&coll.id, &docs).unwrap();
            println!("   written ids={ids:?}");
        }
    }

    // 2) 直接 --index 指定的文档
    if !a.index.is_empty() {
        println!(">> add {} documents ...", a.index.len());
        let pid = std::process::id();
        let docs: Vec<RagDocument> = a
            .index
            .iter()
            .enumerate()
            .map(|(i, t)| RagDocument {
                id: format!("cli-{pid}-{i}"),
                text: t.clone(),
                metadata: {
                    let mut m = BTreeMap::new();
                    m.insert("source".into(), serde_json::Value::String("rag_cli".into()));
                    m.insert("seq".into(), serde_json::Value::from(i as i64));
                    m
                },
            })
            .collect();
        let ids = client.add_documents(&coll.id, &docs).unwrap();
        println!("   ids = {ids:?}");
    }

    // 3) 搜索
    if let Some(q) = a.search.as_deref() {
        println!(">> search top {}: {:?}", a.n, q);
        let r = client.search(&coll.id, q, a.n, None).unwrap();
        println!("   hits ({}) :", r.hits.len());
        for (i, h) in r.hits.iter().enumerate() {
            let dist = h.distance.map(|d| format!("d={d:.4}")).unwrap_or_default();
            let snippet: String = h.document.chars().take(80).collect();
            println!(
                "   {}. [{}] {} {}  {snippet}",
                i + 1,
                h.id,
                dist,
                if !h.metadata.is_empty() { "metas ✓" } else { "" },
            );
        }
    }
    println!("done.");
}
