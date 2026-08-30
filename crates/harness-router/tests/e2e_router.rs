//! T11 端到端路由测试（v0.2.1 精简版，单 Volcengine Ark 目录）：
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
fn e2e_review_goes_to_ark_code() {
    // 代码审查命中 ark-code-latest（CodeReview 适配 + 编码类模型）
    let d = resolve(&default_catalog(), &req("帮我 review 这段代码"));
    assert_eq!(d.provider, "volcengine-ark");
    assert_eq!(d.model, "ark-code-latest");
    assert!(d.reason.contains("CodeReview"));
}

#[test]
fn e2e_coding_goes_to_ark_code() {
    let d = resolve(&default_catalog(), &req("请实现用户登录接口并修复一个 bug"));
    assert_eq!(d.provider, "volcengine-ark");
    assert_eq!(d.model, "ark-code-latest");
}

#[test]
fn e2e_chat_goes_to_only_alias() {
    // 只有一个合法别名 ark-code-latest，所有任务类型统一走它
    let d = resolve(&default_catalog(), &req("你好，介绍一下你自己"));
    assert_eq!(d.model, "ark-code-latest");
}

#[test]
fn e2e_max_cost_falls_back_to_only() {
    // 只有一个候选，不管成本上限 → 命中它
    let mut r = req("请重构这个模块");
    r.max_cost = Some(0.003);
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.model, "ark-code-latest");
}

#[test]
fn e2e_large_context_uses_max_window() {
    // ark-code-latest 配置了 1M 窗口，150k 直接命中
    let mut r = req("整理这份超长报告");
    r.task_type = Some(TaskType::General);
    r.estimated_context_tokens = 150_000;
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.provider, "volcengine-ark");
    assert_eq!(d.model, "ark-code-latest");
}

#[test]
fn e2e_sensitive_forces_sensitive_model() {
    let mut r = req("分析财务报表的机密数据");
    r.sensitive = true;
    let d = resolve(&default_catalog(), &r);
    assert_eq!(d.provider, "volcengine-ark");
    assert_eq!(d.model, "ark-code-latest");
    assert!(d.reason.contains("敏感"));
}

#[test]
fn e2e_explicit_task_type_overrides_detect() {
    let mut r = req("今天天气如何");
    r.task_type = Some(TaskType::CodeReview); // 显式覆盖识别出的 Chat
    let d = resolve(&default_catalog(), &r);
    // CodeReview 适配的只有 ark-code-latest
    assert_eq!(d.model, "ark-code-latest");
}

#[test]
fn e2e_empty_catalog_returns_empty_decision() {
    let empty = harness_router::RouteCatalog { models: vec![], sensitive_default: None };
    let d = resolve(&empty, &req("hello"));
    assert_eq!(d.provider, "");
    assert_eq!(d.model, "");
    assert!(d.reason.contains("候选为空"));
}
