# GenAI Interstitial Worker

A single-file Cloudflare Worker that presents a corporate warning page before
users reach a Generative AI application. Configuration is stored in a Workers KV
namespace (`GENAI_WARNING_PAGE`) and managed via a built-in admin UI.

> **Default posture:** Out of the box the worker runs in **RBI-only mode** — the
> Continue button is hidden and users must open AI applications via Cloudflare
> Clientless RBI. The "user clicks Continue → cookie ack" path is opt-in via
> the admin UI. This default is deliberate; see § Limitations.

## Disclaimer

```
THIS SOFTWARE IS PROVIDED "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL CLOUDFLARE BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES  (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Routes

| Method | Path     | Purpose                                                                                                  |
|--------|----------|----------------------------------------------------------------------------------------------------------|
| GET    | `/admin` | Admin dashboard (HTML form).                                                                              |
| POST   | `/admin` | Save config (`application/json` or `multipart/form-data`).                                                |
| GET    | `/logo`  | Serves the corporate logo binary stored in KV.                                                            |
| GET    | `/`      | Cloudflare Gateway redirect target. Renders the interstitial unless a valid per-app ack cookie is present (then 302's straight to `cf_site_uri`). |
| GET    | `/ack`   | Sets the per-app ack cookie (24 h) and 302's to `cf_site_uri`. Called by the Continue button.             |

### Required query parameters (from Gateway)

The Gateway HTTP policy must use a **Redirect** action with **"Send context to URL"** enabled. The worker reads:

- `cf_site_uri` — destination URL (required)
- `cf_application_names` — matched application name(s) (used as the per-app ack key; repeatable)
- `cf_user_email` — displayed in the context block
- `cf_source_ip` — displayed in the context block

### Ack cookie

- Set on the Continue path (`/ack`) only. RBI never sets a cookie.
- Name: `genai_ack_<slug>` where `<slug>` is derived from the first `cf_application_names` value (falling back to the destination hostname).
- Per-app isolation: acking ChatGPT does **not** ack Gemini.
- Attributes: `Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`.
- While the cookie is valid, the worker responds to `/` with a 302 straight to `cf_site_uri` — no UI is rendered.

### Required Gateway policy exemption (prevents redirect loop)

The worker's cookie lives on the worker's domain, so Gateway (which evaluates requests to the AI app's domain) cannot see it. After ack, the worker 302's to the destination with an additional marker query parameter, and **your Gateway HTTP policy must exclude requests carrying that marker**, otherwise Gateway will redirect the post-ack navigation back to the worker and the browser will hit `ERR_TOO_MANY_REDIRECTS`.

Marker: `interstitialpagepresented=true`

Recommended Gateway policy expression (Wirefilter):

```
(any(http.request.uri.content_category[*] in {"Artificial Intelligence"})
  or http.request.host in {"chatgpt.com" "gemini.google.com" "claude.ai"})
and not(http.request.uri.query contains "interstitialpagepresented=true")
```

Or, equivalently, in the dashboard rule builder add a final condition:
**URL Query — does not contain — `interstitialpagepresented=true`**.

## Limitations

The cookie + bypass-marker design has a known gap rooted in current Cloudflare
Gateway HTTP policy capabilities:

- **Gateway can only natively redirect on strict URL conditions** (hostname,
  application list, content category, exact path). It cannot evaluate cookies
  set on a different origin than the request being inspected — the worker's
  ack cookie lives on `genai-warning-page.<your zone>`, not on `chatgpt.com`.
- **The bypass marker must therefore travel in the URL itself** as a query
  parameter so Gateway can match it on the request to the AI app.
- **A user can intentionally bypass the interstitial** by appending
  `?interstitialpagepresented=true` (or any equivalent query) directly to the
  AI app URL. For example, `https://chatgpt.com/?interstitialpagepresented=true`
  or even `https://chatgpt.com/?foobar` combined with a Gateway rule that
  excludes a different marker — once a URL falls outside the policy match,
  the worker is never invoked and no acknowledgement is recorded.

This is **accepted by design**. The interstitial is a *user-education* surface:
its job is to remind well-intentioned users of corporate policy before they
type into a prompt, not to act as a hard control. A determined user can always
work around a URL-pattern-based redirect.

**If preventing data exfiltration is the actual requirement**, do not rely on
the Continue path at all. Instead:

1. Leave the worker in its default **RBI-only** mode.
2. Configure Cloudflare Gateway to route all matching AI traffic to Clientless
   Remote Browser Isolation.
3. Apply RBI data-protection controls — disable copy/paste, file uploads,
   printing, downloads, and keyboard input as appropriate.

That combination removes the bypass surface (the user never has direct browser
access to the AI app) and the data-protection enforcement happens in the
isolated browser session, not on the user's trust.

### Button behaviour

- **Continue to Application** → `/ack?cf_site_uri=...&cf_application_names=...` → worker sets the ack cookie → 302 to the destination.
- **Open in Isolated Browser** → `https://<rbiDomain>.cloudflareaccess.com/browser/<original_url>` (shown only when **Clientless RBI** is enabled and an RBI team domain is resolvable). If the **Team Name** field is left empty, the worker derives the team domain from the `iss` claim of the inbound Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header).
- **Require Isolated Browser** (admin toggle) → hides the Continue button entirely. If no RBI team domain is resolvable, an error block is shown in place of the buttons.

## Setup

```bash
# 1. Create the KV namespace
wrangler kv namespace create GENAI_WARNING_PAGE
wrangler kv namespace create GENAI_WARNING_PAGE --preview

# 2. Paste the returned ids into wrangler.toml (id / preview_id)

# 3. Run locally
wrangler dev

# 4. Deploy
wrangler deploy
```

Then visit `/admin` to configure the title, warning message, colors, logo,
Cloudflare Access team domain, and RBI toggles.

## Notes

- No build step or npm dependencies — just `wrangler dev` / `wrangler deploy`.
- The interstitial falls back to safe defaults if KV is empty or unreachable.
- The warning message supports a small Markdown subset (bold, italic, links,
  inline code, paragraphs). Output is HTML-escaped first to prevent injection.
- Text color on the interstitial is auto-picked (black/white) based on the
  configured background for readability.
