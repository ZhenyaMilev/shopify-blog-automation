-- ─────────────────────────────────────────────────────────────────────────────
-- blog_content_plan
-- The single source of truth for the weekly content calendar and the publishing
-- pipeline state machine. One row = one planned/published article for one day.
--
-- Lifecycle of a row:
--   1. shopify-blog-automation-ultra-seo inserts 7 rows/week (status = 'planned')
--   2. on its scheduled_date the same function generates + publishes the article,
--      then flips the row to status = 'published' and sets image_status = 'pending'
--   3. shopify-blog-image-generator picks up published rows with image_status =
--      'pending', generates a header image, attaches it, sets image_status = 'done'
--   4. (optional) a threads cross-poster uses threads_status / threads_post_id
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.blog_content_plan (
  id                   bigint generated always as identity primary key,

  -- calendar
  week_start           date    not null,                      -- Monday of the plan week (YYYY-MM-DD)
  day_index            integer not null,                      -- 0=Mon .. 6=Sun
  scheduled_date       date    not null,                      -- the day this topic publishes
  topic                text    not null,                      -- article title / topic
  category             text    not null,                      -- one of the 7 content categories
  content_format       text    default 'technical',           -- listicle | comparison | evergreen-guide | technical
  target_word_count    integer default 1800,
  keywords             text[]  default '{}',

  -- publishing state
  status               text    not null default 'planned',    -- planned | published
  article_id           bigint,                                -- Shopify article id once published
  article_url          text,
  published_at         timestamptz,

  -- header image state (handled by shopify-blog-image-generator)
  image_url            text,
  image_status         text    default 'pending',             -- pending | done | failed
  image_attempts       integer default 0,                     -- capped at MAX_ATTEMPTS (3) in code

  -- optional Threads cross-post state
  threads_status       text    not null default 'pending',    -- pending | published
  threads_post_id      text,
  threads_published_at timestamptz,

  created_at           timestamptz default now()
);

-- getTodayPlan(): scheduled_date = today AND status = 'planned'
create index if not exists idx_blog_plan_scheduled_status
  on public.blog_content_plan (scheduled_date, status);

-- getWeekPlanExists(): week_start = ?
create index if not exists idx_blog_plan_week_start
  on public.blog_content_plan (week_start);

-- image generator queue: status = 'published' AND image_status = 'pending'
create index if not exists idx_blog_plan_image_queue
  on public.blog_content_plan (status, image_status, image_attempts);
