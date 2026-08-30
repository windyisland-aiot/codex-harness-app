//! T18 · RAG CLI 冒烟（list → get_or_create → add → search → delete）。
//!
//! 用法（chroma 已起在 18763 时）：
//!   cargo run --example rag_cli -- \
//!       --base-url http://127.0.0.1:18763 \
//!       --collection harness_default \
//!       --index "苹果营销脚本：主打夏季清凉，BGM 夏日微风，镜头海边少女吃苹果" \
//!       --index "Nike 运动脚本：晨跑镜头 + Just Do It slogan + 品牌音效" \
//!       --search "夏日 海边" \
//!       --n 3

use clap::Parser;
use harness_rag::{RagClient, RagDocument, DEFAULT_BASE_URL, DEFAULT_COLLECTION};
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, default_value = DEFAULT_BASE_URL)]
    base_url: String,
    #[arg(long, default_value = DEFAULT_COLLECTION)]
    collection: String,
    #[arg(long, num_args = 0..)]
    index: Vec<String>,
    #[arg(long)]
    search: Option<String>,
    #[arg(long, default_value_t = 5)]
    n: usize,
}

fn main() {
    let a = Args::parse();
    let client = RagClient::with_timeout(&a.base_url, Duration::from_secs(30));

    println!(">> health ...");
    client.health().expect("chroma 没起？");
    println!("   OK");

    println!(">> list collections ...");
    for c in client.list_collections().unwrap() {
        println!("   - {} ({})", c.name, c.id);
    }

    println!(">> get_or_create collection = {:?}", a.collection);
    let coll = client.get_or_create_collection(&a.collection).unwrap();
    println!("   id = {}", coll.id);

    if !a.index.is_empty() {
        println!(">> add {} documents ...", a.index.len());
        let docs: Vec<RagDocument> = a
            .index
            .iter()
            .enumerate()
            .map(|(i, t)| RagDocument {
                id: format!("demo-{}-{}", std::process::id(), i),
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

    if let Some(q) = a.search.as_deref() {
        println!(">> search top {}: {:?}", a.n, q);
        let r = client.search(&coll.id, q, a.n, None).unwrap();
        println!("   hits ({}) :", r.hits.len());
        for (i, h) in r.hits.iter().enumerate() {
            let dist = h.distance.map(|d| format!("d={d:.4}")).unwrap_or_default();
            println!(
                "   {}. [{}] {} {}  {:.40}",
                i + 1,
                h.id,
                dist,
                if !h.metadata.is_empty() { "metas ✓" } else { "" },
                h.document
            );
        }
    }
    println!("done.");
}
