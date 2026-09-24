//! 轻量 Markdown 渲染组件（T06 + T29 增强）：
//! - 基于 marked，gfm=true, breaks=true
//! - 代码块 header+复制按钮（渲染后 DOM 挂载式注入）
//! - 表格样式、blockquote 竖线样式、列表缩进、图片 max-width
import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import { hydrateMedia } from "../media";
// DOMPurify：ESM 风格导入 + 运行时 fallback。
// tsc 构建阶段即便未安装 @types/dompurify，只要有 dompurify 包即可用 any 方式。
import DOMPurify from "dompurify";
let purify: ((s: string) => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const sanitize = (DOMPurify as any)?.sanitize;
  if (typeof sanitize === "function") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    purify = (s) => sanitize(s) as string;
  }
} catch {
  purify = null;
}

marked.setOptions({ gfm: true, breaks: true });

/** 把原始文本渲染成安全 HTML（marked 默认转义原始 HTML + DOMPurify 兜底）。 */
function render(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return purify ? purify(raw) : raw;
}

/** 从 <code class="language-xxx"> 里提取语言名；无则空串。 */
function extractLang(codeEl: Element): string {
  const cls = codeEl.getAttribute("class") || "";
  const m = /language-([\w+-]+)/i.exec(cls);
  if (m) return m[1];
  return "";
}

/** 追加片段时，通过 key 区分，避免把半截多字节字符破坏转义。 */
export default function Markdown({ text, cwd }: { text: string; cwd?: string }) {
  const html = useMemo(() => render(text), [text]);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const pres = wrap.querySelectorAll<HTMLPreElement>("pre");
    pres.forEach((pre) => {
      // 避免重复注入
      if (pre.dataset.cbInjected === "1") return;
      pre.dataset.cbInjected = "1";
      const codeEl = pre.querySelector("code");
      const lang = codeEl ? extractLang(codeEl) : "";
      pre.style.position = "relative";

      const header = document.createElement("div");
      header.className = "cb-header";
      header.style.cssText =
        "display:flex;align-items:center;justify-content:space-between;padding:6px 12px 2px;" +
        "font-size:11.5px;color:#9CA3AF;font-family:var(--mono,ui-monospace,monospace);" +
        "user-select:none;";

      const langTag = document.createElement("span");
      langTag.textContent = lang || "code";
      langTag.style.cssText = "letter-spacing:.3px;opacity:.85;";

      const copyBtn = document.createElement("button");
      copyBtn.className = "cb-copy";
      copyBtn.type = "button";
      copyBtn.textContent = "复制";
      copyBtn.style.cssText =
        "background:#1F2937;color:#fff;border:none;border-radius:6px;padding:3px 10px;" +
        "font-size:11.5px;cursor:pointer;font-weight:500;transition:all .12s;" +
        "font-family:inherit;line-height:1.5;";
      copyBtn.addEventListener("mouseenter", () => {
        copyBtn.style.background = "#374151";
      });
      copyBtn.addEventListener("mouseleave", () => {
        if (copyBtn.dataset.copied !== "1") copyBtn.style.background = "#1F2937";
      });
      copyBtn.addEventListener("click", async () => {
        const codeText = codeEl ? codeEl.innerText : pre.innerText;
        try {
          await navigator.clipboard.writeText(codeText);
          copyBtn.textContent = "已复制";
          copyBtn.style.background = "#059669";
          copyBtn.dataset.copied = "1";
          setTimeout(() => {
            copyBtn.textContent = "复制";
            copyBtn.style.background = "#1F2937";
            delete copyBtn.dataset.copied;
          }, 1800);
        } catch {
          copyBtn.textContent = "复制失败";
          copyBtn.style.background = "#B91C1C";
          setTimeout(() => {
            copyBtn.textContent = "复制";
            copyBtn.style.background = "#1F2937";
          }, 1500);
        }
      });

      header.appendChild(langTag);
      header.appendChild(copyBtn);

      // 把 header 作为 pre 的第一个子节点插入
      if (pre.firstChild) {
        pre.insertBefore(header, pre.firstChild);
      } else {
        pre.appendChild(header);
      }
    });
  }, [html]);

  // v0.8.5：把消息里指向本地文件的图片/视频/音频渲染成可直接查看的卡片。
  // 先探测文件是否存在，再替换（路径写错时保持原文，不会出现坏图）。
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // 去抖：流式输出时 html 频繁变化，等这一波稳定下来再探测文件是否存在。
    const timer = window.setTimeout(() => void hydrateMedia(wrap, cwd), 250);
    return () => window.clearTimeout(timer);
  }, [html, cwd]);

  return (
    <div className="md-wrap" ref={wrapRef}>
      <div
        className="md"
        style={{ wordBreak: "break-word" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
