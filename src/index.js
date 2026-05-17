/**
 * GenAI Interstitial Worker
 *
 * Routes:
 *   GET  /admin       -> Admin dashboard (HTML form)
 *   POST /admin       -> Save configuration to KV (JSON or multipart form)
 *   GET  /logo        -> Serves the corporate logo stored in KV (binary)
 *   GET  /?url=...    -> Interstitial warning page for the target URL
 *
 * KV binding: GENAI_WARNING_PAGE
 *   key "config" -> JSON settings
 *   key "logo"   -> binary logo bytes (with metadata { contentType })
 */

const CONFIG_KEY = "config";
const LOGO_KEY = "logo";
const MAX_LOGO_BYTES = 512 * 1024; // 512 KB
const ALLOWED_LOGO_TYPES = new Set([
  "image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/gif",
]);

const DEFAULTS = {
  titleText: "Generative AI Access Notice",
  warningMessage:
    "**Caution:** You are about to access a Generative AI application using your corporate identity. " +
    "Do not paste confidential, customer, or proprietary data into prompts. " +
    "All activity may be logged in accordance with company policy.",
  backgroundColor: "#0b1220",
  accentColor: "#f6821f",
  hasLogo: false,
  rbiEnabled: false,
  rbiDomain: "", // Remote Browser Isolation domain (Cloudflare Access team domain)
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/admin" && request.method === "GET") {
        return renderAdmin(await loadConfig(env));
      }
      if (path === "/admin" && request.method === "POST") {
        return await saveConfig(request, env);
      }
      if (path === "/logo" && request.method === "GET") {
        return await serveLogo(env);
      }
      if (path === "/" && request.method === "GET") {
        return renderInterstitial(request, url, await loadConfig(env));
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response("Internal error: " + escapeHtml(String((err && err.message) || err)), {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

/* ---------------- Config ---------------- */

async function loadConfig(env) {
  let stored = {};
  try {
    stored = (await env.GENAI_WARNING_PAGE.get(CONFIG_KEY, { type: "json" })) || {};
  } catch (_) {
    stored = {};
  }
  return { ...DEFAULTS, ...stored };
}

async function saveConfig(request, env) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  let incoming = {};
  let logoFile = null;
  let clearLogo = false;

  if (ct.includes("application/json")) {
    incoming = await request.json();
    // JSON callers may pass an explicit `clearLogo` flag; logo upload is form-only.
    clearLogo = parseBool(incoming.clearLogo);
  } else {
    const form = await request.formData();
    incoming = {};
    for (const [k, v] of form.entries()) {
      if (k === "logoFile" && v && typeof v === "object" && "arrayBuffer" in v) {
        if (v.size > 0) logoFile = v;
      } else {
        incoming[k] = v;
      }
    }
    clearLogo = parseBool(incoming.clearLogo);
  }

  const current = await loadConfig(env);

  // Handle logo updates first so `hasLogo` reflects truth.
  let hasLogo = current.hasLogo;
  if (clearLogo) {
    await env.GENAI_WARNING_PAGE.delete(LOGO_KEY);
    hasLogo = false;
  } else if (logoFile) {
    const type = (logoFile.type || "").toLowerCase();
    if (!ALLOWED_LOGO_TYPES.has(type)) {
      return jsonOrText(ct, { ok: false, error: "Unsupported logo type" }, 400);
    }
    if (logoFile.size > MAX_LOGO_BYTES) {
      return jsonOrText(ct, { ok: false, error: "Logo exceeds 512 KB" }, 400);
    }
    const bytes = await logoFile.arrayBuffer();
    await env.GENAI_WARNING_PAGE.put(LOGO_KEY, bytes, { metadata: { contentType: type } });
    hasLogo = true;
  }

  const next = {
    titleText: sanitizeShortText(incoming.titleText, current.titleText, 120),
    warningMessage: typeof incoming.warningMessage === "string"
      ? incoming.warningMessage
      : current.warningMessage,
    backgroundColor: sanitizeColor(incoming.backgroundColor, current.backgroundColor),
    accentColor: sanitizeColor(incoming.accentColor, current.accentColor),
    hasLogo,
    rbiEnabled: parseBool(incoming.rbiEnabled),
    rbiDomain: sanitizeTeamDomain(incoming.rbiDomain, current.rbiDomain),
  };

  await env.GENAI_WARNING_PAGE.put(CONFIG_KEY, JSON.stringify(next));

  if (ct.includes("application/json")) {
    return new Response(JSON.stringify({ ok: true, config: next }), {
      headers: { "content-type": "application/json" },
    });
  }
  return Response.redirect(new URL("/admin", request.url).toString(), 303);
}

function jsonOrText(ct, body, status) {
  if (ct.includes("application/json")) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(body.error || "Error", { status });
}

/* ---------------- Logo serving ---------------- */

async function serveLogo(env) {
  const result = await env.GENAI_WARNING_PAGE.getWithMetadata(LOGO_KEY, { type: "arrayBuffer" });
  if (!result || !result.value) return new Response("Not Found", { status: 404 });
  const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";
  return new Response(result.value, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    },
  });
}

/* --------------- Sanitizers --------------- */

function sanitizeShortText(value, fallback, maxLen) {
  if (typeof value !== "string") return fallback;
  const v = value.replace(/[\r\n\t]+/g, " ").trim();
  if (v === "") return fallback;
  return v.slice(0, maxLen);
}

function sanitizeColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(v)) return v;
  return fallback;
}

function sanitizeTeamDomain(value, fallback) {
  if (typeof value !== "string") return fallback;
  let v = value.trim().toLowerCase();
  if (v === "") return "";
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  v = v.replace(/\.cloudflareaccess\.com$/, "");
  if (/^[a-z0-9-]{1,63}$/.test(v)) return v;
  return fallback;
}

function parseBool(value) {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "on" || v === "1" || v === "enabled" || v === "yes";
}

/* --------------- Cloudflare Access JWT --------------- */

/**
 * Extract the team domain (subdomain of cloudflareaccess.com) from the
 * Cf-Access-Jwt-Assertion header's `iss` claim. The signature is NOT verified
 * here because Cloudflare Access has already validated it at the edge before
 * the request reaches this Worker.
 */
function extractTeamDomainFromJwt(request) {
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    extractCookie(request, "CF_Authorization");
  if (!token) return "";
  try {
    const parts = token.split(".");
    if (parts.length < 2) return "";
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (!iss) return "";
    const u = new URL(iss);
    const m = u.hostname.match(/^([a-z0-9-]{1,63})\.cloudflareaccess\.com$/i);
    return m ? m[1].toLowerCase() : "";
  } catch (_) {
    return "";
  }
}

function extractCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const parts = cookie.split(/;\s*/);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx > -1 && p.slice(0, idx) === name) return decodeURIComponent(p.slice(idx + 1));
  }
  return "";
}

function base64UrlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

/* --------------- Gateway redirect context --------------- */

/**
 * Cloudflare Gateway's redirect action appends contextual query parameters
 * to the destination URL when "Send context to URL" is enabled. We surface
 * a useful subset of these on the interstitial.
 *
 * Docs: https://developers.cloudflare.com/cloudflare-one/policies/gateway/http-policies/#send-context-to-redirect
 */
function extractGatewayContext(reqUrl) {
  const sp = reqUrl.searchParams;
  // `cf_application_names` may repeat for multiple matched apps.
  const appNames = sp.getAll("cf_application_names").filter(Boolean);
  return {
    userEmail: (sp.get("cf_user_email") || "").trim(),
    sourceIp: (sp.get("cf_source_ip") || "").trim(),
    applicationName: appNames.length ? appNames.join(", ") : "",
  };
}

function renderContextBlock(ctx) {
  const row = (label, value) => {
    const hasValue = value && value.length > 0;
    const cls = hasValue ? "" : ' class="unknown"';
    const display = hasValue ? escapeHtml(value) : "Unknown";
    return `<dt>${escapeHtml(label)}</dt><dd${cls}>${display}</dd>`;
  };
  return `<div class="context"><dl>${
    row("User", ctx.userEmail) +
    row("Source IP", ctx.sourceIp) +
    row("Application", ctx.applicationName)
  }</dl></div>`;
}

/* --------------- Admin UI --------------- */

function renderAdmin(cfg) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Interstitial Admin</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0; padding: 2rem; background: #f5f6f8; color: #1a1a1a; }
  .card { max-width: 760px; margin: 0 auto; background: #fff; padding: 2rem 2.25rem;
          border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.06); }
  h1 { margin-top: 0; font-size: 1.5rem; }
  p.sub { color: #555; margin-top: -.25rem; }
  label { display: block; font-weight: 600; margin: 1.1rem 0 .35rem; font-size: .92rem; }
  input[type="text"], input[type="url"], textarea, input[type="file"] {
    width: 100%; padding: .6rem .75rem; border: 1px solid #d0d4da; border-radius: 8px;
    font-size: .95rem; font-family: inherit; background: #fff; color: inherit;
  }
  input[type="color"] {
    width: 100%; height: 64px; padding: .25rem; border: 1px solid #d0d4da;
    border-radius: 8px; background: #fff; cursor: pointer;
  }
  input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
  input[type="color"]::-webkit-color-swatch { border: none; border-radius: 6px; }
  input[type="color"]::-moz-color-swatch { border: none; border-radius: 6px; }
  textarea { min-height: 140px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .toggle { display: flex; align-items: center; gap: .6rem; margin-top: .5rem; }
  .hint { color: #666; font-size: .82rem; margin-top: .3rem; }
  .actions { margin-top: 1.75rem; display: flex; gap: .75rem; align-items: center; }
  button { background: #1f6feb; color: #fff; border: 0; padding: .7rem 1.2rem;
           border-radius: 8px; font-size: .95rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #1858c2; }
  .pill { font-size: .75rem; color: #fff; background: #2da44e; padding: .15rem .55rem;
          border-radius: 999px; display: none; }
  .pill.show { display: inline-block; }
  .logo-preview { display: flex; align-items: center; gap: 1rem; margin-top: .5rem; }
  .logo-preview img { max-height: 48px; max-width: 180px; padding: .25rem .5rem;
                      background: #f5f6f8; border: 1px solid #e1e4e8; border-radius: 6px; object-fit: contain; }
  @media (max-width: 600px) { .row { grid-template-columns: 1fr; } body { padding: 1rem; } .card { padding: 1.25rem; } }
</style>
</head>
<body>
  <div class="card">
    <h1>GenAI Interstitial — Configuration</h1>
    <p class="sub">Settings and logo are stored in the <code>GENAI_WARNING_PAGE</code> KV namespace.</p>

    <form id="cfg" method="POST" action="/admin" enctype="multipart/form-data">
      <label for="titleText">Title <span class="hint">(shown above the destination hostname)</span></label>
      <input type="text" id="titleText" name="titleText" maxlength="120" value="${escapeAttr(cfg.titleText)}" />

      <label for="warningMessage">Warning Message <span class="hint">(plain text or simple Markdown: **bold**, *italic*, [link](url), line breaks)</span></label>
      <textarea id="warningMessage" name="warningMessage">${escapeHtml(cfg.warningMessage)}</textarea>

      <div class="row">
        <div>
          <label for="backgroundColor">Background Color</label>
          <input type="color" id="backgroundColor" name="backgroundColor" value="${escapeAttr(toHexColor(cfg.backgroundColor))}" />
        </div>
        <div>
          <label for="accentColor">Accent Text Color</label>
          <input type="color" id="accentColor" name="accentColor" value="${escapeAttr(toHexColor(cfg.accentColor))}" />
        </div>
      </div>

      <label for="logoFile">Corporate Logo</label>
      <input type="file" id="logoFile" name="logoFile" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" />
      <div class="hint">Max 512 KB. PNG, JPG, SVG, WebP, or GIF. Stored in KV and served from <code>/logo</code>.</div>
      ${cfg.hasLogo ? `
      <div class="logo-preview">
        <img src="/logo?t=${Date.now()}" alt="Current logo" />
        <label style="display:flex;align-items:center;gap:.4rem;font-weight:500;margin:0;">
          <input type="checkbox" name="clearLogo" value="true" /> Remove current logo
        </label>
      </div>` : ""}

      <label for="rbiDomain">Team Name</label>
      <input type="text" id="rbiDomain" name="rbiDomain" placeholder="yourteam (leave empty to use the team name from the Access JWT)" value="${escapeAttr(cfg.rbiDomain)}" />
      <div class="hint">Cloudflare Access team name. If left empty, the worker reads it from the <code>Cf-Access-Jwt-Assertion</code> header (<code>iss</code> claim) of the inbound Access request. The RBI link becomes <code>https://&lt;team&gt;.cloudflareaccess.com/browser/&lt;url&gt;</code>.</div>

      <label>Clientless RBI</label>
      <div class="toggle">
        <input type="checkbox" id="rbiEnabled" name="rbiEnabled" value="true" ${cfg.rbiEnabled ? "checked" : ""} />
        <label for="rbiEnabled" style="margin:0;font-weight:500;">Show "Open in Isolated Browser" button</label>
      </div>

      <div class="actions">
        <button type="submit">Save Configuration</button>
        <span id="saved" class="pill">Saved</span>
        <a href="/?cf_site_uri=https%3A%2F%2Fchatgpt.com%2F&cf_user_email=preview%40example.com&cf_source_ip=203.0.113.42&cf_application_names=ChatGPT" target="_blank" style="margin-left:auto;">Preview interstitial &rarr;</a>
      </div>
    </form>
  </div>

<script>
  // Submit via fetch so we can show a "Saved" pill, but fall back to normal POST if JS disabled.
  document.getElementById("cfg").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var fd = new FormData(form);
    fd.set("rbiEnabled", document.getElementById("rbiEnabled").checked ? "true" : "false");
    fetch("/admin", { method: "POST", body: fd, headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function () {
        var p = document.getElementById("saved");
        p.classList.add("show");
        setTimeout(function () { window.location.reload(); }, 700);
      })
      .catch(function (err) { alert("Save failed: " + err); });
  });
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/* --------------- Interstitial --------------- */

function renderInterstitial(request, reqUrl, cfg) {
  // Cloudflare Gateway sends the destination URL as `cf_site_uri`.
  // Keep `url` as a backward-compatible alias for manual / preview use.
  const target = (
    reqUrl.searchParams.get("cf_site_uri") ||
    reqUrl.searchParams.get("url") ||
    ""
  ).trim();
  const parsed = safeParseTarget(target);

  if (!parsed) {
    return new Response(missingUrlPage(cfg), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Extract Gateway redirect context (all optional).
  const gateway = extractGatewayContext(reqUrl);

  // RBI domain: configured value wins; otherwise fall back to the team
  // domain from the inbound Access JWT.
  const effectiveRbiDomain = cfg.rbiDomain || extractTeamDomainFromJwt(request);

  const continueUrl = appendQueryParam(parsed.urlObj, "interstitialpagepresented", "true");
  const rbiUrl = cfg.rbiEnabled && effectiveRbiDomain
    ? `https://${effectiveRbiDomain}.cloudflareaccess.com/browser/${parsed.original}`
    : "";

  const bg = cfg.backgroundColor || DEFAULTS.backgroundColor;
  const accent = cfg.accentColor || DEFAULTS.accentColor;
  const text = pickReadableText(bg);
  const subText = withAlpha(text, 0.72);
  const cardBg = withAlpha(text, 0.06);
  const borderCol = withAlpha(text, 0.14);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(cfg.titleText || DEFAULTS.titleText)} — ${escapeHtml(parsed.host)}</title>
<style>
  :root {
    --bg: ${escapeAttr(bg)};
    --accent: ${escapeAttr(accent)};
    --text: ${escapeAttr(text)};
    --sub: ${escapeAttr(subText)};
    --card: ${escapeAttr(cardBg)};
    --border: ${escapeAttr(borderCol)};
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 2rem 1rem;
  }
  .wrap { max-width: 640px; width: 100%; }
  .logo { display: flex; justify-content: center; margin-bottom: 2rem; }
  .logo img { max-height: 120px; max-width: 360px; object-fit: contain; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 16px;
    padding: 2rem 2.25rem; backdrop-filter: blur(6px);
  }
  .eyebrow { font-size: .78rem; letter-spacing: .12em; text-transform: uppercase;
             color: var(--accent); font-weight: 700; margin-bottom: .5rem; }
  h1 { margin: 0 0 1rem; font-size: 1.5rem; line-height: 1.3; }
  h1 .host { color: var(--accent); word-break: break-all; }
  .msg { color: var(--sub); font-size: 1rem; line-height: 1.55; }
  .msg p { margin: 0 0 .8rem; }
  .msg p:last-child { margin-bottom: 0; }
  .msg a { color: var(--accent); }
  .context { margin: 1.25rem 0 0; padding: .9rem 1rem; background: var(--card);
             border: 1px solid var(--border); border-radius: 10px; font-size: .9rem; }
  .context dl { margin: 0; display: grid; grid-template-columns: max-content 1fr;
                gap: .35rem .9rem; align-items: baseline; }
  .context dt { color: var(--sub); font-weight: 600; }
  .context dd { margin: 0; color: var(--text); word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88rem; }
  .context dd.unknown { color: var(--sub); font-style: italic; font-family: inherit; }
  .actions { display: flex; gap: .75rem; margin-top: 1.75rem; flex-wrap: wrap; }
  .btn {
    flex: 1 1 200px; text-align: center; padding: .85rem 1.1rem; border-radius: 10px;
    font-weight: 600; font-size: .98rem; text-decoration: none; cursor: pointer;
    border: 1px solid transparent; transition: transform .04s ease, opacity .15s ease;
  }
  .btn:active { transform: translateY(1px); }
  .btn-primary { background: var(--accent); color: ${escapeAttr(pickReadableText(accent))}; }
  .btn-primary:hover { opacity: .92; }
  .btn-secondary { background: transparent; color: var(--text); border-color: var(--border); }
  .btn-secondary:hover { background: var(--card); }
  .footer { margin-top: 1.25rem; text-align: center; color: var(--sub); font-size: .8rem; }
  code { background: var(--card); padding: .1rem .35rem; border-radius: 4px; }
  @media (max-width: 480px) { .card { padding: 1.4rem; } h1 { font-size: 1.25rem; } }
</style>
</head>
<body>
  <main class="wrap" role="main">
    ${cfg.hasLogo ? `<div class="logo"><img src="/logo" alt="Corporate logo" /></div>` : ""}
    <section class="card">
      <div class="eyebrow">${escapeHtml(cfg.titleText || DEFAULTS.titleText)}</div>
      <h1>You are accessing <span class="host">${escapeHtml(parsed.host)}</span></h1>
      ${renderContextBlock(gateway)}
      <div class="msg">${renderMarkdown(cfg.warningMessage || DEFAULTS.warningMessage)}</div>
      <div class="actions">
        <a class="btn btn-primary" href="${escapeAttr(continueUrl)}" rel="noopener">Continue to Application</a>
        ${rbiUrl ? `<a class="btn btn-secondary" href="${escapeAttr(rbiUrl)}" rel="noopener">Open in Isolated Browser</a>` : ""}
      </div>
    </section>
    <div class="footer">Destination: <code>${escapeHtml(parsed.display)}</code></div>
  </main>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function missingUrlPage(cfg) {
  const bg = cfg.backgroundColor || DEFAULTS.backgroundColor;
  const text = pickReadableText(bg);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Missing URL</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:${escapeAttr(bg)};color:${escapeAttr(text)};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
.box{max-width:480px;padding:2rem;text-align:center;}</style></head>
<body><div class="box"><h1>Missing target URL</h1>
<p>This page expects a <code>?url=</code> query parameter pointing to the GenAI application.</p></div></body></html>`;
}

/* --------------- URL helpers --------------- */

function safeParseTarget(raw) {
  if (!raw) return null;
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) candidate = "https://" + candidate;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return {
      urlObj: u,
      original: u.toString(),
      host: u.hostname,
      display: u.host + (u.pathname && u.pathname !== "/" ? u.pathname : ""),
    };
  } catch (_) {
    return null;
  }
}

function appendQueryParam(urlObj, key, value) {
  const u = new URL(urlObj.toString());
  u.searchParams.set(key, value);
  return u.toString();
}

/* --------------- Color helpers --------------- */

function toHexColor(c) {
  if (typeof c !== "string") return "#000000";
  const v = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return ("#" + v.slice(1).split("").map((ch) => ch + ch).join("")).toLowerCase();
  }
  if (/^#[0-9a-f]{8}$/i.test(v)) return v.slice(0, 7).toLowerCase();
  return "#000000";
}

function hexToRgb(hex) {
  const h = toHexColor(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function pickReadableText(bg) {
  try {
    const { r, g, b } = hexToRgb(bg);
    const srgb = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const lum = 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
    return lum > 0.5 ? "#0b1220" : "#ffffff";
  } catch {
    return "#ffffff";
  }
}

function withAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* --------------- Markdown (tiny, safe subset) --------------- */

function renderMarkdown(src) {
  let s = escapeHtml(src);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, text, href) => `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  const paragraphs = s.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`);
  return paragraphs.join("");
}

/* --------------- HTML escape --------------- */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str);
}
