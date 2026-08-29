//! # harness-router
//!
//! T11：按任务类型 / 上下文长度 / 成本 / 敏感度，把一次请求路由到合适的模型。
//!
//! 模型的最终落地是 [`resolve`] 返回的 `provider` + `model`，由调用方传入
//! `thread/start` 或 `thread/settings/update`（T10），下一个 turn 生效。

use serde::{Deserialize, Serialize};

/// 任务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskType {
    /// 编码 / 实现。
    Coding,
    /// 文档撰写 / 文案。
    Documentation,
    /// 常规对话 / 问答。
    Chat,
    /// 数据分析 / 报表。
    DataAnalysis,
    /// 代码审查。
    CodeReview,
    /// 其余未分类。
    General,
}

impl TaskType {
    /// 用简单关键词把一段用户指令归类（未命中则 `General`）。
    pub fn detect(prompt: &str) -> TaskType {
        let s = prompt.to_lowercase();
        let kw = |a: &[&str]| a.iter().any(|k| s.contains(k));
        if kw(&["review", "审查", "code review", "评审"]) {
            TaskType::CodeReview
        } else if kw(&["data", "analy", "报表", "数据分析", "图表", "统计"]) {
            TaskType::DataAnalysis
        } else if kw(&["write", "文档", "doc", "说明", "readme", "写"] ) && kw(&["doc", "文档", "说明"]) {
            TaskType::Documentation
        } else if kw(&["implement", "实现", "写", "修", "编码", "代码", "bug", "fix", "refactor", "重构", "做成", "生成"]) {
            TaskType::Coding
        } else {
            TaskType::General
        }
    }
}

/// 一次路由请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRequest {
    /// 原始用户指令（用于任务类型自动识别）。
    pub prompt: String,
    /// 显式任务类型（缺省时用 [`TaskType::detect`] 推断）。
    pub task_type: Option<TaskType>,
    /// 预估上下文长度（token），用于过滤上下文窗口不够的模型。
    pub estimated_context_tokens: u64,
    /// 是否敏感请求（如含机密/财务），路由到指定敏感模型。
    pub sensitive: bool,
    /// 成本上限（每 1K 输入 token 的价格）；超出的模型被排除。
    pub max_cost: Option<f64>,
}

/// 路由结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    pub provider: String,
    pub model: String,
    /// 命中规则 / 原因（面向用户展示）。
    pub reason: String,
}

/// 目录中的一个模型（每个 provider 可注册多个）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOption {
    /// 提供商 id（对应 config.toml 的 `[model_providers.<id>]`）。
    pub provider: String,
    /// 模型名。
    pub model: String,
    /// 上下文窗口（token）。
    pub context_window: u64,
    /// 成本（每 1K 输入 token 的美元），越低越便宜。
    pub cost: f64,
    /// 适配的任务类型。
    pub tasks: Vec<TaskType>,
}

/// 路由目录：全部可用模型 + 敏感默认模型（可选）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteCatalog {
    pub models: Vec<ModelOption>,
    /// 敏感请求优先使用的（provider, model）。
    pub sensitive_default: Option<(String, String)>,
}

/// 内置路由目录：当前版本仅启用「火山方舟 Ark」单模型（企业精简版）。
/// codex 自定义 Provider 的 type="Custom"（见 harness-config model_providers）。
/// 成本为每 1K 输入 token 美元，估值用于任务+成本排序（同 Provider 内多模型之间的相对排序）。
pub fn default_catalog() -> RouteCatalog {
    RouteCatalog {
        models: vec![
            ModelOption { provider: "volcengine-ark".into(), model: "ark-code-latest".into(), context_window: 128_000, cost: 0.004, tasks: vec![TaskType::Coding, TaskType::CodeReview, TaskType::DataAnalysis, TaskType::General] },
            ModelOption { provider: "volcengine-ark".into(), model: "ark-contextual-latest".into(), context_window: 1_000_000, cost: 0.010, tasks: vec![TaskType::Documentation, TaskType::General, TaskType::DataAnalysis] },
            ModelOption { provider: "volcengine-ark".into(), model: "ark-chat-latest".into(), context_window: 64_000, cost: 0.002, tasks: vec![TaskType::Chat, TaskType::General, TaskType::Documentation] },
        ],
        sensitive_default: Some(("volcengine-ark".into(), "ark-code-latest".into())),
    }
}

/// 解析一条规则：按 敏感度 -> 任务类型 -> 成本 -> 上下文 依次过滤，返回第一个可用模型。
pub fn resolve(catalog: &RouteCatalog, req: &RouteRequest) -> RouteDecision {
    // 1) 敏感度：命中敏感默认则直接采用。
    if req.sensitive {
        if let Some((prov, model)) = &catalog.sensitive_default {
            return RouteDecision {
                provider: prov.clone(),
                model: model.clone(),
                reason: "敏感度路由：命中敏感默认模型".into(),
            };
        }
    }

    let task = req.task_type.unwrap_or_else(|| TaskType::detect(&req.prompt));

    // 2) 候选：按任务适配打分降序；再从其中过滤成本上限与上下文窗口。
    let mut pool = catalog.models.clone();
    pool.sort_by(|a, b| {
        // 任务匹配度高的优先；否则便宜的优先。
        let a_match = a.tasks.contains(&task);
        let b_match = b.tasks.contains(&task);
        b_match.cmp(&a_match).then(
            a.cost
                .partial_cmp(&b.cost)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    // 成本过滤
    if let Some(max) = req.max_cost {
        pool.retain(|m| m.cost <= max);
    }
    if pool.is_empty() {
        // 成本上限过滤后没有可用模型：回退到全部，选最便宜。
        let mut all = catalog.models.clone();
        all.sort_by(|a, b| a.cost.partial_cmp(&b.cost).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(best) = all.first() {
            return RouteDecision {
                provider: best.provider.clone(),
                model: best.model.clone(),
                reason: format!("成本路由：全部超出上限，回退最便宜 {}/{}", best.provider, best.model),
            };
        }
        return RouteDecision { provider: String::new(), model: String::new(), reason: "候选为空".into() };
    }

    // 3) 满足上下文窗口的模型（窗口 >= 预估）；优先任务匹配 + 便宜者已排序在最前。
    if let Some(hit) = pool.iter().find(|m| m.context_window >= req.estimated_context_tokens) {
        let ctx = hit.context_window;
        let cost = hit.cost;
        return RouteDecision {
            provider: hit.provider.clone(),
            model: hit.model.clone(),
            reason: format!(
                "任务类型 {:?} + 成本${:.4} + 上下文{ctx} 命中 {}/{}",
                task, cost, hit.provider, hit.model
            ),
        };
    }
    // 上下文都不够：选窗口最大的。
    let best = pool
        .iter()
        .max_by_key(|m| m.context_window)
        .cloned()
        .unwrap();
    return RouteDecision {
        provider: best.provider.clone(),
        model: best.model.clone(),
        reason: format!("上下文路由：预估{tokens}，选择最大窗口 {}/{}", best.provider, best.model, tokens = req.estimated_context_tokens),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(prompt: &str) -> RouteRequest {
        RouteRequest { prompt: prompt.into(), task_type: None, estimated_context_tokens: 10_000, sensitive: false, max_cost: None }
    }

    #[test]
    fn routes_by_task_type_coding() {
        let d = resolve(&default_catalog(), &req("请实现一个登录模块"));
        // Coding 任务唯一命中 ark-code-latest（cost 0.004）
        assert_eq!(d.provider, "volcengine-ark");
        assert_eq!(d.model, "ark-code-latest");
        assert!(d.reason.contains("Coding"));
    }

    #[test]
    fn routes_documentation_to_cheap_ark_chat() {
        let d = resolve(&default_catalog(), &req("帮我写一份 README 文档"));
        // Documentation：匹配的有 ark-code-latest / ark-contextual / ark-chat；
        // 按成本升序 → ark-chat-latest(0.002) 最便宜。
        assert_eq!(d.provider, "volcengine-ark");
        assert_eq!(d.model, "ark-chat-latest");
    }

    #[test]
    fn routes_by_cost_ceiling() {
        let mut r = req("随便聊聊今天天气");
        r.max_cost = Some(0.003); // 仅 ark-chat-latest(0.002) 满足
        let d = resolve(&default_catalog(), &r);
        assert_eq!(d.model, "ark-chat-latest");
        assert!(d.reason.contains("成本"));
    }

    #[test]
    fn routes_by_context_length_length_window() {
        let mut r = req("整理这份超长报告");
        r.task_type = Some(TaskType::DataAnalysis);
        r.estimated_context_tokens = 200_000; // ark-code-latest(128k) 不够，回退 1M 窗口 ark-contextual-latest
        let d = resolve(&default_catalog(), &r);
        assert_eq!(d.provider, "volcengine-ark");
        assert_eq!(d.model, "ark-contextual-latest");
    }

    #[test]
    fn routes_by_sensitivity() {
        let mut r = req("处理财务机密数据");
        r.sensitive = true;
        let d = resolve(&default_catalog(), &r);
        assert_eq!(d.provider, "volcengine-ark");
        assert_eq!(d.model, "ark-code-latest");
        assert!(d.reason.contains("敏感"));
    }

    #[test]
    fn detect_classifies_prompt() {
        assert_eq!(TaskType::detect("review this PR please"), TaskType::CodeReview);
        assert_eq!(TaskType::detect("请写一份使用说明文档"), TaskType::Documentation);
        assert_eq!(TaskType::detect("统计这组数据并出图表"), TaskType::DataAnalysis);
        assert_eq!(TaskType::detect("hello there"), TaskType::General);
    }
}