# Shopify theme — blog rendering & technical SEO layer

The edge functions publish **clean article HTML** to Shopify (no `<h1>`, no
`<script>`, no schema — by design). All the *technical SEO* and presentation is
rendered by the **Shopify theme**, and those files live here. This is a
[Dawn](https://github.com/Shopify/dawn)-based set — drop these into a Dawn theme
(or adapt the markers for your own) to get the full reader experience the
automation was built for.

> Extracted from the live MILEDEVS theme. Rebrand: search for `MILEDEVS`,
> `miledevs.com`, the byline name, and the contact details in
> `snippets/seo-schema.liquid` (public business phone/email used for the
> Organization/ContactPoint schema).

## What each file does

### Structured data (the JSON-LD — "the JSONs")
- **`snippets/seo-schema.liquid`** — all JSON-LD `application/ld+json` blocks,
  emitted per page type:
  - `Organization` (every page), `WebSite` + `SearchAction` (home)
  - `BreadcrumbList` (article / blog / page)
  - `FAQPage` (home)
  - **`Article`** (article pages) — headline, description, URL, image, dates
  Rendered via `{% render 'seo-schema' %}` from `layout/theme.liquid`.
- **`snippets/meta-tags.liquid`** — `<title>` / meta description / Open Graph /
  canonical handling per page type.

### Article page (the Table of Contents + reading experience)
- **`sections/main-article.liquid`** — the article renderer:
  - **sticky left TOC**, auto-built from the article's `<h2>`s, with
    **scroll-spy** (active item highlight via `.article-toc__item.is-active`)
  - author **byline** (avatar / name / role) + meta row (category · date · reading time)
  - **CTA banner** before the FAQ (settings come from `templates/article.json`)
  - **FAQ accordion** (`<details>`-based) parsed from the article body
  - **related posts** (3-up grid)
  - dark theme (`#0a0a0a` + lime `#d4ff00` accent)
- **`templates/article.json`** — OS 2.0 template wiring `main-article` + its blocks
  (featured image, title, share, content) and the CTA copy.
- **`assets/section-blog-post.css`** — article page styles.

### Blog index & cards
- **`sections/main-blog.liquid`**, **`templates/blog.json`** — blog listing page.
- **`sections/featured-blog.liquid`** — "latest posts" section for other pages.
- **`snippets/article-card.liquid`**, **`snippets/card-article.liquid`** — post cards.
- **`assets/section-main-blog.css`**, **`assets/component-article-card.css`**,
  **`assets/section-featured-blog.css`**, **`assets/blog.js`**.

### FAQ sections (reused on pages)
- **`sections/faq-accordion.liquid`**, **`sections/faq.liquid`** — standalone FAQ
  sections; **`assets/section-faq.css`**.
- **`sections/blog-cta-banner.liquid`** — reusable CTA banner section.

## Install
1. Use a Dawn-based theme (this is Dawn 12.x).
2. Upload these files into the matching folders (`sections/`, `snippets/`,
   `templates/`, `assets/`) — Shopify admin → Themes → Edit code, or the Shopify CLI.
3. Add `{% render 'seo-schema' %}` (and `{% render 'meta-tags' %}` if your theme
   doesn't already emit tags) inside `<head>` in `layout/theme.liquid`.
4. The article body produced by the automation already carries TOC anchors and
   the answer-first / FAQ HTML the section expects.

## Note
No credentials are present in these files. `seo-schema.liquid` contains the
agency's **public** contact details (phone/email) because that is the literal
purpose of the Organization schema — they are already published in the live
site's HTML. Replace them with your own.
