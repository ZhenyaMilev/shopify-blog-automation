import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ShopifyTokenResponse {
  access_token: string;
  expires_in: number;
}

interface ShopifyArticle {
  id: number;
  title: string;
  body_html: string;
  handle: string;
  tags: string;
  published_at: string;
}

interface GPTRefreshResult {
  title: string;
  updatedSections: Array<{ oldText: string; newText: string }>;
}

interface RefreshSummary {
  articleId: number;
  oldTitle: string;
  newTitle: string;
  sectionsUpdated: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Regex: month name + 4-digit year (e.g. "March 2026", "February 2025")
const MONTH_YEAR_REGEX = new RegExp(
  `(${MONTH_NAMES.join('|')})\\s+(\\d{4})`,
  'i',
);

const MAX_ARTICLES_PER_RUN = 3;
const MIN_AGE_DAYS = 25;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getShopifyAccessToken(
  storeUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.token;
  const tokenUrl = `https://${storeUrl}/admin/oauth/access_token`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get token: ${response.status} ${errText}`);
  }
  const data: ShopifyTokenResponse = await response.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in - 3600) * 1000,
  };
  return data.access_token;
}

// ── Shopify API ────────────────────────────────────────────────────────────────

async function fetchAllArticles(
  storeUrl: string,
  accessToken: string,
  blogId: string,
): Promise<ShopifyArticle[]> {
  let allArticles: ShopifyArticle[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = `https://${storeUrl}/admin/api/2024-10/blogs/${blogId}/articles.json?limit=250&page=${page}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    });
    if (!response.ok) {
      console.error(`Failed to fetch articles page ${page}: ${response.status}`);
      break;
    }
    const data = await response.json();
    const articles: ShopifyArticle[] = data.articles || [];
    if (articles.length === 0) {
      hasMore = false;
    } else {
      allArticles = allArticles.concat(articles);
      console.log(`Fetched page ${page}: ${articles.length} articles (total: ${allArticles.length})`);
      if (articles.length < 250) hasMore = false;
      else page++;
    }
    if (page > 20) {
      console.log('Reached max pagination limit');
      break;
    }
  }
  return allArticles;
}

async function updateArticleOnShopify(
  storeUrl: string,
  accessToken: string,
  blogId: string,
  articleId: number,
  title: string,
  bodyHtml: string,
): Promise<void> {
  const url = `https://${storeUrl}/admin/api/2024-10/blogs/${blogId}/articles/${articleId}.json`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        article: {
          id: articleId,
          title,
          body_html: bodyHtml,
        },
      }),
    },
    60000,
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Shopify PUT error for article ${articleId}: ${response.status} ${errText}`);
  }
  console.log(`Successfully updated article ${articleId} on Shopify`);
}

// ── Month detection & freshness ────────────────────────────────────────────────

function extractMonthYear(title: string): { month: string; year: number } | null {
  const match = title.match(MONTH_YEAR_REGEX);
  if (!match) return null;
  return {
    month: match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase(),
    year: parseInt(match[2], 10),
  };
}

function isArticleStale(articleMonth: string, articleYear: number): boolean {
  const now = new Date();
  const currentMonthIndex = now.getMonth(); // 0-based
  const currentYear = now.getFullYear();
  const articleMonthIndex = MONTH_NAMES.indexOf(articleMonth);
  if (articleMonthIndex === -1) return false;

  // Convert to absolute month number for easy comparison
  const currentAbsolute = currentYear * 12 + currentMonthIndex;
  const articleAbsolute = articleYear * 12 + articleMonthIndex;

  // Stale if article's month is strictly before current month
  return articleAbsolute < currentAbsolute;
}

function isArticleTooRecent(publishedAt: string): boolean {
  if (!publishedAt) return false;
  const published = new Date(publishedAt);
  const now = new Date();
  const diffMs = now.getTime() - published.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays < MIN_AGE_DAYS;
}

function getCurrentMonthYear(): string {
  const now = new Date();
  return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
}

// ── GPT-4o refresh ─────────────────────────────────────────────────────────────

async function callGPTForRefresh(
  openaiApiKey: string,
  currentTitle: string,
  currentContent: string,
  oldMonthYear: string,
  newMonthYear: string,
): Promise<GPTRefreshResult> {
  const contentSnippet = currentContent.substring(0, 2000);

  const systemPrompt = `You are an expert SEO content editor. You update blog articles to keep them fresh and relevant for AI search engines (ChatGPT, Perplexity). You make minimal, targeted changes — only updating month/year references and any month-specific data. You preserve the overall structure, tone, and factual content. ALL attribute quotes in any HTML you output must be single quotes (not double quotes).`;

  const userPrompt = `Update this article from "${oldMonthYear}" to "${newMonthYear}".

CURRENT TITLE: ${currentTitle}

CONTENT (first 2000 chars for context):
${contentSnippet}

INSTRUCTIONS:
1. Update the title — replace "${oldMonthYear}" with "${newMonthYear}"
2. Find all month-specific references in the content and update them
3. Keep the overall structure, data, and tone intact
4. If there are phrases like "this ${oldMonthYear}" or "in ${oldMonthYear}", update them
5. Do NOT rewrite the entire article — only change what is necessary
6. ALL HTML attribute quotes must be single quotes

Return ONLY valid JSON (no markdown, no code fences):
{"title": "Updated Title Here", "updatedSections": [{"oldText": "exact old text to find", "newText": "replacement text"}]}

IMPORTANT:
- Each oldText must be an EXACT substring from the original content
- Keep updatedSections focused — only month/year changes
- Usually 2-8 replacements are enough`;

  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    },
    60000,
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Empty GPT response');

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse GPT refresh JSON: ${cleaned.substring(0, 300)}`);

  const result: GPTRefreshResult = JSON.parse(jsonMatch[0]);

  if (!result.title || !Array.isArray(result.updatedSections)) {
    throw new Error('Invalid GPT refresh result structure');
  }

  return result;
}

// ── Apply updates ──────────────────────────────────────────────────────────────

function applyContentUpdates(
  content: string,
  updates: Array<{ oldText: string; newText: string }>,
): { updatedContent: string; appliedCount: number } {
  let updatedContent = content;
  let appliedCount = 0;

  for (const update of updates) {
    if (!update.oldText || !update.newText) continue;
    if (update.oldText === update.newText) continue;

    if (updatedContent.includes(update.oldText)) {
      updatedContent = updatedContent.split(update.oldText).join(update.newText);
      appliedCount++;
      console.log(`  Replaced: "${update.oldText.substring(0, 60)}..." -> "${update.newText.substring(0, 60)}..."`);
    } else {
      console.log(`  Warning: oldText not found in content: "${update.oldText.substring(0, 80)}..."`);
    }
  }

  return { updatedContent, appliedCount };
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  try {
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    const SHOPIFY_STORE_URL = Deno.env.get('SHOPIFY_STORE_URL');
    const SHOPIFY_CLIENT_ID = Deno.env.get('SHOPIFY_CLIENT_ID');
    const SHOPIFY_CLIENT_SECRET = Deno.env.get('SHOPIFY_CLIENT_SECRET');
    const SHOPIFY_BLOG_ID = Deno.env.get('SHOPIFY_BLOG_ID');

    if (
      !OPENAI_API_KEY ||
      !SHOPIFY_STORE_URL ||
      !SHOPIFY_CLIENT_ID ||
      !SHOPIFY_CLIENT_SECRET ||
      !SHOPIFY_BLOG_ID
    ) {
      throw new Error('Missing required environment variables');
    }

    console.log('=== Blog Article Refresher ===');
    console.log(`Current month: ${getCurrentMonthYear()}`);

    // Step 1: Get Shopify access token
    console.log('Step 1: Getting Shopify access token...');
    const accessToken = await getShopifyAccessToken(
      SHOPIFY_STORE_URL,
      SHOPIFY_CLIENT_ID,
      SHOPIFY_CLIENT_SECRET,
    );

    // Step 2: Fetch all articles
    console.log('Step 2: Fetching all articles...');
    const allArticles = await fetchAllArticles(
      SHOPIFY_STORE_URL,
      accessToken,
      SHOPIFY_BLOG_ID,
    );
    console.log(`Found ${allArticles.length} total articles`);

    // Step 3: Filter articles that need refresh
    console.log('Step 3: Finding stale articles...');
    const staleArticles: ShopifyArticle[] = [];

    for (const article of allArticles) {
      const extracted = extractMonthYear(article.title);
      if (!extracted) continue; // Not a month-based article

      if (!isArticleStale(extracted.month, extracted.year)) {
        continue; // Still current
      }

      if (isArticleTooRecent(article.published_at)) {
        console.log(`  Skipping "${article.title}" — published less than ${MIN_AGE_DAYS} days ago`);
        continue;
      }

      staleArticles.push(article);
      console.log(`  Stale: "${article.title}" (${extracted.month} ${extracted.year})`);
    }

    console.log(`Found ${staleArticles.length} stale articles`);

    if (staleArticles.length === 0) {
      console.log('No articles need refreshing');
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No stale articles found',
          refreshed: 0,
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    }

    // Step 4: Refresh up to MAX_ARTICLES_PER_RUN
    const toRefresh = staleArticles.slice(0, MAX_ARTICLES_PER_RUN);
    console.log(`Step 4: Refreshing ${toRefresh.length} articles (max ${MAX_ARTICLES_PER_RUN} per run)...`);

    const currentMonthYear = getCurrentMonthYear();
    const refreshed: RefreshSummary[] = [];
    const errors: Array<{ articleId: number; title: string; error: string }> = [];

    for (const article of toRefresh) {
      const extracted = extractMonthYear(article.title)!;
      const oldMonthYear = `${extracted.month} ${extracted.year}`;

      console.log(`\nRefreshing article ${article.id}: "${article.title}"`);
      console.log(`  From: ${oldMonthYear} -> To: ${currentMonthYear}`);

      try {
        // Call GPT-4o for targeted updates
        const gptResult = await callGPTForRefresh(
          OPENAI_API_KEY,
          article.title,
          article.body_html || '',
          oldMonthYear,
          currentMonthYear,
        );

        console.log(`  GPT returned ${gptResult.updatedSections.length} section updates`);
        console.log(`  New title: "${gptResult.title}"`);

        // Apply content updates via string replacement
        const { updatedContent, appliedCount } = applyContentUpdates(
          article.body_html || '',
          gptResult.updatedSections,
        );

        console.log(`  Applied ${appliedCount}/${gptResult.updatedSections.length} replacements`);

        // Also do a blanket find-and-replace for any remaining old month/year references
        let finalContent = updatedContent;
        if (finalContent.includes(oldMonthYear)) {
          const remaining = (finalContent.match(new RegExp(oldMonthYear.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
          console.log(`  Blanket replacing ${remaining} remaining "${oldMonthYear}" references`);
          finalContent = finalContent.split(oldMonthYear).join(currentMonthYear);
        }

        // Update on Shopify
        await updateArticleOnShopify(
          SHOPIFY_STORE_URL,
          accessToken,
          SHOPIFY_BLOG_ID,
          article.id,
          gptResult.title,
          finalContent,
        );

        refreshed.push({
          articleId: article.id,
          oldTitle: article.title,
          newTitle: gptResult.title,
          sectionsUpdated: appliedCount,
        });

        console.log(`  Done refreshing article ${article.id}`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`  Error refreshing article ${article.id}: ${errorMsg}`);
        errors.push({
          articleId: article.id,
          title: article.title,
          error: errorMsg,
        });
      }
    }

    // Step 5: Return summary
    const summary = {
      success: true,
      currentMonth: currentMonthYear,
      totalArticles: allArticles.length,
      staleFound: staleArticles.length,
      refreshed: refreshed.length,
      errors: errors.length,
      details: refreshed,
      errorDetails: errors.length > 0 ? errors : undefined,
    };

    console.log('\n=== Refresh Summary ===');
    console.log(`Refreshed: ${refreshed.length}/${toRefresh.length}`);
    console.log(`Errors: ${errors.length}`);
    for (const r of refreshed) {
      console.log(`  "${r.oldTitle}" -> "${r.newTitle}" (${r.sectionsUpdated} sections)`);
    }

    return new Response(JSON.stringify(summary, null, 2), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Blog Article Refresher failed: ${errorMsg}`);
    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 },
    );
  }
});
