//! T11 端到端路由测试：直接用生产内置目录，验证真实指令的路由决策。
//! 覆盖：任务类型自动识别 / 成本上限 / 上下文窗口 / 敏感路由 / 候选为空回退。

use harness_router::{resolve, default_catalog, RouteRequest, TaskType};

fn req(prompt: &str) -> RouteRequest {
    RouteRequest {
        prompt: prompt.into(),
        task_type: None,
        estimated_context_tokens: 10_000,
        sensitive: false,
        max_cost: None,
    }
}

#[test]
fn e2e_review_goes_to_reasoner() {
    // 代码审查命中 deepseek-reasoner（CodeReview 且 cheapest for review）
    let d = resolve(&default_catalog(), &req("帮我 review 这段代码"));
    // deepseek-reasoner(0.014) 是 CodeReview 任务中最便宜的
    assert_eq!(d.provider, "deepseek");
    assert_eq!(d.model, "deepseek-reasoner");
    assert!(d.reason.contains("CodeReview"));
}

#[test]
fn e2e_coding_goes_to_gpt41() {
    let d = resolve(&default_catalog(), &req("请实现用户登录接口并修复一个 bug"));
    assert_eq!(d.provider, "openai");
    assert_eq!(d.model, "gpt-4.1");
}

#[test]
fn e2e_chat_costs_low() {
    // 闲聊（Chat）命中 gpt-4.1-mini 还是 deepseek-chat？Catalog 中 Chat: gpt-4.1-mini(0.10)/deepseek-chat(0.002)
    // 同等任务匹配下按 cost 升序 → deepseek-chat 最便宜且窗口够。
    let d = resolve(&default_catalog(), &req("你好，介绍一下你自己"));
    assert_eq!(d.model, "deepseek-chat");
}

#[test]
fn e2e_max_cost_excludes_expensive() {
    // 编码任务但成本上限极低：排除编码适配的昂贵模型 → 回退成本路由最便宜
    let mut r = req("请重构这个模块");
    r.max_cost = Some(0.003); // 仅 deepseek-chat(0.002) 与 reasoner(0.014)? 排除 reasoner
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.model, "deepseek-chat");
    assert!(d.reason.contains("成本") || d.reason.contains("回退"));
}

#[test]
fn e2e_large_context_uses_max_window() {
    // 超长上下文的文档任务：上下文都足够则按任务+成本，deepseek-chat 优先；
    // 这里把预估设到 150k，超过 deepseek/glm 窗口 → 只有 openai gpt-4.1/gpt-4.1-mini 够，
    // 任务匹配（General 含: gpt-4.1, gpt-4.1-mini）→ 两者都够且不是 Documentation，按 cost 取 gpt-4.1-mini(0.10)。
    let mut r = req("整理这份超长报告");
    r.task_type = Some(TaskType::General);
    r.estimated_context_tokens = 150_000;
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.provider, "openai");
    assert!(d.model == "gpt-4.1" || d.model == "gpt-4.1-mini");
}

#[test]
fn e2e_sensitive_forces_sensitive_model() {
    let mut r = req("分析财务报表的机密数据");
    r.sensitive = true;
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.provider, "deepseek");
    assert_eq!(d.model, "deepseek-reasoner");
    assert!(d.reason.contains("敏感"));
}

#[test]
fn e2e_explicit_task_type_overrides_detect() {
    let mut r = req("今天天气如何");
    r.task_type = Some(TaskType::CodeReview); // 显式覆盖识别出的 Chat
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.model, "deepseek-reasoner");
}

#[test]
fn e2e_empty_catalog_returns_empty_decision() {
    let empty = harness_router::RouteCatalog { models: vec![], sensitive_default: None };
    let d = resolve(&empty, &req("hello"));
    assert_eq!(d.provider, "");
    assert_eq!(d.model, "");
    assert!(d.reason.contains("候选为空"));
}