# GenAI Interstitial Worker

A single-file Cloudflare Worker that presents a corporate warning page before
users reach a Generative AI application. Configuration is stored in a Workers KV
namespace (`INTERSTITIAL_CONFIG`) and managed via a built-in admin UI.

## Routes

| Method | Path     | Purpose                                                                 |
|--------|----------|-------------------------------------------------------------------------|
| GET    | `/admin` | Admin dashboard (HTML form).                                            |
| POST   | `/admin` | Save config (`application/json` or `multipart/form-data`).              |
| GET    | `/logo`  | Serves the corporate logo binary stored in KV.                          |
| GET    | `/?url=` | Interstitial page for the target GenAI URL.                             |

### Button behaviour

- **Continue to Application** → target URL with `interstitialpagepresented=true` appended (preserves existing query string).
- **Open in Isolated Browser** → `https://<rbiDomain>.cloudflareaccess.com/browser/<original_url>` (shown only when RBI is enabled and an RBI domain is resolvable). If the **Remote Browser Isolation Domain** field is left empty, the worker derives the team domain from the `iss` claim of the inbound Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header).

## Setup

```bash
# 1. Create the KV namespace
wrangler kv namespace create INTERSTITIAL_CONFIG
wrangler kv namespace create INTERSTITIAL_CONFIG --preview

# 2. Paste the returned ids into wrangler.toml (id / preview_id)

# 3. Run locally
wrangler dev

# 4. Deploy
wrangler deploy
```

Then visit `/admin` to configure the warning message, colors, logo URL,
Cloudflare Access team domain, and RBI toggle.

## Notes

- No build step or npm dependencies — just `wrangler dev` / `wrangler deploy`.
- The interstitial falls back to safe defaults if KV is empty or unreachable.
- The warning message supports a small Markdown subset (bold, italic, links,
  inline code, paragraphs). Output is HTML-escaped first to prevent injection.
- Text color on the interstitial is auto-picked (black/white) based on the
  configured background for readability.
