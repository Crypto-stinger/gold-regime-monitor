import { pool } from "./storage";

const FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_IDEAS_IN_CONTEXT = 5;

interface AnalystIdea {
  title: string;
  url: string;
  content: string;
  chartUrl: string | null;
  videoUrl: string | null;
}

async function safeFetch(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function extractContentFromIdeaPage(html: string): string {
  let content = "";

  const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*/i);
  if (metaDesc?.[1]) {
    content = metaDesc[1];
  }

  const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"[^>]*/i);
  if (ogDesc?.[1] && ogDesc[1].length > content.length) {
    content = ogDesc[1];
  }

  const jsonLdPattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const text = data?.articleBody || data?.description || data?.text || "";
      if (text.length > content.length) {
        content = text;
      }
    } catch { /* skip */ }
  }

  return content
    .replace(/\\n/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 5000);
}

function extractChartImage(html: string): string | null {
  const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*/i);
  if (ogImage?.[1] && ogImage[1].startsWith("http")) return ogImage[1];

  const twitterImage = html.match(/<meta[^>]*name="twitter:image"[^>]*content="([^"]*)"[^>]*/i);
  if (twitterImage?.[1] && twitterImage[1].startsWith("http")) return twitterImage[1];

  const jsonLdPattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const img = data?.image?.url || data?.image || data?.thumbnailUrl;
      if (typeof img === "string" && img.startsWith("http")) return img;
    } catch { /* skip */ }
  }

  return null;
}

function extractVideoUrl(html: string): string | null {
  const ogVideo = html.match(/<meta[^>]*property="og:video(?::url)?"[^>]*content="([^"]*)"[^>]*/i);
  if (ogVideo?.[1] && ogVideo[1].startsWith("http")) return ogVideo[1];

  const jsonLdPattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const vid = data?.video?.contentUrl || data?.video?.embedUrl || data?.video?.url;
      if (typeof vid === "string" && vid.startsWith("http")) return vid;
      if (data?.video && typeof data.video === "string" && data.video.startsWith("http")) return data.video;
    } catch { /* skip */ }
  }

  const youtubeEmbed = html.match(/(?:src|href)="(https?:\/\/(?:www\.)?youtube\.com\/(?:embed|watch)[^"]+)"/i);
  if (youtubeEmbed?.[1]) return youtubeEmbed[1];

  const youtubeShort = html.match(/(?:src|href)="(https?:\/\/youtu\.be\/[^"]+)"/i);
  if (youtubeShort?.[1]) return youtubeShort[1];

  return null;
}

function extractTitleFromPage(html: string): string {
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*/i);
  if (ogTitle?.[1]) return ogTitle[1];

  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag?.[1]) return titleTag[1].replace(/ — TradingView$/, '').trim();

  return "";
}

function extractIdeaLinksFromPage(html: string): string[] {
  const links: string[] = [];

  const fullUrlPattern = /"(https:\/\/www\.tradingview\.com\/chart\/XAUUSD\/[a-zA-Z0-9]+-[^"#]+)"/gi;
  let match;
  while ((match = fullUrlPattern.exec(html)) !== null && links.length < 15) {
    const url = match[1].replace(/\/$/, '') + '/';
    if (!links.includes(url)) links.push(url);
  }

  const relPattern = /href="(\/chart\/XAUUSD\/[a-zA-Z0-9]+-[^"#]+)"/gi;
  while ((match = relPattern.exec(html)) !== null && links.length < 15) {
    const url = `https://www.tradingview.com${match[1].replace(/\/$/, '')}/`;
    if (!links.includes(url)) links.push(url);
  }

  return links;
}

async function fetchIdeaDetails(url: string): Promise<AnalystIdea | null> {
  const html = await safeFetch(url);
  if (!html) return null;

  const title = extractTitleFromPage(html);
  const content = extractContentFromIdeaPage(html);
  const chartUrl = extractChartImage(html);
  const videoUrl = extractVideoUrl(html);

  if (content.length < 50) return null;

  return {
    title: title || url.split('/').pop()?.replace(/-/g, ' ') || "Goldviewfx Analysis",
    url,
    content,
    chartUrl,
    videoUrl,
  };
}

export async function fetchGoldviewfxIdeas(): Promise<number> {
  console.log("[goldviewfx] Fetching latest Goldviewfx ideas from TradingView...");
  const ideas: AnalystIdea[] = [];

  let ideaUrls: string[] = [];

  const searchUrls = [
    "https://www.tradingview.com/ideas/search/goldviewfx/?sort=recent",
    "https://www.tradingview.com/symbols/XAUUSD/ideas/?sort=recent",
  ];

  for (const searchUrl of searchUrls) {
    if (ideaUrls.length >= 5) break;
    const html = await safeFetch(searchUrl);
    if (html) {
      const found = extractIdeaLinksFromPage(html);
      for (const u of found) {
        if (!ideaUrls.includes(u)) ideaUrls.push(u);
      }
    }
  }
  console.log(`[goldviewfx] Found ${ideaUrls.length} idea URLs from search pages`);

  if (ideaUrls.length === 0) {
    console.log("[goldviewfx] No URLs from search — using known/stored URLs as fallback");
    try {
      const stored = await pool.query(
        `SELECT url FROM analyst_ideas WHERE source = 'goldviewfx' ORDER BY fetched_at DESC LIMIT 5`
      );
      ideaUrls = stored.rows.map((r: any) => r.url);
    } catch { /* ignore */ }

    if (ideaUrls.length === 0) {
      ideaUrls = [
        "https://www.tradingview.com/chart/XAUUSD/rdMiNZHu-Gold-Spotting-Higher-Lows-Before-the-Move-Up/",
      ];
    }
  }

  for (const url of ideaUrls.slice(0, 5)) {
    const idea = await fetchIdeaDetails(url);
    if (idea) ideas.push(idea);
  }

  if (ideas.length === 0) {
    console.log("[goldviewfx] No ideas could be fetched");
    return 0;
  }

  let saved = 0;
  for (const idea of ideas) {
    try {
      await pool.query(
        `INSERT INTO analyst_ideas (source, title, url, content, chart_url, video_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (url) DO UPDATE SET content = EXCLUDED.content, chart_url = COALESCE(EXCLUDED.chart_url, analyst_ideas.chart_url), video_url = COALESCE(EXCLUDED.video_url, analyst_ideas.video_url), fetched_at = NOW()`,
        ["goldviewfx", idea.title, idea.url, idea.content, idea.chartUrl, idea.videoUrl]
      );
      saved++;
    } catch (err: any) {
      console.error("[goldviewfx] Save error:", err.message);
    }
  }

  console.log(`[goldviewfx] Saved/updated ${saved} ideas`);
  return saved;
}

export async function getLatestAnalystIdeas(count: number = MAX_IDEAS_IN_CONTEXT): Promise<string> {
  try {
    const result = await pool.query(
      `SELECT title, url, content, fetched_at 
       FROM analyst_ideas 
       WHERE source = 'goldviewfx'
       ORDER BY fetched_at DESC 
       LIMIT $1`,
      [count]
    );

    if (result.rows.length === 0) return "";

    const sections = result.rows.map((row: any, i: number) => {
      const age = Math.round((Date.now() - new Date(row.fetched_at).getTime()) / (1000 * 60 * 60));
      const ageStr = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
      return `--- IDEA ${i + 1} (fetched ${ageStr}) ---\nTitle: ${row.title}\nURL: ${row.url}\n\n${row.content}`;
    });

    return `\n\nGOLDVIEWFX LATEST ANALYSIS (auto-fetched daily — use these insights for directional bias and structural reading):\n${sections.join("\n\n")}`;
  } catch (err) {
    console.error("[goldviewfx] Failed to load ideas from DB:", err);
    return "";
  }
}

let fetchInterval: ReturnType<typeof setInterval> | null = null;

export function startGoldviewfxScheduler() {
  setTimeout(async () => {
    await fetchGoldviewfxIdeas();
  }, 15000);

  fetchInterval = setInterval(async () => {
    await fetchGoldviewfxIdeas();
  }, FETCH_INTERVAL_MS);

  console.log(`[goldviewfx] Scheduler started — fetching every ${FETCH_INTERVAL_MS / (60 * 60 * 1000)}h`);
}

export function stopGoldviewfxScheduler() {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
}
