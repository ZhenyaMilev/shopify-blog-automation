import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MAX_ATTEMPTS = 3;

function getSupabaseClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 45000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function getShopifyAccessToken(storeUrl: string, clientId: string, clientSecret: string): Promise<string> {
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
  const data = await response.json();
  return data.access_token;
}

async function generateImage(geminiApiKey: string, topic: string, keywords: string[]): Promise<string> {
  const keyword = keywords?.[0] || topic;
  const imagePrompt = `Create a blog header image about: ${topic}. Style: minimalist dark aesthetic, professional, cinematic lighting, modern design. IMPORTANT: absolutely no text, no letters, no words in the image.`;

  console.log(`Generating image for: "${topic}"`);

  const response = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: imagePrompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } }
    })
  }, 55000);

  if (!response.ok) throw new Error(`Gemini error: ${response.status}`);

  const data = await response.json();
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!imagePart) throw new Error('No image in Gemini response');

  const base64Image = imagePart.inlineData.data;
  const imageBuffer = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0));

  // Upload to Supabase Storage
  const supabase = getSupabaseClient();
  const safeKeyword = keyword.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
  const fileName = `blog-${Date.now()}-${safeKeyword}.png`;
  const filePath = `shopify-blog-images/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from('knowledge-base-images')
    .upload(filePath, imageBuffer, { contentType: 'image/png', cacheControl: '31536000', upsert: false });

  if (uploadError) throw new Error(`Storage error: ${uploadError.message}`);

  const { data: { publicUrl } } = supabase.storage.from('knowledge-base-images').getPublicUrl(filePath);
  console.log(`Image uploaded: ${publicUrl}`);
  return publicUrl;
}

async function updateShopifyArticleImage(
  storeUrl: string,
  accessToken: string,
  blogId: string,
  articleId: number,
  imageUrl: string,
  altText: string
): Promise<void> {
  const url = `https://${storeUrl}/admin/api/2024-10/blogs/${blogId}/articles/${articleId}.json`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({
      article: {
        id: articleId,
        image: { src: imageUrl, alt: altText }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify update error: ${response.status} ${errorText}`);
  }
  console.log(`Shopify article ${articleId} updated with image`);
}

Deno.serve(async (_req: Request) => {
  try {
    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
    const SHOPIFY_STORE_URL = Deno.env.get('SHOPIFY_STORE_URL');
    const SHOPIFY_CLIENT_ID = Deno.env.get('SHOPIFY_CLIENT_ID');
    const SHOPIFY_CLIENT_SECRET = Deno.env.get('SHOPIFY_CLIENT_SECRET');
    const SHOPIFY_BLOG_ID = Deno.env.get('SHOPIFY_BLOG_ID');

    if (!GEMINI_API_KEY || !SHOPIFY_STORE_URL || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET || !SHOPIFY_BLOG_ID) {
      throw new Error('Missing required environment variables');
    }

    const supabase = getSupabaseClient();

    // Find published posts that need images (pending, max 3 attempts)
    const { data: pendingPosts, error: fetchError } = await supabase
      .from('blog_content_plan')
      .select('*')
      .eq('status', 'published')
      .eq('image_status', 'pending')
      .lt('image_attempts', MAX_ATTEMPTS)
      .not('article_id', 'is', null)
      .order('published_at', { ascending: false })
      .limit(1);

    if (fetchError) throw new Error(`DB fetch error: ${fetchError.message}`);

    if (!pendingPosts || pendingPosts.length === 0) {
      console.log('No posts need images — all done!');
      return new Response(JSON.stringify({ success: true, message: 'No pending images' }), {
        headers: { 'Content-Type': 'application/json' }, status: 200
      });
    }

    const post = pendingPosts[0];
    console.log(`Processing: "${post.topic}" (article_id: ${post.article_id}, attempt: ${post.image_attempts + 1}/${MAX_ATTEMPTS})`);

    // Increment attempt counter immediately
    await supabase
      .from('blog_content_plan')
      .update({ image_attempts: post.image_attempts + 1 })
      .eq('id', post.id);

    try {
      // Generate image
      const imageUrl = await generateImage(GEMINI_API_KEY, post.topic, post.keywords || []);

      // Update Shopify article with image
      const shopifyAccessToken = await getShopifyAccessToken(SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET);
      await updateShopifyArticleImage(
        SHOPIFY_STORE_URL,
        shopifyAccessToken,
        SHOPIFY_BLOG_ID,
        post.article_id,
        imageUrl,
        post.topic
      );

      // Mark as done
      await supabase
        .from('blog_content_plan')
        .update({ image_status: 'done', image_url: imageUrl })
        .eq('id', post.id);

      console.log(`Image added successfully for "${post.topic}"`);

      return new Response(JSON.stringify({
        success: true,
        message: 'Image generated and added to article',
        data: { planId: post.id, articleId: post.article_id, imageUrl, attempt: post.image_attempts + 1 }
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 });

    } catch (imgError) {
      console.error(`Image generation failed (attempt ${post.image_attempts + 1}/${MAX_ATTEMPTS}): ${imgError.message}`);

      // If max attempts reached, mark as failed
      if (post.image_attempts + 1 >= MAX_ATTEMPTS) {
        await supabase
          .from('blog_content_plan')
          .update({ image_status: 'failed' })
          .eq('id', post.id);
        console.log(`Max attempts reached for "${post.topic}" — marked as failed`);
      }

      return new Response(JSON.stringify({
        success: false,
        message: `Image generation failed (attempt ${post.image_attempts + 1})`,
        error: imgError.message
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 });
    }

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { 'Content-Type': 'application/json' }, status: 500
    });
  }
});
