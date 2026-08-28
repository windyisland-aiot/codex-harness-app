#!/usr/bin/env python3
"""透明代理：把 codex 发往 mock 的 Responses 请求原样转发到火山方舟 Ark，
再把 Ark 的 SSE 流原样回传，同时在途中打印请求摘要与响应事件类型，
用于定位 codex 客户端 <-> Ark responses 协议不兼容点。"""
import json, os, sys, uuid, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request, urllib.error

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
ARK = "https://ark.cn-beijing.volces.com/api/coding/v3/responses"
ARK_KEY = "ark-9219d6e8-6264-437e-aeab-95fdb650a043-2c85b"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        print(f"[proxy] POST {self.path} model={body.get('model')} "
              f"n_input={len(body.get('input') or [])} stream={body.get('stream')}", flush=True)
        print(f"[proxy] input_types={[i.get('type') if isinstance(i,dict) else type(i).__name__ for i in (body.get('input') or [])]}", flush=True)
        # 打印请求体（截断），方便核对 Ark 是否因字段报错
        seg = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        print(f"[proxy] body={seg[:1200]}", flush=True)

        payload = seg.encode()
        req = urllib.request.Request(ARK, data=payload, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {ARK_KEY}")
        try:
            resp = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode(errors="replace")
            print(f"[proxy] >>> ARK HTTP {e.code}: {err_body[:400]}", flush=True)
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(err_body.encode())
            return
        except Exception as e:
            print(f"[proxy] >>> ARK error: {e}", flush=True)
            self.send_response(502)
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return

        print(f"[proxy] >>> ARK {resp.status} {resp.headers.get('Content-Type')}", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        # 流式转发，打印事件 type；response.completed 打印完整载荷
        count = 0
        try:
            for raw in resp:
                count += 1
                text = raw.decode(errors="replace")
                # 打印第一块原始 SSE 最前面 6 行（看 event:/data: 格式）
                if count <= 1:
                    print(f"[proxy] RAW SSE chunk (first): {text[:400]!r}", flush=True)
                out_lines = []
                for line in text.splitlines():
                    if line.startswith("data:"):
                        d = line[5:].strip()
                        if d != "[DONE]":
                            try:
                                o = json.loads(d)
                                t = o.get("type")
                                # 过滤 reasoning 相关事件（codex 无法消费 Ark 的 reasoning item）
                                if t in ("response.reasoning_summary_part.added",
                                         "response.reasoning_summary_text.delta",
                                         "response.reasoning_summary_text.done",
                                         "response.reasoning_summary_part.done"):
                                    print(f"[proxy]  << FILTERED {t}", flush=True)
                                    continue
                                if t == "response.output_item.added":
                                    item = o.get("item") or {}
                                    if item.get("type") == "reasoning":
                                        print("[proxy]  << FILTERED output_item.added(reasoning)", flush=True)
                                        continue
                                    if item.get("type") in ("message", "agentMessage") and "content" not in item:
                                        item["content"] = []
                                        o["item"] = item
                                        d = json.dumps(o, separators=(",", ":"))
                                        line = "data:" + d
                                        print("[proxy]  << PATCHED content=[] into output_item.added", flush=True)
                                    print(f"[proxy]  << FULL response.output_item.added: {d[:800]}", flush=True)
                                elif t == "response.output_item.done":
                                    item = o.get("item") or {}
                                    if item.get("type") == "reasoning":
                                        print("[proxy]  << FILTERED output_item.done(reasoning)", flush=True)
                                        continue
                                    print(f"[proxy]  << event type={t}", flush=True)
                                else:
                                    print(f"[proxy]  << event type={t}", flush=True)
                            except Exception:
                                pass
                    out_lines.append(line)
                if out_lines:
                    self.wfile.write(("\n".join(out_lines) + "\n").encode())
                self.wfile.flush()
        except Exception as e:
            print(f"[proxy] stream forward err: {e}", flush=True)
        print(f"[proxy] << forwarded {count} chunks", flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[proxy] transparent proxy on 127.0.0.1:{PORT} -> {ARK}", flush=True)
    server.serve_forever()