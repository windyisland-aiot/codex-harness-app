//! T11 路由决策命令行示例：把一行指令路由到模型，输出 JSON。
//! 用法：cargo run -p harness-router --example router_cli -- "<prompt>" [--sensitive] [--max-cost 0.01] [--ctx 100000] [--task coding]
//! 供脚本/黑盒 e2e 复用（输出为 json lines）。

use harness_router::{resolve, default_catalog, RouteRequest, TaskType};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(prompt) = args.next() else {
        eprintln!("usage: router_cli <prompt> [--sensitive] [--max-cost X] [--ctx N] [--task T]");
        std::process::exit(2);
    };
    let mut sensitive = false;
    let mut max_cost: Option<f64> = None;
    let mut ctx: u64 = 10_000;
    let mut task: Option<TaskType> = None;

    let mut it = args;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--sensitive" => sensitive = true,
            "--max-cost" => max_cost = it.next().and_then(|v| v.parse().ok()),
            "--ctx" => ctx = it.next().and_then(|v| v.parse().ok()).unwrap_or(10_000),
            "--task" => {
                task = it.next().and_then(|v| match v.as_str() {
                    "coding" => Some(TaskType::Coding),
                    "documentation" => Some(TaskType::Documentation),
                    "chat" => Some(TaskType::Chat),
                    "dataAnalysis" | "data" => Some(TaskType::DataAnalysis),
                    "codeReview" | "review" => Some(TaskType::CodeReview),
                    _ => Some(TaskType::General),
                });
            }
            _ => {}
        }
    }

    let req = RouteRequest {
        prompt,
        task_type: task,
        estimated_context_tokens: ctx,
        sensitive,
        max_cost,
    };
    let d = resolve(&default_catalog(), &req);
    let out = serde_json::json!({
        "provider": d.provider,
        "model": d.model,
        "reason": d.reason,
    });
    println!("{out}");
}