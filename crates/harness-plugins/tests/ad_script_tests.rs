//! T21 · AdScriptWorkflow 纯数据工作流单元测试。

use harness_plugins::ad_script::{AdScriptWorkflow, Step, StepTool};

#[test]
fn non_empty_brief_produces_exactly_5_steps() {
    let steps = AdScriptWorkflow::run("请写一条抖音夏季防晒霜广告。");
    assert_eq!(steps.len(), 5);
}

#[test]
fn tool_order_is_rag_then_llm_x2_then_base_then_approval() {
    let steps = AdScriptWorkflow::run("brief");
    assert_eq!(steps[0].tool, StepTool::RagSearch);
    assert_eq!(steps[1].tool, StepTool::LlmGenerate);
    assert_eq!(steps[2].tool, StepTool::LlmGenerate);
    assert_eq!(steps[3].tool, StepTool::BaseInsert);
    assert_eq!(steps[4].tool, StepTool::FeishuApprovalSubmit);
    // ids 单调递增
    for w in steps.windows(2) {
        assert_eq!(w[1].id, w[0].id + 1);
    }
}

#[test]
fn empty_brief_still_produces_5_steps_with_original_brief_in_payload() {
    let steps = AdScriptWorkflow::run("");
    assert_eq!(steps.len(), 5);
    for s in &steps {
        let original = s.payload.get("originalBrief");
        // payload 里能取到 originalBrief，并且是字符串
        assert!(matches!(original, Some(serde_json::Value::String(_))), "step {} 缺 originalBrief: {:?}", s.id, s.payload);
    }
}

#[test]
fn brand_keyword_in_brief_is_included_in_ragsearch_query() {
    let steps = AdScriptWorkflow::run("做一条快手短视频广告，推广安踏夏季运动套装。");
    let s1 = &steps[0];
    assert_eq!(s1.tool, StepTool::RagSearch);
    let query = s1
        .payload
        .get("query")
        .and_then(|v: &serde_json::Value| v.as_str())
        .expect("RagSearch payload.query 应为字符串");
    // 提取出的品牌关键词「快手」「安踏」二者至少有一个出现在 query 中
    let has_ks = query.contains("快手");
    let has_anta = query.contains("安踏");
    assert!(has_ks || has_anta, "query='{query}' 未命中任何品牌关键词（快手/安踏）");
}
