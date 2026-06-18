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

interface ArticleKeywords {
  id: number;
  title: string;
  handle: string;
  keywords: string[];
}

interface LinkSuggestion {
  anchorText: string;
  handle: string;
  surroundingContext: string;
}

interface ServiceLinkSuggestion {
  anchorText: string;
  targetUrl: string;
  surroundingContext: string;
}

interface LinkChangeLog {
  articleId: number;
  articleTitle: string;
  linksAdded: string[];
  serviceLinksAdded: string[];
  errors: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_ARTICLES_PER_RUN = 5;
const MIN_INTERNAL_LINKS = 3;
const MAX_LINKS_TO_ADD = 3;
const BLOG_PATH_PREFIX = "/blogs/news/";

const SERVICE_PAGES = [
  { url: "/pages/services", keywords: ["shopify development", "shopify developer", "store optimization", "custom theme", "theme development", "shopify expert", "shopify agency", "e-commerce development", "shopify store", "online store development", "custom shopify", "shopify customization"] },
  { url: "/pages/portfolio", keywords: ["portfolio", "our work", "case study", "case studies", "projects", "client work", "examples of work"] },
];

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
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
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
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
      console.log("Reached max pagination limit");
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
  bodyHtml: string,
): Promise<void> {
  const url = `https://${storeUrl}/admin/api/2024-10/blogs/${blogId}/articles/${articleId}.json`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        article: {
          id: articleId,
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
  console.log(`  Successfully updated article ${articleId} on Shopify`);
}

// ── Keyword Extraction ─────────────────────────────────────────────────────────

function extractKeywords(title: string, tags: string): string[] {
  const keywords: string[] = [];

  // Extract words from title (remove common stop words)
  const stopWords = new Set([
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "and", "or", "but", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "this", "that", "these",
    "those", "it", "its", "your", "our", "their", "how", "what", "when",
    "where", "why", "which", "who", "whom", "best", "top", "vs", "guide",
    "tips", "ways", "things", "complete", "ultimate",
  ]);

  // Add full title as a keyword phrase (lowercased, cleaned)
  const cleanTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim();
  if (cleanTitle.length > 3) keywords.push(cleanTitle);

  // Extract meaningful multi-word phrases from title (bigrams and trigrams)
  const titleWords = cleanTitle.split(/\s+/).filter((w) => !stopWords.has(w) && w.length > 2);
  for (let i = 0; i < titleWords.length - 1; i++) {
    keywords.push(`${titleWords[i]} ${titleWords[i + 1]}`);
    if (i < titleWords.length - 2) {
      keywords.push(`${titleWords[i]} ${titleWords[i + 1]} ${titleWords[i + 2]}`);
    }
  }
  // Also add individual meaningful words
  for (const w of titleWords) {
    if (w.length > 3) keywords.push(w);
  }

  // Add tags as keywords
  if (tags) {
    const tagList = tags.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
    keywords.push(...tagList);
  }

  // Deduplicate
  return [...new Set(keywords)];
}

// ── Link Analysis ──────────────────────────────────────────────────────────────

function countInternalLinks(bodyHtml: string): number {
  if (!bodyHtml) return 0;
  const regex = /<a\s[^>]*href\s*=\s*['"][^'"]*\/blogs\/news\/[^'"]*['"][^>]*>/gi;
  const matches = bodyHtml.match(regex);
  return matches ? matches.length : 0;
}

function hasLinkToUrl(bodyHtml: string, url: string): boolean {
  if (!bodyHtml) return false;
  return bodyHtml.toLowerCase().includes(`href='${url.toLowerCase()}'`) ||
    bodyHtml.toLowerCase().includes(`href="${url.toLowerCase()}"`) ||
    bodyHtml.toLowerCase().includes(`href='${url.toLowerCase()}'`);
}

function hasLinkToHandle(bodyHtml: string, handle: string): boolean {
  if (!bodyHtml) return false;
  const lowerHtml = bodyHtml.toLowerCase();
  return lowerHtml.includes(`/blogs/news/${handle.toLowerCase()}`);
}

/**
 * Check if a text position is inside an existing <a>, <code>, or <pre> tag.
 * Returns true if the text should NOT be wrapped in a link.
 */
function isInsideProtectedTag(html: string, textPosition: number): boolean {
  // Find the last opening <a, <code, or <pre tag before this position
  // and check if it has been closed
  const protectedTags = ["a", "code", "pre"];

  for (const tag of protectedTags) {
    const openRegex = new RegExp(`<${tag}[\\s>]`, "gi");
    const closeRegex = new RegExp(`</${tag}>`, "gi");

    let lastOpen = -1;
    let lastClose = -1;
    let match: RegExpExecArray | null;

    openRegex.lastIndex = 0;
    while ((match = openRegex.exec(html)) !== null) {
      if (match.index < textPosition) lastOpen = match.index;
      else break;
    }

    closeRegex.lastIndex = 0;
    while ((match = closeRegex.exec(html)) !== null) {
      if (match.index < textPosition) lastClose = match.index;
      else break;
    }

    // If we found an opening tag and it hasn't been closed before our position
    if (lastOpen !== -1 && lastOpen > lastClose) {
      return true;
    }
  }

  return false;
}

// ── Relevance Scoring ──────────────────────────────────────────────────────────

function scoreRelevance(
  articleContent: string,
  candidateKeywords: string[],
): number {
  const contentLower = articleContent.toLowerCase();
  let score = 0;
  for (const keyword of candidateKeywords) {
    if (contentLower.includes(keyword)) {
      // Longer keywords get higher scores (more specific)
      score += keyword.split(" ").length;
    }
  }
  return score;
}

function findBestCandidates(
  article: ShopifyArticle,
  allKeywords: ArticleKeywords[],
  maxCandidates: number,
): ArticleKeywords[] {
  const contentLower = (article.body_html || "").toLowerCase() + " " + article.title.toLowerCase();
  const candidates: Array<{ article: ArticleKeywords; score: number }> = [];

  for (const candidate of allKeywords) {
    // Don't link to self
    if (candidate.id === article.id) continue;
    // Don't suggest if already linked
    if (hasLinkToHandle(article.body_html || "", candidate.handle)) continue;

    const score = scoreRelevance(contentLower, candidate.keywords);
    if (score > 0) {
      candidates.push({ article: candidate, score });
    }
  }

  // Sort by score descending, take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxCandidates).map((c) => c.article);
}

// ── GPT-4o Link Suggestion ─────────────────────────────────────────────────────

async function callGPTForLinkSuggestions(
  openaiApiKey: string,
  bodyHtml: string,
  candidates: ArticleKeywords[],
): Promise<LinkSuggestion[]> {
  const contentSnippet = bodyHtml.substring(0, 3000);
  const candidateList = candidates.map((c) => ({
    title: c.title,
    handle: c.handle,
    keywords: c.keywords.slice(0, 5),
  }));

  const systemPrompt = `You are an SEO expert that adds internal links to blog articles. You find natural anchor text positions where internal links can be inserted without disrupting readability. You NEVER invent text — you only use exact text that already exists in the article.`;

  const userPrompt = `Find 2-3 natural places in this article to add internal links to other articles.

ARTICLE HTML (first 3000 chars):
${contentSnippet}

CANDIDATE ARTICLES TO LINK TO:
${JSON.stringify(candidateList, null, 2)}

INSTRUCTIONS:
1. Find exact text phrases in the article that naturally relate to a candidate article
2. The anchor text should be 2-6 words, naturally occurring in the article
3. Do NOT pick text that is already inside an <a> tag
4. Do NOT pick text inside <code> or <pre> blocks
5. Prefer anchor text in the middle or later part of the article (not the first paragraph)
6. Each candidate article should be linked at most once
7. The anchor text MUST be an exact substring of the article content

Return ONLY valid JSON array (no markdown, no code fences):
[{"anchorText": "exact text from article", "handle": "target-article-handle", "surroundingContext": "...20 words before ANCHOR_TEXT 20 words after..."}]

If you cannot find good natural anchor text for any candidate, return fewer items or an empty array [].`;

  const response = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1500,
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
  if (!raw) throw new Error("Empty GPT response for link suggestions");

  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log(`  Warning: Could not parse GPT link JSON: ${cleaned.substring(0, 200)}`);
    return [];
  }

  const suggestions: LinkSuggestion[] = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(suggestions)) return [];

  // Validate each suggestion
  return suggestions.filter((s) => s.anchorText && s.handle && typeof s.anchorText === "string" && typeof s.handle === "string");
}

async function callGPTForServiceLink(
  openaiApiKey: string,
  bodyHtml: string,
): Promise<ServiceLinkSuggestion | null> {
  const contentSnippet = bodyHtml.substring(0, 3000);

  const systemPrompt = `You are an SEO expert. You find a natural place in a blog article to add a single link to a service page. You NEVER invent text — you only use exact text that already exists in the article.`;

  const userPrompt = `Find ONE natural place in this article to add a link to a service/portfolio page.

ARTICLE HTML (first 3000 chars):
${contentSnippet}

TARGET PAGES:
- /pages/services — link to this when the article mentions: Shopify development, store optimization, custom theme, theme development, e-commerce solutions, Shopify experts, or similar
- /pages/portfolio — link to this when the article mentions: examples, case studies, client results, our work, proven results, or similar

INSTRUCTIONS:
1. Find exact text (2-6 words) in the article that naturally relates to one of the target pages
2. The anchor text MUST be an exact substring of the article content
3. Do NOT pick text inside existing <a>, <code>, or <pre> tags
4. Prefer /pages/services over /pages/portfolio
5. Only suggest if there's a genuinely natural fit

Return ONLY valid JSON (no markdown, no code fences):
{"anchorText": "exact text from article", "targetUrl": "/pages/services", "surroundingContext": "...context..."}

If no natural fit exists, return: null`;

  const response = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
    },
    60000,
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error (service link): ${response.status} ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  if (cleaned === "null" || cleaned === "{}") return null;

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const suggestion: ServiceLinkSuggestion = JSON.parse(jsonMatch[0]);
  if (!suggestion.anchorText || !suggestion.targetUrl) return null;

  return suggestion;
}

// ── Link Insertion ─────────────────────────────────────────────────────────────

function insertLink(
  bodyHtml: string,
  anchorText: string,
  href: string,
): { html: string; inserted: boolean } {
  // Find first occurrence of anchorText
  const index = bodyHtml.indexOf(anchorText);
  if (index === -1) {
    // Try case-insensitive search
    const lowerHtml = bodyHtml.toLowerCase();
    const lowerAnchor = anchorText.toLowerCase();
    const lowerIndex = lowerHtml.indexOf(lowerAnchor);
    if (lowerIndex === -1) {
      return { html: bodyHtml, inserted: false };
    }
    // Use the original casing from the HTML
    const originalText = bodyHtml.substring(lowerIndex, lowerIndex + anchorText.length);
    if (isInsideProtectedTag(bodyHtml, lowerIndex)) {
      return { html: bodyHtml, inserted: false };
    }
    const link = `<a href='${href}'>${originalText}</a>`;
    const newHtml = bodyHtml.substring(0, lowerIndex) + link + bodyHtml.substring(lowerIndex + anchorText.length);
    return { html: newHtml, inserted: true };
  }

  // Check if inside protected tag
  if (isInsideProtectedTag(bodyHtml, index)) {
    return { html: bodyHtml, inserted: false };
  }

  const link = `<a href='${href}'>${anchorText}</a>`;
  const newHtml = bodyHtml.substring(0, index) + link + bodyHtml.substring(index + anchorText.length);
  return { html: newHtml, inserted: true };
}

// ── Reverse Linking (older articles -> newer) ──────────────────────────────────

function findMentionInArticle(
  bodyHtml: string,
  targetKeywords: string[],
): string | null {
  if (!bodyHtml) return null;
  const lowerHtml = bodyHtml.toLowerCase();

  // Try longer (more specific) keywords first
  const sorted = [...targetKeywords].sort((a, b) => b.length - a.length);

  for (const keyword of sorted) {
    if (keyword.length < 4) continue; // Skip very short keywords
    const index = lowerHtml.indexOf(keyword);
    if (index !== -1) {
      // Return the original-cased version
      const originalText = bodyHtml.substring(index, index + keyword.length);
      if (!isInsideProtectedTag(bodyHtml, index)) {
        return originalText;
      }
    }
  }
  return null;
}

// ── Main Handler ───────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const SHOPIFY_STORE_URL = Deno.env.get("SHOPIFY_STORE_URL");
    const SHOPIFY_CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID");
    const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET");
    const SHOPIFY_BLOG_ID = Deno.env.get("SHOPIFY_BLOG_ID");

    if (
      !OPENAI_API_KEY ||
      !SHOPIFY_STORE_URL ||
      !SHOPIFY_CLIENT_ID ||
      !SHOPIFY_CLIENT_SECRET ||
      !SHOPIFY_BLOG_ID
    ) {
      throw new Error("Missing required environment variables");
    }

    console.log("=== Blog Internal Linker ===");

    // Step 1: Get Shopify access token
    console.log("Step 1: Getting Shopify access token...");
    const accessToken = await getShopifyAccessToken(
      SHOPIFY_STORE_URL,
      SHOPIFY_CLIENT_ID,
      SHOPIFY_CLIENT_SECRET,
    );

    // Step 2: Fetch all articles
    console.log("Step 2: Fetching all articles...");
    const allArticles = await fetchAllArticles(
      SHOPIFY_STORE_URL,
      accessToken,
      SHOPIFY_BLOG_ID,
    );
    console.log(`Found ${allArticles.length} total articles`);

    if (allArticles.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No articles found", changes: [] }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    }

    // Step 3: Build keyword map for ALL articles
    console.log("Step 3: Building keyword map...");
    const allKeywords: ArticleKeywords[] = allArticles.map((a) => ({
      id: a.id,
      title: a.title,
      handle: a.handle,
      keywords: extractKeywords(a.title, a.tags),
    }));

    // Step 4: Sort by published_at descending (most recent first)
    const sortedArticles = [...allArticles].sort(
      (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
    );

    // Step 5: Find articles that need more internal links
    console.log("Step 4: Finding articles that need internal links...");
    const articlesNeedingLinks: ShopifyArticle[] = [];

    for (const article of sortedArticles) {
      if (articlesNeedingLinks.length >= MAX_ARTICLES_PER_RUN) break;
      const internalLinkCount = countInternalLinks(article.body_html || "");
      if (internalLinkCount < MIN_INTERNAL_LINKS) {
        articlesNeedingLinks.push(article);
        console.log(`  Needs links: "${article.title}" (has ${internalLinkCount} internal links)`);
      }
    }

    console.log(`Found ${articlesNeedingLinks.length} articles needing internal links`);

    // Step 6: Process each article — add internal links + service page links
    console.log("Step 5: Processing articles...");
    const changeLogs: LinkChangeLog[] = [];

    for (const article of articlesNeedingLinks) {
      const changeLog: LinkChangeLog = {
        articleId: article.id,
        articleTitle: article.title,
        linksAdded: [],
        serviceLinksAdded: [],
        errors: [],
      };

      console.log(`\nProcessing: "${article.title}" (ID: ${article.id})`);

      let currentHtml = article.body_html || "";

      // ── 6a: Find candidate articles and get GPT suggestions ──

      try {
        const candidates = findBestCandidates(article, allKeywords, 5);
        console.log(`  Found ${candidates.length} candidate articles to link to`);

        if (candidates.length > 0) {
          const suggestions = await callGPTForLinkSuggestions(
            OPENAI_API_KEY,
            currentHtml,
            candidates,
          );
          console.log(`  GPT suggested ${suggestions.length} links`);

          let linksInserted = 0;
          for (const suggestion of suggestions) {
            if (linksInserted >= MAX_LINKS_TO_ADD) break;

            const href = `${BLOG_PATH_PREFIX}${suggestion.handle}`;

            // Check if this link already exists
            if (hasLinkToHandle(currentHtml, suggestion.handle)) {
              console.log(`    Skip: already has link to ${suggestion.handle}`);
              continue;
            }

            const result = insertLink(currentHtml, suggestion.anchorText, href);
            if (result.inserted) {
              currentHtml = result.html;
              linksInserted++;
              const logMsg = `"${suggestion.anchorText}" -> ${href}`;
              changeLog.linksAdded.push(logMsg);
              console.log(`    Inserted: ${logMsg}`);
            } else {
              console.log(`    Failed to insert: "${suggestion.anchorText}" (not found or inside protected tag)`);
              changeLog.errors.push(`Could not insert anchor "${suggestion.anchorText}" for ${suggestion.handle}`);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error getting link suggestions: ${msg}`);
        changeLog.errors.push(`Link suggestion error: ${msg}`);
      }

      // ── 6b: Add service page link if missing ──

      try {
        const hasServicesLink = SERVICE_PAGES.some((sp) => hasLinkToUrl(currentHtml, sp.url));
        if (!hasServicesLink) {
          console.log("  Checking for service page link opportunity...");
          const serviceSuggestion = await callGPTForServiceLink(OPENAI_API_KEY, currentHtml);

          if (serviceSuggestion) {
            const result = insertLink(currentHtml, serviceSuggestion.anchorText, serviceSuggestion.targetUrl);
            if (result.inserted) {
              currentHtml = result.html;
              const logMsg = `"${serviceSuggestion.anchorText}" -> ${serviceSuggestion.targetUrl}`;
              changeLog.serviceLinksAdded.push(logMsg);
              console.log(`    Service link inserted: ${logMsg}`);
            } else {
              console.log(`    Failed to insert service link: "${serviceSuggestion.anchorText}"`);
              changeLog.errors.push(`Could not insert service link anchor "${serviceSuggestion.anchorText}"`);
            }
          } else {
            console.log("    No natural service page link found");
          }
        } else {
          console.log("  Already has service/portfolio link, skipping");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error getting service link suggestion: ${msg}`);
        changeLog.errors.push(`Service link error: ${msg}`);
      }

      // ── 6c: Update article on Shopify if changes were made ──

      const totalChanges = changeLog.linksAdded.length + changeLog.serviceLinksAdded.length;
      if (totalChanges > 0) {
        try {
          await updateArticleOnShopify(
            SHOPIFY_STORE_URL,
            accessToken,
            SHOPIFY_BLOG_ID,
            article.id,
            currentHtml,
          );
          console.log(`  Updated article with ${totalChanges} new links`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  Failed to update article: ${msg}`);
          changeLog.errors.push(`Shopify update error: ${msg}`);
        }
      } else {
        console.log("  No links inserted, skipping Shopify update");
      }

      changeLogs.push(changeLog);
    }

    // Step 7: Reverse linking — add links FROM older articles TO the newest articles
    console.log("\nStep 6: Reverse linking (older -> newer)...");

    const newestArticles = sortedArticles.slice(0, 5);
    const olderArticles = sortedArticles.slice(5);
    let reverseLinksAdded = 0;

    for (const newArticle of newestArticles) {
      const newArticleKeywords = allKeywords.find((k) => k.id === newArticle.id);
      if (!newArticleKeywords || newArticleKeywords.keywords.length === 0) continue;

      // Check up to 20 older articles for mentions of the new article's topic
      const olderToCheck = olderArticles.slice(0, 20);

      for (const oldArticle of olderToCheck) {
        // Skip if already linked
        if (hasLinkToHandle(oldArticle.body_html || "", newArticle.handle)) continue;

        // Find a mention of the new article's keywords in the old article
        const mention = findMentionInArticle(oldArticle.body_html || "", newArticleKeywords.keywords);
        if (!mention) continue;

        const href = `${BLOG_PATH_PREFIX}${newArticle.handle}`;
        const result = insertLink(oldArticle.body_html || "", mention, href);

        if (result.inserted) {
          try {
            await updateArticleOnShopify(
              SHOPIFY_STORE_URL,
              accessToken,
              SHOPIFY_BLOG_ID,
              oldArticle.id,
              result.html,
            );
            // Update the in-memory body_html so subsequent checks don't add duplicates
            oldArticle.body_html = result.html;
            reverseLinksAdded++;
            console.log(`  Reverse link: "${oldArticle.title}" -> "${newArticle.title}" (anchor: "${mention}")`);

            // Also log in changeLogs
            changeLogs.push({
              articleId: oldArticle.id,
              articleTitle: oldArticle.title,
              linksAdded: [`"${mention}" -> ${href} (reverse link)`],
              serviceLinksAdded: [],
              errors: [],
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  Reverse link update failed for article ${oldArticle.id}: ${msg}`);
          }
        }
      }
    }

    console.log(`Reverse links added: ${reverseLinksAdded}`);

    // Step 8: Summary
    const totalLinksAdded = changeLogs.reduce((sum, cl) => sum + cl.linksAdded.length, 0);
    const totalServiceLinks = changeLogs.reduce((sum, cl) => sum + cl.serviceLinksAdded.length, 0);
    const totalErrors = changeLogs.reduce((sum, cl) => sum + cl.errors.length, 0);

    const summary = {
      success: true,
      totalArticles: allArticles.length,
      articlesProcessed: articlesNeedingLinks.length,
      internalLinksAdded: totalLinksAdded,
      serviceLinksAdded: totalServiceLinks,
      reverseLinksAdded,
      errors: totalErrors,
      details: changeLogs.filter((cl) => cl.linksAdded.length > 0 || cl.serviceLinksAdded.length > 0 || cl.errors.length > 0),
    };

    console.log("\n=== Internal Linker Summary ===");
    console.log(`Articles processed: ${articlesNeedingLinks.length}`);
    console.log(`Internal links added: ${totalLinksAdded}`);
    console.log(`Service links added: ${totalServiceLinks}`);
    console.log(`Reverse links added: ${reverseLinksAdded}`);
    console.log(`Errors: ${totalErrors}`);

    return new Response(JSON.stringify(summary, null, 2), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Blog Internal Linker failed: ${errorMsg}`);
    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    );
  }
});
