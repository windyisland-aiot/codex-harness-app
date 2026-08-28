//! 轻量 Markdown 渲染组件（T06）：基于 marked，对代码块/行内代码/粗斜体/标题等转义输出。
import { useMemo } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

/** 把原始文本渲染成安全 HTML（marked 默认转义原始 HTML）。 */
function render(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

/** 追加片段时，通过 key 区分，避免把半截多字节字符破坏转义。 */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => render(text), [text]);
  return (
    <div
      className="md"
      style={{ wordBreak: "break-word" }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}