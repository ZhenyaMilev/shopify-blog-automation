# Shopify Blog Automation (SEO, self-driving)

A fully automated, SEO-first blog engine for a Shopify store. It plans a weekly
content calendar, researches each topic against live data, writes a long-form,
AI-citation-optimized article, publishes it to a Shopify blog, generates a header
image, and keeps the whole archive interlinked and fresh — all on a cron schedule,
with zero human input.

Built as **Supabase Edge Functions** (Deno/TypeScript) driven by **pg_cron**.

---

## What it does

```
                          ┌──────────────────────────────────────────┐
   pg_cron  10:00 UTC ───▶│  shopify-blog-automation-ultra-seo        │
                          │  1. ensure a 7-day plan exists (Perplexity)│
                          │  2. pick today's topic from the plan      │
                          │  3. enrich keywords           (OpenAI)    │
                          │  4. deep research the topic   (Perplexity)│
                          │  5. write the article         (OpenAI)    │
                          │  6. publish to Shopify  → status=published │
                          └───────────────┬──────────────────────────┘
                                          │  (row: image_status = pending)
   pg_cron  */5 10-11 ───▶┌───────────────▼──────────────────────────┐
                          │  shopify-blog-image-generator             │
                          │  generate header image (Gemini) → upload  │
                          │  to Supabase Storage → attach to article  │
                          └──────────────────────────────────────────┘

   (optional, on demand) ┌──────────────────────────────────────────┐
                         │  blog-internal-linker    cross-links posts │
                         │  blog-article-refresher  un-stales m/y refs│
                         └──────────────────────────────────────────┘
```

All publishing state lives in one Postgres table, **`blog_content_plan`**, which
acts as both the content calendar and the pipeline state machine.

---

## The functions

| Function | Trigger | What it does |
|---|---|---|
| **`shopify-blog-automation-ultra-seo`** | daily 10:00 UTC (+ 11:00 retry) | The core. Generates the weekly plan (once per week), then each day researches and writes a 1800–2200-word article in one of 4 formats (listicle / comparison / evergreen-guide / technical) and publishes it to Shopify. Dedupes against existing + previously planned topics, forces current year, injects a strict ICP filter and a single conversion CTA. |
| **`shopify-blog-image-generator`** | every 5 min, 10–11 UTC | Finds published rows with no image, generates a text-free 16:9 header via Gemini, uploads to Supabase Storage, attaches it to the Shopify article. Retries up to 3× then marks `failed`. |
| **`blog-internal-linker`** | manual / optional cron | Keeps every article above a minimum internal-link count: scores topical relevance, asks GPT for natural anchor text, inserts links (incl. service/portfolio pages), and reverse-links older posts to newer ones. |
| **`blog-article-refresher`** | manual / optional cron | Finds articles whose title contains a now-past "Month Year", asks GPT for targeted month/year edits, and updates them on Shopify so evergreen posts stay current. |

### Content strategy (baked into the prompts)

- **7 categories**, one per weekday: store-problem listicles, app/tool comparisons,
  migration guides, CRO guides, hiring/agency guides, platform/plan comparisons,
  technical Shopify guides.
- A strict **ICP filter** (`ICP_CONTEXT` in the code) keeps topics aimed at owners
  of established Shopify stores — the people who hire agencies — and explicitly
  rejects consumer/dropshipping shopping content.
- Optimized for **AI-engine citation** (ChatGPT/Perplexity): answer-first blocks,
  tables, FAQs, direct factual answers grounded only in the researched data.

> The prompts contain agency-specific branding, a knowledge base, and case-study
> links (services/portfolio/case pages). Search the function source for `MILEDEVS`,
> `/pages/services`, `/pages/case-` and the `ICP_CONTEXT` block to rebrand for your
> own store.

---

## Tech stack

- **Runtime:** Supabase Edge Functions (Deno, TypeScript)
- **Scheduler:** `pg_cron` + `pg_net` (Postgres)
- **Storage:** Supabase Storage (public bucket `knowledge-base-images`)
- **AI:** OpenAI `gpt-4o` (writing/keywords/links), Perplexity `sonar` (research/planning), Google Gemini `gemini-3-pro-image-preview` (images)
- **Publishing target:** Shopify Admin REST API `2024-10`, custom app via the `client_credentials` grant

---

## Setup

### 1. Prerequisites
- A Supabase project ([CLI](https://supabase.com/docs/guides/cli) installed & `supabase login`)
- A Shopify custom app with Blog read/write scopes (`write_content`), using the
  client-credentials grant → gives you `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`
- API keys: OpenAI, Perplexity, Google Gemini
- Your numeric `SHOPIFY_BLOG_ID` (Shopify admin → Blog posts → the blog's URL)

### 2. Database
Apply the table (content calendar + pipeline state):
```bash
supabase db push          # applies supabase/migrations/0001_blog_content_plan.sql
# or paste that file into the Supabase SQL editor
```

### 3. Storage
Create a **public** bucket named `knowledge-base-images` (the image generator
uploads to `shopify-blog-images/` inside it and stores the public URL on Shopify).

### 4. Secrets
```bash
cp .env.example .env      # fill in real values (this file is gitignored)
supabase secrets set --env-file ./.env
```
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into
deployed functions — you only need them in `.env` for local `functions serve`.

### 5. Deploy the functions
```bash
supabase functions deploy shopify-blog-automation-ultra-seo
supabase functions deploy shopify-blog-image-generator
supabase functions deploy blog-internal-linker
supabase functions deploy blog-article-refresher
```
`verify_jwt = false` (see `supabase/config.toml`) lets pg_cron invoke them.

### 6. Schedule
Enable the extensions, then edit `cron/schedule.sql` (replace `<YOUR_PROJECT_REF>`
and the bearer placeholder) and run it:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- then run cron/schedule.sql
```

### Test a run manually
```bash
curl -i -X POST \
  "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/shopify-blog-automation-ultra-seo" \
  -H "Authorization: Bearer <YOUR_SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" -d '{}'
```

---

## Required environment variables

| Variable | Used by | Notes |
|---|---|---|
| `OPENAI_API_KEY` | ultra-seo, internal-linker, refresher | `gpt-4o` |
| `PERPLEXITY_API_KEY` | ultra-seo | `sonar` — planning + research |
| `GEMINI_API_KEY` | image-generator | image model |
| `SHOPIFY_STORE_URL` | all | host only, e.g. `your-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | all | custom app |
| `SHOPIFY_CLIENT_SECRET` | all | custom app |
| `SHOPIFY_BLOG_ID` | all | numeric blog id |
| `SUPABASE_URL` | ultra-seo, image-generator | auto-injected when deployed |
| `SUPABASE_SERVICE_ROLE_KEY` | ultra-seo, image-generator | auto-injected when deployed |

See `.env.example`.

---

## Notes & cost

- Roughly **one article/day**: ~1 Perplexity plan call/week + ~2 Perplexity + ~2
  OpenAI `gpt-4o` calls/day + 1 Gemini image/day. Budget a few US$/day depending
  on model pricing.
- The pipeline is **idempotent per day** — the retry job is a safe no-op once the
  day is published; the image generator caps at 3 attempts then marks `failed`.
- All article HTML is sanitized (no `<h1>`, no `<script>`, single-quoted attributes)
  so it drops cleanly into a Shopify blog template.

## Security

No secrets are committed. All credentials are read from the environment
(`Deno.env.get(...)`) at runtime; `cron/schedule.sql` and `.env.example` carry
placeholders only. Rotate any key that has ever been pasted somewhere public.

## License

MIT — see `LICENSE`.
