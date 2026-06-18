import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Fetch with timeout to prevent hanging on slow APIs
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

type ContentFormat = 'listicle' | 'comparison' | 'evergreen-guide' | 'technical';

interface ContentCategory {
  name: string;
  format: ContentFormat;
  titlePattern: string;
  minWordCount: number;
  requiresMonthYear: boolean;
  targetNextMonth: boolean;
}

interface BlogPost {
  title: string;
  content: string;
  metaDescription: string;
  imageUrl: string;
  keywords: string[];
  altText: string;
  excerpt: string;
  internalLinks: string[];
  readingTime: number;
  relatedPosts: Array<{title: string; url: string}>;
}

interface ShopifyTokenResponse {
  access_token: string;
  expires_in: number;
}

interface ShopifyArticle {
  id: number;
  title: string;
  handle: string;
  tags: string;
}

interface ContentPlan {
  id: number;
  week_start: string;
  day_index: number;
  scheduled_date: string;
  topic: string;
  category: string;
  content_format: ContentFormat;
  target_word_count: number;
  keywords: string[];
  status: string;
  article_id: number | null;
  article_url: string | null;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

// 7 content categories — targeted at the agency's ICP: owners/managers of
// established Shopify stores (the people who actually HIRE agencies).
// 1 problem-listicle (Mon) + 2 comparison (Tue/Sat) + 3 evergreen (Wed/Thu/Fri) + 1 technical (Sun)
const CONTENT_CATEGORIES: ContentCategory[] = [
  { name: 'Store Problems & Fixes',        format: 'listicle',        titlePattern: 'X Reasons Your Shopify Store [Has Problem] (And How to Fix Each)', minWordCount: 2200, requiresMonthYear: false, targetNextMonth: false },
  { name: 'Apps & Tools for Scaling Stores', format: 'comparison',    titlePattern: 'X vs Y: Which Is Better for Your Shopify Store in [Year]?', minWordCount: 2000, requiresMonthYear: false, targetNextMonth: false },
  { name: 'Migration & Replatforming',     format: 'evergreen-guide', titlePattern: 'How to Migrate from [Platform] to Shopify: Complete [Year] Guide', minWordCount: 2200, requiresMonthYear: false, targetNextMonth: false },
  { name: 'CRO & Revenue Optimization',    format: 'evergreen-guide', titlePattern: 'How to [Improve Revenue Metric] on Shopify: [Year] Guide', minWordCount: 2000, requiresMonthYear: false, targetNextMonth: false },
  { name: 'Hiring & Agency Decisions',     format: 'evergreen-guide', titlePattern: '[Cost / How to Choose / X vs Y]: Hiring Shopify Help in [Year]', minWordCount: 2000, requiresMonthYear: false, targetNextMonth: false },
  { name: 'Platform & Plan Decisions',     format: 'comparison',      titlePattern: 'X vs Y for [Growing Store Type] ([Year] Comparison)',  minWordCount: 2000, requiresMonthYear: false, targetNextMonth: false },
  { name: 'Technical Shopify Guide',       format: 'technical',       titlePattern: 'How to [Technical Task] on Shopify in [Year]',     minWordCount: 1800, requiresMonthYear: false, targetNextMonth: false },
];

// Strict ICP definition — injected into every topic-generation prompt.
// This is THE filter that keeps the blog aimed at people who hire agencies,
// not consumers (skincare/gadget listicles attracted shoppers, 0 leads in 6 months).
const ICP_CONTEXT = `TARGET READER (STRICT): owners, founders and ecommerce managers of ESTABLISHED Shopify / DTC brands (~$10k-$500k+/month revenue) — the people who HIRE Shopify agencies for development, migration, speed and CRO work.
THEY SEARCH FOR: fixing low conversion rates, slow store speed, theme customization/redesign, replatforming to Shopify (from WooCommerce/Magento/Wix/Squarespace), Shopify Plus upgrade decisions, hiring developers vs agencies vs freelancers, consolidating app bloat, scaling operations, checkout optimization.
STRICTLY FORBIDDEN (these attracted consumers who never hire agencies): "trending products to buy" lists, dropshipping product roundups, gadget/skincare/pet/wellness shopping guides, consumer lifestyle comparisons (cars, phones), "what to sell" content for beginners with no store.
LITMUS TEST for every topic: "Would the owner of a revenue-generating Shopify store search this when facing a problem worth paying $3,000+ to solve?" If not — REJECT the topic.`;

function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function getTargetMonthYear(targetNextMonth: boolean): string {
  const now = new Date();
  if (targetNextMonth && now.getDate() >= 20) {
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return `${next.toLocaleString('en-US', { month: 'long' })} ${next.getFullYear()}`;
  }
  return `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;
}

function getCategoryForDay(dayIndex: number): ContentCategory {
  return CONTENT_CATEGORIES[dayIndex % 7];
}

function getSupabaseClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

async function getTodayPlan(supabase: ReturnType<typeof createClient>): Promise<ContentPlan | null> {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('blog_content_plan')
    .select('*')
    .eq('scheduled_date', today)
    .eq('status', 'planned')
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as ContentPlan;
}

async function isTodayAlreadyPublished(supabase: ReturnType<typeof createClient>): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];
  const { count } = await supabase
    .from('blog_content_plan')
    .select('*', { count: 'exact', head: true })
    .eq('scheduled_date', today)
    .eq('status', 'published');
  return (count ?? 0) > 0;
}

async function getWeekPlanExists(supabase: ReturnType<typeof createClient>, weekStart: string): Promise<boolean> {
  const { count } = await supabase
    .from('blog_content_plan')
    .select('*', { count: 'exact', head: true })
    .eq('week_start', weekStart);
  return (count ?? 0) > 0;
}

async function getPastPlanTopics(supabase: ReturnType<typeof createClient>): Promise<string[]> {
  const { data } = await supabase
    .from('blog_content_plan')
    .select('topic')
    .order('scheduled_date', { ascending: false })
    .limit(100);
  return (data || []).map((r: any) => r.topic);
}

async function generateWeeklyPlan(
  perplexityApiKey: string,
  existingArticles: ShopifyArticle[],
  weekStart: string,
  pastPlanTopics: string[]
): Promise<Array<{ topic: string; category: string; format: ContentFormat; keywords: string[] }>> {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
  const currentDate = new Date().toISOString().split('T')[0];
  const existingTopics = existingArticles.slice(0, 30).map(a => `- "${a.title}"`).join('\n');
  const pastTopics = pastPlanTopics.map(t => `- "${t}"`).join('\n');

  // Build format-aware category descriptions
  const categoryDescriptions = CONTENT_CATEGORIES.map((cat, i) => {
    const dayName = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i];
    const monthTarget = cat.requiresMonthYear ? getTargetMonthYear(cat.targetNextMonth) : '';
    let formatInstructions = '';
    switch (cat.format) {
      case 'listicle':
        formatInstructions = `FORMAT: Listicle — title MUST follow pattern "${cat.titlePattern}"\n    Topic must be a problem/diagnosis list a STORE OWNER searches when something is wrong (lost sales, slow speed, cart abandonment, low conversion) — every item is a cause + fix${monthTarget ? `\n    Title MUST include "${monthTarget}"` : ''}`;
        break;
      case 'comparison':
        formatInstructions = `FORMAT: Comparison — title MUST follow pattern "${cat.titlePattern}"\n    Compare two specific tools/platforms/approaches head-to-head, from the perspective of a store OWNER deciding what to pay for`;
        break;
      case 'evergreen-guide':
        formatInstructions = `FORMAT: Evergreen Guide — title MUST follow pattern "${cat.titlePattern}"\n    Use seasonal framing (e.g., "Spring ${currentYear}") rather than specific month`;
        break;
      case 'technical':
        formatInstructions = `FORMAT: Technical Guide — title MUST follow pattern "${cat.titlePattern}"\n    Deep dive into a specific Shopify technical topic`;
        break;
    }
    return `${i + 1}. ${dayName}: ${cat.name}\n    ${formatInstructions}`;
  }).join('\n\n');

  const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${perplexityApiKey}` },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: `You are an expert SEO content strategist for MILEDEVS — a Shopify Select Partner agency that sells development, migration, speed optimization and CRO services. TODAY: ${currentDate}, YEAR: ${currentYear}. You plan weekly content calendars that attract POTENTIAL AGENCY CLIENTS and that AI chatbots (ChatGPT, Perplexity) will cite when store owners ask for help.

${ICP_CONTEXT}` },
        { role: 'user', content: `Create a 7-day content plan for the week starting ${weekStart}. Each day has a SPECIFIC FORMAT and CATEGORY.

THE 7 DAYS (follow format instructions EXACTLY):

${categoryDescriptions}

CRITICAL RULES:
- EVERY topic must target the ICP defined above (Shopify STORE OWNERS with budgets) — apply the litmus test to each one
- Each topic MUST be about something store owners are ACTIVELY searching for RIGHT NOW in ${currentMonth} ${currentYear}
- Topics MUST be for ${currentYear} (NOT older years)
- PRIORITIZE commercial/bottom-funnel intent: "migrate", "fix", "cost", "hire", "agency", "speed up", "increase conversion" beat informational fluff
- COMPARISON topics must compare SPECIFIC named tools/platforms (e.g., "Klaviyo vs Omnisend" not "email marketing tools") that PAYING store owners evaluate
- Each topic should be specific and actionable, not vague
- Include 3-4 SEO keywords per topic

ALREADY PUBLISHED ARTICLES (DO NOT repeat these or similar topics):
${existingTopics || 'None'}

PREVIOUSLY PLANNED TOPICS (DO NOT repeat these or similar topics — find FRESH angles):
${pastTopics || 'None'}

Return ONLY valid JSON array with exactly 7 items:
[{"topic": "Specific Topic Title (50-60 chars)", "category": "Category Name", "format": "listicle|comparison|evergreen-guide|technical", "keywords": ["kw1", "kw2", "kw3"]}, ...]` }
      ],
      temperature: 0.8,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    console.error(`Perplexity weekly plan error: ${response.status}`);
    throw new Error('Failed to generate weekly plan from Perplexity');
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty Perplexity response for weekly plan');

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Failed to parse weekly plan JSON: ${content.substring(0, 200)}`);

  const plan = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(plan) || plan.length < 7) throw new Error(`Weekly plan has ${plan.length} items, expected 7`);

  // Post-generation similarity check: reject topics too similar to past ones
  const allPastTopics = [
    ...existingArticles.map(a => a.title.toLowerCase()),
    ...pastPlanTopics.map(t => t.toLowerCase()),
  ];

  const validatedPlan = plan.slice(0, 7).map((item: any, i: number) => {
    const cat = getCategoryForDay(i);
    let topic = String(item.topic || '').substring(0, 200);
    const isTooSimilar = allPastTopics.some(past => computeSimilarity(past, topic.toLowerCase()) > 0.5);
    if (isTooSimilar) {
      topic = `${topic} — ${currentMonth} ${currentYear} Edition`;
      console.log(`Topic #${i} was too similar, modified to: "${topic}"`);
    }
    // Enforce month+year in title for listicle categories
    if (cat.requiresMonthYear) {
      const targetMonth = getTargetMonthYear(cat.targetNextMonth);
      if (!topic.toLowerCase().includes(targetMonth.toLowerCase())) {
        topic = `${topic} for ${targetMonth}`;
        console.log(`Topic #${i}: forced month+year → "${topic}"`);
      }
    }
    return {
      topic,
      category: item.category || cat.name,
      format: (item.format as ContentFormat) || cat.format,
      keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
    };
  });

  return validatedPlan;
}

async function saveWeeklyPlan(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  plan: Array<{ topic: string; category: string; format: ContentFormat; keywords: string[] }>
): Promise<void> {
  const weekStartDate = new Date(weekStart);
  const rows = plan.map((item, i) => {
    const cat = getCategoryForDay(i);
    const scheduledDate = new Date(weekStartDate);
    scheduledDate.setDate(scheduledDate.getDate() + i);
    return {
      week_start: weekStart,
      day_index: i,
      scheduled_date: scheduledDate.toISOString().split('T')[0],
      topic: item.topic,
      category: item.category,
      content_format: item.format || cat.format,
      target_word_count: cat.minWordCount,
      keywords: item.keywords,
      status: 'planned',
    };
  });

  const { error } = await supabase.from('blog_content_plan').insert(rows);
  if (error) throw new Error(`Failed to save weekly plan: ${error.message}`);
  console.log(`Saved weekly plan: ${rows.map(r => `${r.scheduled_date}: ${r.topic}`).join(' | ')}`);
}

async function markPlanPublished(
  supabase: ReturnType<typeof createClient>,
  planId: number,
  articleId: number,
  articleUrl: string
): Promise<void> {
  const { error } = await supabase
    .from('blog_content_plan')
    .update({
      status: 'published',
      article_id: articleId,
      article_url: articleUrl,
      published_at: new Date().toISOString(),
      image_status: 'pending',
      image_attempts: 0,
    })
    .eq('id', planId);
  if (error) console.error(`Failed to mark plan published: ${error.message}`);
}

Deno.serve(async (req: Request) => {
  try {
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY');
    const SHOPIFY_STORE_URL = Deno.env.get('SHOPIFY_STORE_URL');
    const SHOPIFY_CLIENT_ID = Deno.env.get('SHOPIFY_CLIENT_ID');
    const SHOPIFY_CLIENT_SECRET = Deno.env.get('SHOPIFY_CLIENT_SECRET');
    const SHOPIFY_BLOG_ID = Deno.env.get('SHOPIFY_BLOG_ID');

    if (!OPENAI_API_KEY || !PERPLEXITY_API_KEY || !SHOPIFY_STORE_URL || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_BLOG_ID) {
      throw new Error('Missing required environment variables');
    }

    const supabase = getSupabaseClient();

    console.log('Step 0: Getting Shopify access token...');
    const shopifyAccessToken = await getShopifyAccessToken(SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET);

    console.log('Step 0.5: Fetching existing articles...');
    const existingArticles = await getExistingArticles(SHOPIFY_STORE_URL, shopifyAccessToken, SHOPIFY_BLOG_ID);
    console.log(`Found ${existingArticles.length} existing articles`);

    // --- Weekly Content Plan ---
    const today = new Date();
    const weekStart = getWeekStart(today);
    console.log(`Week start: ${weekStart}`);

    // Generate weekly plan if none exists for this week
    const planExists = await getWeekPlanExists(supabase, weekStart);
    if (!planExists) {
      console.log('No plan for this week — generating 7-day content plan...');
      const pastPlanTopics = await getPastPlanTopics(supabase);
      console.log(`Found ${pastPlanTopics.length} past plan topics to avoid`);
      const plan = await generateWeeklyPlan(PERPLEXITY_API_KEY, existingArticles, weekStart, pastPlanTopics);
      await saveWeeklyPlan(supabase, weekStart, plan);
      console.log('Weekly plan saved!');
    } else {
      console.log('Weekly plan already exists');
    }

    // Check if today already has a published post (prevent duplicates on retry)
    const alreadyPublished = await isTodayAlreadyPublished(supabase);
    if (alreadyPublished) {
      console.log('Today already has a published post — skipping');
      return new Response(JSON.stringify({ success: true, message: 'Already published today, skipping' }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
    }

    // Get today's planned topic
    const todayPlan = await getTodayPlan(supabase);

    let topic: string;
    let keywords: string[];
    let lsiKeywords: string[];
    let searchVolume = 'planned';
    let planId: number | null = null;
    let contentFormat: ContentFormat;
    let targetWordCount: number;

    if (todayPlan) {
      // Determine format from plan or fallback to category config
      const dayCategory = getCategoryForDay(todayPlan.day_index);
      contentFormat = (todayPlan.content_format as ContentFormat) || dayCategory.format;
      targetWordCount = todayPlan.target_word_count || dayCategory.minWordCount;

      console.log(`Today's plan: "${todayPlan.topic}" (${todayPlan.category}) [${contentFormat}, ${targetWordCount} words]`);
      topic = todayPlan.topic;
      keywords = todayPlan.keywords.length > 0 ? todayPlan.keywords : [topic];
      planId = todayPlan.id;

      // Enrich keywords with format-aware GPT
      console.log('Step 1: Enriching planned topic with keyword research...');
      const enriched = await researchKeywordsAndTopic(OPENAI_API_KEY, topic, existingArticles, dayCategory);
      topic = enriched.topic;
      keywords = enriched.keywords;
      lsiKeywords = enriched.lsiKeywords;
      searchVolume = enriched.searchVolume;
    } else {
      // Fallback: no plan for today — determine format from day of week
      const dayOfWeek = new Date().getDay(); // 0=Sun, 1=Mon
      const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Mon=0..Sun=6
      const dayCategory = getCategoryForDay(dayIndex);
      contentFormat = dayCategory.format;
      targetWordCount = dayCategory.minWordCount;

      console.log(`No planned topic — using live discovery [${contentFormat}, ${targetWordCount} words]...`);
      const trendingSuggestion = await getPerplexityTrendingTopic(PERPLEXITY_API_KEY, existingArticles, dayCategory);
      console.log(`Trending suggestion: ${trendingSuggestion}`);

      const researched = await researchKeywordsAndTopic(OPENAI_API_KEY, trendingSuggestion, existingArticles, dayCategory);
      topic = researched.topic;
      keywords = researched.keywords;
      lsiKeywords = researched.lsiKeywords;
      searchVolume = researched.searchVolume;
    }

    console.log(`Topic: ${topic} | Format: ${contentFormat}`);

    // Check title similarity before generating full content
    const existingTitlesLower = existingArticles.map(a => a.title.toLowerCase());
    if (existingTitlesLower.some(t => computeSimilarity(t, topic.toLowerCase()) > 0.6)) {
      console.log(`WARNING: Topic "${topic}" is too similar to existing article. Requesting new topic...`);
      const retry = await researchKeywordsAndTopic(OPENAI_API_KEY, topic + ' (MUST BE COMPLETELY DIFFERENT ANGLE)', existingArticles);
      topic = retry.topic;
      keywords = retry.keywords;
      lsiKeywords = retry.lsiKeywords;
      console.log(`Retry topic: ${topic}`);
    }

    console.log('Step 2: Deep research with Perplexity (real data, no hallucinations)...');
    const research = await researchTopicWithPerplexity(PERPLEXITY_API_KEY, topic, keywords);
    console.log(`Research: ${research.length} chars of real data`);

    console.log(`Step 3: Generating ${targetWordCount}-word ${contentFormat} blog post with real research...`);
    const blogPost = await generateUltraSEOBlogPost(OPENAI_API_KEY, topic, keywords, lsiKeywords, existingArticles, targetWordCount, research, contentFormat);
    console.log(`Generated: ${blogPost.title} (${blogPost.content.split(/\s+/).length} words)`);

    console.log('Step 4: Publishing to Shopify (image will be added separately)...');
    const result = await publishToShopify(SHOPIFY_STORE_URL, shopifyAccessToken, SHOPIFY_BLOG_ID, { ...blogPost, imageUrl: '' });

    const articleUrl = `https://${SHOPIFY_STORE_URL}/blogs/${result.article.blog_id}/${result.article.handle}`;

    // Mark plan as published
    if (planId) {
      await markPlanPublished(supabase, planId, result.article.id, articleUrl);
      console.log(`Plan #${planId} marked as published`);
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'SEO-optimized blog post published!',
      data: {
        topic, keywords, lsiKeywords, searchVolume,
        planId, contentFormat,
        title: blogPost.title,
        wordCount: blogPost.content.split(/\s+/).length,
        targetWordCount,
        readingTime: blogPost.readingTime,
        internalLinksCount: blogPost.internalLinks.length,
        relatedPostsCount: blogPost.relatedPosts.length,
        imageStatus: 'pending (separate function)',
        shopifyArticleId: result.article.id,
        shopifyArticleUrl: articleUrl
      }
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message, stack: error.stack }), { headers: { 'Content-Type': 'application/json' }, status: 500 });
  }
});

// Simple word-overlap similarity (0 to 1)
function computeSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

async function getShopifyAccessToken(storeUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.token;
  const tokenUrl = `https://${storeUrl}/admin/oauth/access_token`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get token: ${response.status} ${errText}`);
  }
  const data: ShopifyTokenResponse = await response.json();
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in - 3600) * 1000 };
  return data.access_token;
}

async function getExistingArticles(storeUrl: string, accessToken: string, blogId: string): Promise<ShopifyArticle[]> {
  let allArticles: ShopifyArticle[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const articlesUrl = `https://${storeUrl}/admin/api/2024-10/blogs/${blogId}/articles.json?limit=250&page=${page}`;
    const response = await fetch(articlesUrl, {
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }
    });
    if (!response.ok) { console.error(`Failed to fetch articles page ${page}`); break; }
    const data = await response.json();
    const articles = data.articles || [];
    if (articles.length === 0) { hasMore = false; } else {
      allArticles = allArticles.concat(articles);
      console.log(`Fetched page ${page}: ${articles.length} articles (total: ${allArticles.length})`);
      if (articles.length < 250) hasMore = false; else page++;
    }
    if (page > 20) { console.log('Reached max pagination limit'); break; }
  }
  return allArticles;
}

async function getPerplexityTrendingTopic(apiKey: string, existingArticles: ShopifyArticle[], category?: ContentCategory): Promise<string> {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
  const currentDate = new Date().toISOString().split('T')[0];
  const existingTopics = existingArticles.slice(0, 30).map(a => `- "${a.title}"`).join('\n');

  // Format-specific topic guidance
  let formatGuidance = 'Find ONE topic that Shopify STORE OWNERS are ACTIVELY SEARCHING FOR RIGHT NOW when they have a problem worth paying to solve.';
  if (category) {
    switch (category.format) {
      case 'listicle':
        formatGuidance = `Find ONE problem-diagnosis listicle topic for the "${category.name}" category. It must be a list a STORE OWNER searches when something is wrong with their store. Example: "9 Reasons Your Shopify Store Has Traffic But No Sales (And How to Fix Each)"`;
        break;
      case 'comparison':
        formatGuidance = `Find ONE head-to-head comparison topic for the "${category.name}" category. Compare two SPECIFIC named tools, platforms, or approaches. Pattern: "X vs Y: Which Is Better in ${currentYear}?"`;
        break;
      case 'evergreen-guide':
        formatGuidance = `Find ONE evergreen guide topic for the "${category.name}" category. Use seasonal framing (e.g., "Spring ${currentYear}"). Pattern: "How to [Achieve Goal]: Complete Guide"`;
        break;
      case 'technical':
        formatGuidance = `Find ONE specific technical Shopify topic for ${currentYear}. Deep dive into Liquid, APIs, theme development, or integrations.`;
        break;
    }
  }

  const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: `You are an expert SEO researcher for a Shopify agency that sells development, migration, speed and CRO services. TODAY'S DATE: ${currentDate}, CURRENT YEAR: ${currentYear}, CURRENT MONTH: ${currentMonth} ${currentYear}

${ICP_CONTEXT}` },
        { role: 'user', content: `${formatGuidance}

CRITICAL RULES:
- Topic MUST be for ${currentYear} (NOT ${currentYear - 1} or older)
- Topic MUST be COMPLETELY DIFFERENT from these existing articles:
${existingTopics || 'None'}
- Return ONLY the trending topic as a short phrase (60 chars max)
- DO NOT suggest anything about "Best Shopify Apps" or "Top Apps" - we have enough of those` }
      ],
      temperature: 0.9,
      max_tokens: 150
    })
  });

  const fallbackName = category?.name || 'E-commerce';
  if (!response.ok) {
    console.error(`Perplexity API error: ${response.status}`);
    return `${fallbackName} Tips for ${currentMonth} ${currentYear}`;
  }

  const data = await response.json();
  const suggestion = data.choices?.[0]?.message?.content?.trim();
  if (!suggestion) {
    console.error('Empty Perplexity response');
    return `${fallbackName} Tips for ${currentMonth} ${currentYear}`;
  }

  const outdatedYears = [currentYear - 1, currentYear - 2, currentYear - 3];
  if (outdatedYears.some(year => suggestion.includes(String(year)))) {
    console.error(`REJECTED: Contains outdated year: "${suggestion}"`);
    return `${fallbackName} Tips for ${currentMonth} ${currentYear}`;
  }

  return suggestion;
}

async function researchKeywordsAndTopic(apiKey: string, trendingSuggestion: string, existingArticles: ShopifyArticle[], category?: ContentCategory): Promise<{ topic: string; keywords: string[]; lsiKeywords: string[]; searchVolume: string; }> {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
  const existingTopics = existingArticles.slice(0, 30).map(a => `- "${a.title}"`).join('\n');

  // Format-specific title instructions
  let formatRule = '';
  if (category) {
    const monthTarget = category.requiresMonthYear ? getTargetMonthYear(category.targetNextMonth) : '';
    switch (category.format) {
      case 'listicle':
        formatRule = `\nFORMAT: Listicle — title MUST be a numbered problem/fix list for STORE OWNERS${monthTarget ? `. Title MUST include "${monthTarget}"` : ''}. Example: "9 Reasons Your Shopify Store Has Traffic But No Sales (And How to Fix Each)".\nTarget queries from Shopify STORE OWNERS diagnosing a business problem — never consumer shopping queries.`;
        break;
      case 'comparison':
        formatRule = `\nFORMAT: Comparison — title MUST compare two specific named tools/platforms. Pattern: "X vs Y: Which Is Better in ${currentYear}?"`;
        break;
      case 'evergreen-guide':
        formatRule = `\nFORMAT: Evergreen Guide — use seasonal framing (e.g., "Spring ${currentYear}") rather than a specific month. Pattern: "How to [Goal]: Complete Guide for [Season] ${currentYear}"`;
        break;
      case 'technical':
        formatRule = `\nFORMAT: Technical Guide — deep dive into a specific Shopify technical topic for ${currentYear}.`;
        break;
    }
  }

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are an ELITE SEO keyword researcher for a Shopify development agency. Current: ${currentMonth} ${currentYear}. Find HIGH-VOLUME, LOW-COMPETITION keywords with COMMERCIAL INTENT from store owners. Create ${currentYear}-relevant content that AI chatbots (ChatGPT, Perplexity) will cite when store owners ask for help.

${ICP_CONTEXT}` },
        { role: 'user', content: `Create a highly rankable SEO topic based on: "${trendingSuggestion}".
${formatRule}
RULES:
- DO NOT use ${currentYear - 1} or older years
- Topic MUST be COMPLETELY DIFFERENT from these existing articles:
${existingTopics || 'None'}
- If the suggestion is about "apps" or "tools" and there are already similar articles, pick a DIFFERENT angle entirely

Return ONLY valid JSON:
{"topic": "SEO title (60 chars max)", "keywords": ["primary", "secondary", "long-tail", "LSI"], "lsiKeywords": ["term1", "term2", "term3", "term4", "term5"], "searchVolume": "estimated monthly", "intent": "informational/commercial"}` }
      ],
      temperature: 0.9,
      max_tokens: 600
    })
  });
  if (!response.ok) throw new Error(`OpenAI error: ${await response.text()}`);
  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse keyword research JSON');
  const result = JSON.parse(jsonMatch[0]);
  const wrongYears = [currentYear - 1, currentYear - 2, currentYear - 3];
  wrongYears.forEach(wy => { result.topic = result.topic.replace(String(wy), String(currentYear)); });

  // Post-processing: enforce month+year in title for listicle categories
  if (category?.requiresMonthYear) {
    const targetMonth = getTargetMonthYear(category.targetNextMonth);
    if (!result.topic.toLowerCase().includes(targetMonth.toLowerCase())) {
      result.topic = result.topic.replace(/\s*$/, ` for ${targetMonth}`);
      console.log(`Enforced month+year in title: "${result.topic}"`);
    }
  }

  return { topic: result.topic, keywords: result.keywords, lsiKeywords: result.lsiKeywords || [], searchVolume: result.searchVolume };
}

async function researchTopicWithPerplexity(apiKey: string, topic: string, keywords: string[]): Promise<string> {
  const currentYear = new Date().getFullYear();
  const currentDate = new Date().toISOString().split('T')[0];

  const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: `You are a thorough research assistant. TODAY: ${currentDate}, YEAR: ${currentYear}. Provide ONLY verified, factual information with specific numbers, statistics, and sources. Never invent data.` },
        { role: 'user', content: `Research the topic: "${topic}"

Provide comprehensive, FACTUAL research covering:
1. Key statistics and data points (with sources/years)
2. Current trends and recent developments (${currentYear})
3. Expert opinions or industry reports
4. Real examples and case studies
5. Practical tips backed by data
6. Common mistakes or misconceptions
7. Tools, platforms, or resources related to this topic

Keywords to cover: ${keywords.join(', ')}

IMPORTANT:
- Only include REAL, verifiable statistics
- Cite sources where possible (e.g., "According to Shopify's 2026 report...")
- Include specific numbers, percentages, and dates
- If you're unsure about a stat, say so or omit it
- Focus on information from ${currentYear} and late ${currentYear - 1}

Write 800-1000 words of pure research findings.` }
      ],
      temperature: 0.3,
      max_tokens: 4000
    })
  });

  if (!response.ok) {
    console.error(`Perplexity research error: ${response.status}`);
    return 'No research data available — use only verifiable, general knowledge.';
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || 'No research data available.';
}

async function generateUltraSEOBlogPost(apiKey: string, topic: string, keywords: string[], lsiKeywords: string[], existingArticles: ShopifyArticle[], targetWordCount: number, research: string, contentFormat: ContentFormat = 'technical'): Promise<BlogPost> {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
  const currentDate = new Date().toISOString().split('T')[0];
  const articlesInfo = existingArticles.map(a => `- "${a.title}" (handle: ${a.handle})`).join('\n');

  // Format-specific structure instructions
  let formatStructure = '';
  switch (contentFormat) {
    case 'listicle':
      formatStructure = `
LISTICLE FORMAT RULES:
- Each item MUST be an H2 section with a numbered prefix (e.g., "1. App Script Bloat Is Killing Your Load Time")
- Each item section MUST include: the symptom a store owner sees (50 words), the root cause (50 words), how to fix it step-by-step (80 words), expected impact with data (30 words)
- Include a summary comparison table early in the article:
  <table style='width:100%; border-collapse:collapse; margin:20px 0;'>
    <thead><tr style='background:#f8fafc;'><th style='padding:10px; border:1px solid #e2e8f0; text-align:left;'>Item</th><th style='padding:10px; border:1px solid #e2e8f0; text-align:left;'>Category</th><th style='padding:10px; border:1px solid #e2e8f0; text-align:left;'>Why It's Hot</th><th style='padding:10px; border:1px solid #e2e8f0; text-align:left;'>Best For</th></tr></thead>
    <tbody>...</tbody>
  </table>
- Add a "Key Takeaway" highlight box after every 3rd item:
  <div style='background:#f0fdf4; border-left:4px solid #22c55e; padding:15px; margin:20px 0;'><strong>Key Takeaway:</strong> ...</div>`;
      break;
    case 'comparison':
      formatStructure = `
COMPARISON FORMAT RULES:
- Structure: Intro → Quick Verdict → Overview of X → Overview of Y → Feature-by-feature comparison (5-7 features as H2s) → Final Verdict
- Include a side-by-side comparison table early (after intro):
  <table style='width:100%; border-collapse:collapse; margin:20px 0;'>
    <thead><tr style='background:#f8fafc;'><th style='padding:10px; border:1px solid #e2e8f0;'>Feature</th><th style='padding:10px; border:1px solid #e2e8f0;'>Tool A</th><th style='padding:10px; border:1px solid #e2e8f0;'>Tool B</th><th style='padding:10px; border:1px solid #e2e8f0;'>Winner</th></tr></thead>
    <tbody>...</tbody>
  </table>
- Each feature H2 section must declare a clear winner with reasoning
- End with "Which Should You Choose?" section with specific recommendations for different use cases (beginners, growing stores, enterprise)`;
      break;
    case 'evergreen-guide':
      formatStructure = `
EVERGREEN GUIDE FORMAT RULES:
- Use seasonal framing (e.g., "Spring ${currentYear}") rather than specific month where possible
- Include step-by-step numbered instructions within sections using <ol> lists
- Add "Pro Tip" callout boxes throughout:
  <div style='background:#fef3c7; border-left:4px solid #f59e0b; padding:15px; margin:20px 0;'><strong>Pro Tip:</strong> ...</div>
- Include a "Quick Start Checklist" section with checkmark items`;
      break;
    case 'technical':
      formatStructure = `
TECHNICAL GUIDE FORMAT RULES:
- Include code snippets where relevant using <pre><code> blocks
- Add a "Prerequisites" section at the beginning
- Use step-by-step numbered instructions for implementation`;
      break;
  }

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are an ELITE SEO content writer for MILEDEVS — a Shopify Select Partner agency. TODAY: ${currentDate}, YEAR: ${currentYear}, MONTH: ${currentMonth} ${currentYear}. CRITICAL: Use ${currentYear} (NOT ${currentYear-1}).

AGENCY KNOWLEDGE BASE (use this to write with genuine expertise, not generic AI content):
- MILEDEVS is a Shopify Select Partner (top 1% of Shopify partners worldwide)
- Built 15+ stores: LUNESI (UK fashion), RINFIT (silicone rings), CARBON (luxury accessories), JOYFOLIE (kids shoes), MODERNO KIDS, and more
- Specialization: custom Dawn/OS2.0 themes, speed optimization (35→92 PageSpeed scores), CRO audits, app integration, platform migrations
- Team uses AI agents for PM, development, and QA — one of few agencies running this model
- Based in Ukraine, serving clients worldwide (US, UK, EU)
- Common findings from audits: slow themes with too many apps, broken Liquid loops, unoptimized images, missing schema markup, poor collection page UX
- Tech stack: Shopify Liquid, Hydrogen, Admin API, Storefront API, Supabase, Node.js

AUDIENCE: You write for owners and ecommerce managers of ESTABLISHED Shopify stores ($10k-$500k+/mo) — potential agency clients diagnosing a problem or making a buying decision. Never write for consumers or beginner dropshippers.

WRITING RULES:
- Write as an experienced Shopify developer sharing real knowledge, NOT as a content mill
- Reference specific tools, Shopify features, and real patterns (e.g., "In Dawn 12.0, the section rendering API..." not "Many stores find that...")
- Include specific numbers from the research — never invent statistics
- Optimize for AI chatbot citation: structured lists, tables, direct answers, FAQ
- E-E-A-T: Experience (we built these stores), Expertise (Select Partner), Authority (15+ projects), Trust (real case studies)
- Where genuinely relevant, mention how MILEDEVS solved this exact problem for a client store (LUNESI, RINFIT, CARBON, JOYFOLIE) — one concrete sentence with a real-sounding detail, linked to the case study page` },
        { role: 'user', content: `Write an EXCEPTIONAL, IN-DEPTH SEO blog post about: "${topic}"
Content format: ${contentFormat.toUpperCase()}

CRITICAL LENGTH REQUIREMENT: You MUST write AT LEAST ${targetWordCount} words of actual content. Each H2 section MUST have at least 150-200 words.

KEYWORDS: ${keywords.join(', ')}.
LSI: ${lsiKeywords.join(', ')}.

=== VERIFIED RESEARCH DATA (use this as the foundation — do NOT invent statistics) ===
${research}
=== END RESEARCH ===

IMPORTANT: Base your article on the research data above. Use ONLY the statistics, facts, and sources provided in the research. Do NOT make up numbers, percentages, or cite sources not mentioned in the research. If the research doesn't cover something, write about it in general terms without inventing data.

EXISTING BLOG ARTICLES (link to them using <a href='/blogs/news/HANDLE'>):
${articlesInfo || 'None'}

AGENCY CONTEXT: This blog belongs to MILEDEVS, a Shopify development & optimization agency.
${formatStructure}

REQUIRED STRUCTURE:
1) ANSWER-FIRST BLOCK (CRITICAL for AI citation):
   Start with a <div> containing a 2-3 sentence DIRECT ANSWER to the main question of the article.
   Format: <div style='background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:20px; margin-bottom:24px; font-size:1.1em; line-height:1.6;'><strong>[Direct answer in 2-3 sentences. Be specific, include a number or fact. This is what ChatGPT/Perplexity will cite.]</strong></div>
   Example: "If your Shopify store takes over 3 seconds to load, you're losing roughly 40% of mobile visitors before they see a product. The usual causes are app script bloat, render-blocking sections and unoptimized hero images — all fixable, typically lifting conversion 15-25%."
2) Hook intro (150-200 words) — expand on the answer with context and a real statistic
3) Table of contents with anchor links to each H2 section
4) 7-10 H2 sections — EACH section must be 150-200+ words with:
   - Real data points from the research above
   - Actionable tips the reader can implement
   - Sub-sections using H3 where appropriate
4) Include 3-5 internal links to existing blog articles naturally within the text
5) Include 2-3 external links to real authoritative sources mentioned in the research
6) FAQ section with 5-7 questions (H3 for each) — each answer 50-80 words
7) Conclusion with numbered key takeaways

CONVERSION RULES (MANDATORY — this blog must generate agency leads):
- Include exactly ONE inline contextual link to <a href='/pages/services'>our Shopify development services</a> mid-article where it genuinely fits
- Where a client story is mentioned, link the case study: <a href='/pages/case-lunesi'>LUNESI</a>, <a href='/pages/case-rinfit'>RINFIT</a>, <a href='/pages/case-carbon'>CARBON</a>, <a href='/pages/case-joyfolie'>JOYFOLIE</a> (1-2 max)
- AFTER the conclusion, ALWAYS append this CTA block, adapting ONLY the headline question to the article topic:
<div style='background:#0f172a; border-radius:12px; padding:28px; margin:32px 0;'><h3 style='margin:0 0 8px; color:#ffffff;'>[Topic-specific question, e.g. "Losing sales to a slow store?"]</h3><p style='margin:0 0 16px; color:#cbd5e1;'>MILEDEVS is a Shopify Select Partner agency. Request a free store audit — we'll review your speed, UX and conversion funnel and send a prioritized fix list within 48 hours.</p><a href='/pages/contact' style='display:inline-block; background:#d6f344; color:#0f172a; padding:12px 24px; border-radius:8px; font-weight:600; text-decoration:none;'>Get Free Store Audit →</a></div>

CRITICAL HTML RULES:
- NEVER use <h1> tags — article title is already H1
- Use ONLY <h2> and <h3> for headings
- ALL HTML attribute quotes MUST be single quotes (')
- Internal links format: <a href='/blogs/news/handle'>anchor text</a>
- External links: <a href='https://...' target='_blank' rel='noopener'>text</a>
- Use <ul>/<ol> lists, <strong>, <em> for rich formatting
- Do NOT include <script> tags, JSON-LD, or schema markup
- Do NOT add reading time badges or meta tags in HTML

Return ONLY valid JSON:
{"title": "SEO title 50-60 chars", "metaDescription": "Meta description 150-160 chars with primary keyword", "content": "Full HTML content — MUST be ${targetWordCount}+ words", "excerpt": "Engaging social media teaser under 155 chars", "keywords": ${JSON.stringify(keywords)}, "altText": "Descriptive image alt text with keyword", "internalLinks": ["handle1", "handle2"], "readingTime": ${Math.ceil(targetWordCount / 200)}, "relatedPosts": [{"title": "Related article title", "url": "/blogs/news/handle"}]}` }
      ],
      temperature: 0.7,
      max_tokens: 16000,
      response_format: { type: "json_object" }
    })
  }, 50000);

  if (!response.ok) throw new Error(`OpenAI error: ${await response.text()}`);
  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  let blogPost;
  try {
    blogPost = JSON.parse(content);
  } catch (parseError) {
    console.error('JSON Parse Error:', parseError.message);
    try {
      const fixedContent = content
        .replace(/href="([^"]*)"([^,}\]])/g, 'href=\\"$1\\"$2')
        .replace(/class="([^"]*)"([^,}\]])/g, 'class=\\"$1\\"$2')
        .replace(/style="([^"]*)"([^,}\]])/g, 'style=\\"$1\\"$2');
      blogPost = JSON.parse(fixedContent);
      console.log('JSON fixed and parsed successfully');
    } catch (retryError) {
      throw new Error(`Failed to parse GPT response as JSON: ${parseError.message}`);
    }
  }

  // Sanitize content: remove any H1 tags and script tags that GPT might have added
  if (blogPost.content) {
    blogPost.content = blogPost.content
      .replace(/<h1[^>]*>.*?<\/h1>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  }

  // Fix wrong years
  const wrongYears = [currentYear - 1, currentYear - 2, currentYear - 3];
  const fullText = `${blogPost.title} ${blogPost.content} ${blogPost.metaDescription}`;
  wrongYears.forEach(wrongYear => {
    const yearStr = String(wrongYear);
    if (fullText.includes(yearStr)) {
      blogPost.title = blogPost.title.replace(new RegExp(yearStr, 'g'), String(currentYear));
      blogPost.metaDescription = blogPost.metaDescription.replace(new RegExp(yearStr, 'g'), String(currentYear));
      blogPost.content = blogPost.content.replace(new RegExp(yearStr, 'g'), String(currentYear));
    }
  });

  return {
    title: blogPost.title,
    content: blogPost.content,
    metaDescription: blogPost.metaDescription,
    imageUrl: '',
    keywords: blogPost.keywords || keywords,
    altText: blogPost.altText || topic,
    excerpt: blogPost.excerpt || blogPost.metaDescription,
    internalLinks: blogPost.internalLinks || [],
    readingTime: blogPost.readingTime || Math.ceil(targetWordCount / 200),
    relatedPosts: blogPost.relatedPosts || []
  };
}

async function publishToShopify(storeUrl: string, accessToken: string, blogId: string, post: BlogPost): Promise<any> {
  const articleUrl = `https://${storeUrl}/admin/api/2024-10/blogs/${blogId}/articles.json`;

  // Clean content: no embedded JSON-LD, no H1 — theme handles schemas and title
  const cleanContent = post.content;

  const articleData = {
    article: {
      title: post.title,
      body_html: cleanContent,
      summary_html: post.excerpt,
      published: true,
      tags: post.keywords.join(', '),
      image: post.imageUrl ? { src: post.imageUrl, alt: post.altText } : undefined,
      metafields: [
        { namespace: 'global', key: 'title_tag', value: post.title, type: 'single_line_text_field' },
        { namespace: 'global', key: 'description_tag', value: post.metaDescription, type: 'single_line_text_field' }
      ]
    }
  };

  const response = await fetch(articleUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify(articleData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error: ${response.status} ${errorText}`);
  }

  return await response.json();
}
