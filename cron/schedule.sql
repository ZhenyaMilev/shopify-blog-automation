-- ─────────────────────────────────────────────────────────────────────────────
-- pg_cron schedules for the Shopify blog automation.
--
-- These run INSIDE your Supabase Postgres using the pg_cron + pg_net extensions
-- and call the deployed edge functions over HTTP. Times are UTC.
--
-- SECURITY: never commit a real key here. Replace <YOUR_SUPABASE_ANON_KEY> below,
-- OR (recommended) store the key once as a DB setting and reference it:
--
--   ALTER DATABASE postgres SET app.settings.anon_key = '<YOUR_SUPABASE_ANON_KEY>';
--   -- then in the command use:
--   --   'Bearer ' || current_setting('app.settings.anon_key', true)
--
-- Enable the required extensions first (Dashboard → Database → Extensions, or):
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Generate + publish today's article — daily 10:00 UTC
select cron.schedule(
  'shopify-ultra-seo-daily',
  '0 10 * * *',
  $$
  select net.http_post(
    url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/shopify-blog-automation-ultra-seo',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>'
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

-- 2) Retry the publish an hour later (no-op if today already published) — daily 11:00 UTC
select cron.schedule(
  'shopify-ultra-seo-retry',
  '0 11 * * *',
  $$
  select net.http_post(
    url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/shopify-blog-automation-ultra-seo',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>'
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

-- 3) Generate + attach the header image — every 5 min during the publish window (10–11 UTC)
--    (one article/image per invocation; self-stops when the queue is empty)
select cron.schedule(
  'shopify-blog-image-generator',
  '*/5 10-11 * * *',
  $$
  select net.http_post(
    url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/shopify-blog-image-generator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <YOUR_SUPABASE_ANON_KEY>'
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

-- ── Optional maintenance jobs (functions are included; not scheduled by default) ──

-- 4) Add internal + service-page links across the blog — e.g. daily 12:00 UTC
-- select cron.schedule(
--   'blog-internal-linker',
--   '0 12 * * *',
--   $$
--   select net.http_post(
--     url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/blog-internal-linker',
--     headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <YOUR_SUPABASE_ANON_KEY>'),
--     body    := '{}'::jsonb
--   ) as request_id;
--   $$
-- );

-- 5) Refresh stale month/year articles — e.g. weekly Monday 09:00 UTC
-- select cron.schedule(
--   'blog-article-refresher',
--   '0 9 * * 1',
--   $$
--   select net.http_post(
--     url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/blog-article-refresher',
--     headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <YOUR_SUPABASE_ANON_KEY>'),
--     body    := '{}'::jsonb
--   ) as request_id;
--   $$
-- );

-- Inspect / remove jobs:
--   select jobid, jobname, schedule from cron.job order by jobid;
--   select cron.unschedule('shopify-ultra-seo-daily');
