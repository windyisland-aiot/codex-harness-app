"""生成《未来开发计划》Word 文档。"""
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn

doc = Document()

# 全局中文字体
style = doc.styles["Normal"]
style.font.name = "Calibri"
style.font.size = Pt(10.5)
style.element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")


def set_zh(run, name="微软雅黑", size=None, bold=None, color=None):
    run.font.name = "Calibri"
    run._element.rPr.rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def h1(text):
    p = doc.add_paragraph()
    r = p.add_run(text)
    set_zh(r, size=16, bold=True, color=RGBColor(0x1F, 0x1F, 0x1F))
    p.space_before = Pt(12)
    return p


def h2(text):
    p = doc.add_paragraph()
    r = p.add_run(text)
    set_zh(r, size=13, bold=True, color=RGBColor(0x2E, 0x2E, 0x2E))
    return p


def h3(text):
    p = doc.add_paragraph()
    r = p.add_run(text)
    set_zh(r, size=11.5, bold=True, color=RGBColor(0x44, 0x44, 0x44))
    return p


def body(text, bullet=False):
    p = doc.add_paragraph(style="List Bullet" if bullet else "Normal")
    r = p.add_run(text)
    set_zh(r, size=10.5)
    return p


def kv(label, text):
    p = doc.add_paragraph()
    r1 = p.add_run(label)
    set_zh(r1, size=10.5, bold=True)
    r2 = p.add_run(text)
    set_zh(r2, size=10.5)
    return p


# ---------- 封面标题 ----------
title = doc.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = title.add_run("未来开发计划")
set_zh(r, size=22, bold=True)
sub = doc.add_paragraph()
sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = sub.add_run("Harness 云端服务 · 功能演进路线（v1.0 草案）")
set_zh(r, size=11, color=RGBColor(0x66, 0x66, 0x66))

meta = doc.add_paragraph()
meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = meta.add_run("版本：v1.0　|　状态：评审中　|　日期：2026-08-31")
set_zh(r, size=9.5, color=RGBColor(0x88, 0x88, 0x88))
doc.add_paragraph()

# ---------- 引言 ----------
h1("一、文档目的")
body("本计划在云端 harness-service（bibike 改造）+ 本地桌面瘦壳的迁移基础上，明确下一阶段四项核心能力的建设目标、技术路径、里程碑与验收标准，供团队评审排期。")

# ---------- 总览表 ----------
h1("二、四项功能总览")
table = doc.add_table(rows=1, cols=4)
table.style = "Light Grid Accent 1"
hdr = table.rows[0].cells
for i, t in enumerate(["序号", "功能", "一句话目标", "优先级"]):
    hdr[i].paragraphs[0].add_run(t).font.bold = True
    set_zh(hdr[i].paragraphs[0].runs[0], size=10)

rows = [
    ("1", "广告脚本生成 → Skill", "打通生成全链路并封装为可复用的 talk-script Skill", "P0"),
    ("2", "飞书多维表格常态化接入", "脚本/用词/审批等数据实时写入、分析与流转", "P0"),
    ("3", "影刀 API · Webhook 任务执行", "后台添加任务，个人经 URL Webhook 触发专属非固定任务", "P1"),
    ("4", "视频转文字 · 反哺脚本生成", "转录 + 结构分析，注入 Skill 检索提升生成质量", "P1"),
]
for row in rows:
    cells = table.add_row().cells
    for i, val in enumerate(row):
        cells[i].paragraphs[0].add_run(val)
        set_zh(cells[i].paragraphs[0].runs[0], size=9.5)

doc.add_paragraph()

# ---------- 功能1 ----------
h1("三、功能一：打通广告脚本生成功能，封装为 Skill")
h2("3.1 目标")
kv("目标：", "在本地/云端跑通「需求采集 → 知识库检索 → 脚本生成 → 逻辑润色 → 风险守卫」完整链路，并把 bibike 的 Python Agent 提示词固化封装为 `talk-script` Skill，由 codex 执行引擎统一调用。")
h2("3.2 现状")
body("已有的 bibike Agent（BriefIntake / KnowledgeRetriever / 生成润色 / 风险审查 / 事实守卫）已完成提示词重写，产出 `talk-script/SKILL.md`；`/retrieve` 检索桥已设计。", bullet=True)
body("尚未打通端到端：云端 codex 引擎、skill 下发同步、本地瘦壳改调云端。", bullet=True)
h2("3.3 技术路径")
body("A 阶段：落地 `/retrieve` 检索桥 + admin 看板后端（LLM/用户/插件/知识库）。", bullet=True)
body("B 阶段：云端部署 codex app-server，`/plugins/sync` 下发 skill；本地瘦壳改走云 HTTP/SSE。", bullet=True)
body("C 阶段：本地退役 codex，完全云端执行；skill 依据 brief 动态调用 `/retrieve` 取六模块+金句库参考。", bullet=True)
h2("3.4 验收标准")
body("对话输入需求 → 自动追问（≤5 轮）→ 检索 → 生成 → 返回口播稿 + 创作说明 + 风险提醒；", bullet=True)
body("非法功效/价格/极限词等命中守卫并进入风险提醒，不阻断交付。", bullet=True)

# ---------- 功能2 ----------
h1("四、功能二：常态接入飞书多维表格，支持数据实时写入、分析与流转")
h2("4.1 目标")
kv("目标：", "把脚本、用词记录、审批状态、周报等数据实时写入飞书多维表格（Base/Bitable），支持自动分析统计与跨表流转，形成可看板的运营台账。")
h2("4.2 现状")
body("已有 lark Base MCP 与 `BaseInsert` 工作流原型；Deprecated ad_script 5 步含飞书写表。", bullet=True)
body("缺：常态化的双向数据流、审批状态回写、跨表统计与流转规则。", bullet=True)
h2("4.3 技术路径")
body("设计多维表格 schema（脚本表、用词记录表、审批表、周报表），字段对齐 Skill 输出的结构化字段。", bullet=True)
body("生成完成/审批提交通过标准化写入接口提交到 Base；状态变更经事件订阅/回调回写。", bullet=True)
body("利用 Base 视图与仪表盘实现用量、通过率、风险命中率的自动分析。", bullet=True)
h2("4.4 验收标准")
body("一条脚本生成后自动落入 Base 对应记录，审批通过后状态自动流转；", bullet=True)
body("仪表盘可按时间/人员/风格统计生成量与风险命中。", bullet=True)

# ---------- 功能3 ----------
h1("五、功能三：接入影刀 API，Webhook 调用个人专属非固定任务")
h2("5.1 目标")
kv("目标：", "通过向指定 URL 发送 Webhook 请求，触发「个人专属」的影刀 RPA 非固定任务；任务由云端后台动态添加，无需改代码即可扩展。")
h2("5.2 现状")
body("影刀 RPA 提供 HTTP API/Webhook 触发能力；当前未接入。", bullet=True)
body("「个人专属 + 非固定」意味着任务参数、属主、授权均需后台化管理，而非硬编码固定流程。", bullet=True)
h2("5.3 技术路径")
body("后台新增「任务注册表」（任务ID / 属主 / 参数模板 / 影刀 Webhook URL / 触发权限）。", bullet=True)
body("管理端录入任务并生成专属调用 URL（含签名/鉴权），个人/系统向 URL 发送 Webhook 即触发。", bullet=True)
body("执行结果经影刀回调或轮询回传，写入飞书表格/看板，形成闭环。", bullet=True)
h2("5.4 验收标准")
body("后台可无代码新增一条个人任务；向专属 URL 发 Webhook 即触发影刀执行；", bullet=True)
body("执行状态与结果可回查、可流转到飞书多维表格。", bullet=True)

# ---------- 功能4 ----------
h1("六、功能四：视频转文字 + 结构分析，反哺脚本生成 Skill")
h2("6.1 目标")
kv("目标：", "把参考视频转为文字稿，分析其脚本结构与节奏，作为高质量参考注入 `talk-script` 检索/生成环节，持续提升口播生成质量。")
h2("6.2 现状")
body("仓库已有视频生成模块（规划停用）与 harness-rag 的 embedding/分块能力；无转录与结构分析。", bullet=True)
h2("6.3 技术路径")
body("搭建转录管线：上传视频 → 音频抽取/转码 → ASR（Whisper / 云服务）→ 带时间戳文字稿。", bullet=True)
body("结构分析：按 talk-script 六模块（痛点钩子/购买理由/信任背书/品牌资产/促销话术）对文字稿分段标注，提取语气/节奏/金句特征。", bullet=True)
body("注入方式：分析结果入知识库或作为实时参考传给 `/retrieve`/生成 Skill，供借鉴表达与结构。", bullet=True)
h2("6.4 验收标准")
body("视频可一键转出结构化文字稿并完成模块标注；", bullet=True)
body("抽取的高质量脚本片段可被 Skill 检索命中，生成脚本结构/节奏较上线前有可度量提升（如风险命中下降、参考命中率上升）。", bullet=True)

# ---------- 优先 & 里程碑 ----------
h1("七、优先级与里程碑建议")
table2 = doc.add_table(rows=1, cols=3)
table2.style = "Light Grid Accent 1"
hdr2 = table2.rows[0].cells
for i, t in enumerate(["阶段", "内容", "涉及功能"]):
    hdr2[i].paragraphs[0].add_run(t).font.bold = True
    set_zh(hdr2[i].paragraphs[0].runs[0], size=10)
plan = [
    ("阶段一", "打通广告脚本 Skill 端到端 + 飞书多维表格写入初版", "功能1、功能2"),
    ("阶段二", "影刀 Webhook 任务平台上线，后台任务注册与触发", "功能3"),
    ("阶段三", "视频转文字与结构分析接入，反哺 Skill 检索", "功能4"),
    ("持续", "飞书表格双向流转、分析仪表盘、月度评审迭代", "功能2"),
]
for row in plan:
    cells = table2.add_row().cells
    for i, val in enumerate(row):
        cells[i].paragraphs[0].add_run(val)
        set_zh(cells[i].paragraphs[0].runs[0], size=9.5)

doc.add_paragraph()

# ---------- 依赖与风险 ----------
h1("八、依赖与风险")
body("功能1 是功能2/4 的基础：skill 结构化输出字段需先行冻结，飞书 schema 与转录注入才能对齐。", bullet=True)
body("功能3 依赖影刀侧 API/Webhook 回调能力与鉴权方式，需提前与其对接确认。", bullet=True)
body("功能4 的算力与成本：ASR 选型、并发、有效期内的迁移（视频模块停用与否）需评估。", bullet=True)
body("全部功能延续云端看板鉴权体系：Admin 走会话 cookie，skill/任务接口走 API-key/Bearer 两路隔离。", bullet=True)

doc.add_paragraph()
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("— 本计划为草案，评审后按里程碑排期 —")
set_zh(r, size=9, color=RGBColor(0x99, 0x99, 0x99))

OUT = "/workspace/未来开发计划.docx"
doc.save(OUT)
print("saved:", OUT)