//! T13 飞书 OAuth 面板：凭据校验、授权链接、回调换码、token 刷新。
//! 与 T12 飞书 MCP 注册共用 app_id/app_secret，保持工具凭据体系一致。

import { useState } from "react";
import * as codex from "../codexClient";

export default function FeishuOAuthPanel({
  open,
  onClose,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  onStatus: (s: string) => void;
}) {
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [code, setCode] = useState("");
  const [bundle, setBundle] = useState<codex.TokenBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const params = (): codex.OAuthParams => ({
    appId: appId || undefined,
    appSecret: appSecret || undefined,
    redirectUri: redirectUri || undefined,
    baseUrl: baseUrl || undefined,
  });

  async function checkApp() {
    setBusy(true);
    try {
      const r = await codex.feishuAppToken(params());
      onStatus(`[成功] app_access_token 有效 · 有效期 ${r.expire}s`);
    } catch (e) {
      onStatus(`[失败] 凭据校验失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function buildAuthUrl() {
    const st = Math.random().toString(36).slice(2);
    try {
      const url = await codex.feishuAuthorizeUrl(params(), st);
      setAuthorizeUrl(url);
      onStatus("授权链接已生成，请在浏览器打开并完成授权");
    } catch (e) {
      onStatus(`[失败] 生成授权链接失败: ${e}`);
    }
  }

  async function doExchange() {
    setBusy(true);
    try {
      // 业务上校验回调报文携带的 state 是否一致，防止 CSRF。
      const b = await codex.feishuExchange(params(), code.trim());
      setBundle(b);
      onStatus("[成功] 已换取 user_access_token（授权成功）");
    } catch (e) {
      onStatus(`[失败] 授权码换取失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function doRefresh() {
    if (!bundle?.refreshToken) {
      onStatus("当前无 refresh_token，请先完成授权");
      return;
    }
    setBusy(true);
    try {
      const b = await codex.feishuRefresh(params(), bundle.refreshToken);
      setBundle(b);
      const exp = new Date(b.expTs * 1000).toLocaleString();
      onStatus(`[成功] 已刷新 token · 新过期时间 ${exp}（token 滚动更新）`);
    } catch (e) {
      onStatus(`[失败] 刷新失败: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!bundle) return;
    navigator.clipboard?.writeText(bundle.accessToken).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="cfg-backdrop" onClick={onClose}>
      <div className="cfg-panel feishu-oauth" onClick={(e) => e.stopPropagation()}>
        <div className="cfg-head">
          <h2>飞书 OAuth</h2>
          <button className="cfg-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="cfg-body">
          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>① 应用凭据</h3>
            </div>
            <input
              className="cfg-full"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="app_id（为空则用 FEISHU_APP_ID）"
            />
            <input
              className="cfg-full"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="app_secret（仅运行时使用，不落盘）"
            />
            <input
              className="cfg-full"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="redirect_uri（可选，授权回调地址）"
            />
            <input
              className="cfg-full"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="base_url（可选，默认 https://open.feishu.cn）"
            />
            <div className="cfg-row">
              <button className="cfg-add" onClick={checkApp} disabled={busy}>
                校验并取 app_access_token
              </button>
            </div>
          </section>

          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>② 用户授权</h3>
            </div>
            <button className="cfg-add" onClick={buildAuthUrl} disabled={busy}>
              生成授权链接
            </button>
            {authorizeUrl && (
              <>
                <p className="cfg-hint oauth-url">{authorizeUrl}</p>
                <input
                  className="cfg-full"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="授权回调携带的 code，粘贴到这里换 token"
                />
                <button className="cfg-add" onClick={doExchange} disabled={busy || !code}>
                  用 code 换取 user_access_token
                </button>
              </>
            )}
          </section>

          <section className="cfg-section">
            <div className="cfg-sec-head">
              <h3>③ Token 与刷新</h3>
            </div>
            {bundle ? (
              <div className="cfg-card oauth-token">
                <p>
                  状态：已授权 · token_type={bundle.tokenType} · scope=
                  {bundle.scope || "—"}
                </p>
                <p>过期时间：{new Date(bundle.expTs * 1000).toLocaleString()}</p>
                <textarea
                  className="cfg-full"
                  readOnly
                  rows={2}
                  value={bundle.accessToken}
                />
                <div className="cfg-row">
                  <button className="cfg-add" onClick={doRefresh} disabled={busy}>
                    刷新 token
                  </button>
                  <button className="cfg-add" onClick={copy} disabled={busy}>
                    {copied ? "已复制" : "复制 access_token"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="cfg-hint">尚未完成授权，完成第 ② 步后展示 token。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}