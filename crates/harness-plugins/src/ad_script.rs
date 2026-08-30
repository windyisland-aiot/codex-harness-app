//! T21 · 广告脚本生成 5 步工作流（纯数据结构，不做网络 IO）。
//!
//! 工作流结构：
//! 1. `RagSearch`  —— 检索「品牌话术 + 竞品分析 + 历史脚本案例」，query 会从 brief 中抽取常见品牌名。
//! 2. `LlmGenerate` —— 产出 3 条脚本草案。
//! 3. `LlmGenerate` —— 从草案中选 1 条做精修（含镜头/旁白/字幕/时长）。
//! 4. `BaseInsert`   —— 将最终脚本写入飞书多维表格「广告脚本表」，回传 brief+title+script。
//! 5. `FeishuApprovalSubmit` —— 发起飞书审批单（脚本审批），approver 由调用方注入。

use serde_json::{json, Value};

/// 每一步需要的 MCP/LLM 工具。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StepTool {
    RagSearch,
    LlmGenerate,
    BaseInsert,
    FeishuApprovalSubmit,
}

/// 一个步骤。
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    /// 1-based id（工作流中的顺序编号）。
    pub id: usize,
    /// 中文可读步骤名。
    pub name: &'static str,
    /// 调用的工具。
    pub tool: StepTool,
    /// JSON payload：工具调用的参数 / 提示片段。**全部为纯数据**，
    /// 调用方把它拼进 Codex 的 prompt 或 MCP tool-params 里。
    pub payload: Value,
}

pub struct AdScriptWorkflow;

impl AdScriptWorkflow {
    /// 给定 brief（原始需求文本），返回有序 5 步。
    ///
    /// - brief 空串：仍返回 5 步，每步 payload 中的 `originalBrief` 是空串。
    /// - Step1 `RagSearch` 的 `query` 会尝试从 brief 中识别一些中文常见品牌词，
    ///   命中时追加到 query，保证下游检索聚焦。
    pub fn run(brief: &str) -> Vec<Step> {
        let brief = brief.to_string();

        // ---- Step1: RAG 检索 ----
        let brand_tokens = extract_brand_tokens(&brief);
        let mut query_parts = vec![
            "品牌话术".to_string(),
            "竞品分析".to_string(),
            "历史脚本案例".to_string(),
        ];
        query_parts.extend(brand_tokens.clone());
        let query = query_parts.join(" ");

        let step1 = Step {
            id: 1,
            name: "检索知识库：品牌话术 + 竞品 + 历史案例",
            tool: StepTool::RagSearch,
            payload: json!({
                "query": query,
                "topK": 10,
                "brandTokens": brand_tokens,
                "originalBrief": brief,
            }),
        };

        // ---- Step2: 脚本草案 ----
        let step2 = Step {
            id: 2,
            name: "生成 3 条脚本草案",
            tool: StepTool::LlmGenerate,
            payload: json!({
                "stage": "draft",
                "count": 3,
                "mustInclude": ["产品卖点","情绪钩子","CTA"],
                "originalBrief": brief,
            }),
        };

        // ---- Step3: 脚本精修 ----
        let step3 = Step {
            id: 3,
            name: "从草案中选 1 条做精修（镜头/旁白/字幕/时长）",
            tool: StepTool::LlmGenerate,
            payload: json!({
                "stage": "revise",
                "fields": ["title","scene","voice_over","subtitles","duration_seconds","cta"],
                "originalBrief": brief,
            }),
        };

        // ---- Step4: 写回多维表格 ----
        let step4 = Step {
            id: 4,
            name: "写回飞书多维表格「广告脚本表」",
            tool: StepTool::BaseInsert,
            payload: json!({
                "tableName": "广告脚本表",
                "fields": ["brief","title","script","revised_script","status"],
                "statusInitial": "待审批",
                "originalBrief": brief,
            }),
        };

        // ---- Step5: 发起飞书审批 ----
        let step5 = Step {
            id: 5,
            name: "发起飞书审批：广告脚本审批",
            tool: StepTool::FeishuApprovalSubmit,
            payload: json!({
                "approvalName": "广告脚本审批",
                "approvers": [],   // 调用方按组织架构填入 open_ids
                "cc": [],
                "originalBrief": brief,
            }),
        };

        vec![step1, step2, step3, step4, step5]
    }
}

/// 从 brief 中抽取一些品牌关键词（启发式）。
///
/// 只做最小集合：几个国内主流平台 + 运动/快消品牌词。
/// 不保证完整；测试只断言：给定 brief 含 快手/安踏 时 query 中至少命中一个。
fn extract_brand_tokens(brief: &str) -> Vec<String> {
    const DICT: &[&str] = &[
        // 内容平台
        "抖音", "快手", "小红书", "视频号", "B站", "微博",
        // 运动品牌
        "安踏", "李宁", "耐克", "Nike", "Adidas", "阿迪达斯", "特步", "361°",
        // 快消
        "农夫山泉", "王老吉", "加多宝", "蒙牛", "伊利", "海飞丝", "舒肤佳",
        // 3C
        "华为", "小米", "苹果", "Apple", "OPPO", "vivo", "荣耀",
    ];
    let mut out = Vec::new();
    for w in DICT {
        if brief.contains(w) {
            out.push(w.to_string());
        }
    }
    out
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn extract_brand_tokens_case_preserves_order() {
        let r = extract_brand_tokens("快手安踏苹果");
        assert_eq!(r, vec!["快手".to_string(), "安踏".to_string(), "苹果".to_string()]);
    }

    #[test]
    fn extract_brand_tokens_empty_brief_returns_empty() {
        assert!(extract_brand_tokens("").is_empty());
    }
}
