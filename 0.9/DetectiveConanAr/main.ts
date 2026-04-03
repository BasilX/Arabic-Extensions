import {
  BasicRateLimiter, CloudflareError, ContentRating,
  CookieStorageInterceptor, DiscoverSectionType,
  PaperbackInterceptor, URL,
  type Chapter, type ChapterDetails, type ChapterProviding,
  type CloudflareBypassRequestProviding, type Cookie,
  type DiscoverSection, type DiscoverSectionItem,
  type DiscoverSectionProviding, type Extension,
  type MangaProviding, type PagedResults, type Request,
  type Response, type SearchQuery, type SearchResultItem,
  type SearchResultsProviding, type SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";

export const DOMAIN = "https://manga.detectiveconanar.com";

class MadaraInterceptor extends PaperbackInterceptor {
  async interceptRequest(request: Request): Promise<Request> {
    return {
      ...request,
      headers: {
        ...request.headers,
        referer: `${DOMAIN}/`,
        "user-agent": await Application.getDefaultUserAgent(),
      },
    };
  }
  override async interceptResponse(
    _request: Request, response: Response, data: ArrayBuffer
  ): Promise<ArrayBuffer> {
    if (response.headers?.["cf-mitigated"] === "challenge") {
      throw new CloudflareError({ url: _request.url, method: _request.method ?? "GET" });
    }
    return data;
  }
}

async function scheduleAndText(request: Request): Promise<string> {
  const [, buffer] = await Application.scheduleRequest(request);
  return Application.arrayBufferToUTF8String(buffer);
}

class DetectiveConanArExtension implements Extension, DiscoverSectionProviding,
  SearchResultsProviding, MangaProviding, ChapterProviding,
  CloudflareBypassRequestProviding {

  rateLimiter = new BasicRateLimiter("rateLimiter", { numberOfRequests: 5, bufferInterval: 1, ignoreImages: true });
  cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });
  interceptor = new MadaraInterceptor("madara-interceptor");

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const cookie of cookies) {
      if (cookie.name.startsWith("cf") || cookie.name.startsWith("_cf") || cookie.name.startsWith("__cf")) {
        this.cookieStorageInterceptor.setCookie(cookie);
      }
    }
  }

  async bypassCloudflareRequest(request: Request): Promise<Request> { return request; }

  async getSearchFilters(): Promise<any[]> { return []; }

  // ── Discover Sections ─────────────────────────────────────────
  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: "popular", title: "الأكثر مشاهدة", type: DiscoverSectionType.simpleCarousel },
      { id: "latest", title: "آخر التحديثات", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata?: { page?: number },
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata?.page ?? 1;

    const orderBy = section.id === "popular" ? "views" : "latest";
    const url = `${DOMAIN}/manga/page/${page}/?m_orderby=${orderBy}`;

    const html = await scheduleAndText({ url, method: "GET" });
    const $ = cheerio.load(html);

    const items: DiscoverSectionItem[] = $("div.page-item-detail").map((_, el) => {
      const a = $("h3.h5 a, h3 a", el).first();
      const href = a.attr("href") ?? "";
      const mangaId = href.replace(DOMAIN, "").replace(/^\/+|\/+$/g, "");
      return {
        type: "simpleCarouselItem" as const,
        mangaId,
        title: a.text().trim(),
        imageUrl: $("img", el).attr("data-src") ?? $("img", el).attr("data-lazy-src") ?? $("img", el).attr("src") ?? "",
        contentRating: ContentRating.EVERYONE,
      };
    }).get();

    return { items, metadata: items.length > 0 ? { page: page + 1 } : undefined };
  }

  // ── Manga Details ─────────────────────────────────────────────
  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const html = await scheduleAndText({ url: `${DOMAIN}/${mangaId}/`, method: "GET" });
    const $ = cheerio.load(html);

    const tags = $("div.genres-content a").map((_, el) => ({
      id: $(el).text().trim().toLowerCase(),
      title: $(el).text().trim(),
    })).get();

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: $("div.post-title h1").text().trim(),
        secondaryTitles: [],
        thumbnailUrl: $("div.summary_image img").attr("data-src") ?? $("div.summary_image img").attr("src") ?? "",
        synopsis: $("div.description-summary").text().trim(),
        author: $("div.author-content a").text().trim() || undefined,
        artist: $("div.artist-content a").text().trim() || undefined,
        status: $("div.post-status .summary-content").last().text().trim(),
        contentRating: ContentRating.EVERYONE,
        tagGroups: tags.length > 0 ? [{ id: "genres", title: "Genres", tags }] : [],
        shareUrl: `${DOMAIN}/${mangaId}/`,
      },
    };
  }

  // ── Chapters ──────────────────────────────────────────────────
  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const { mangaId } = sourceManga;

    // Try ajax/chapters endpoint first (POST), then fall back to page scraping
    let html: string;
    try {
      html = await scheduleAndText({
        url: `${DOMAIN}/${mangaId}/ajax/chapters/`,
        method: "POST",
      });
      // Check if we got actual chapter HTML
      if (!html.includes("wp-manga-chapter")) {
        throw new Error("No chapters in ajax response");
      }
    } catch {
      // Fallback: load manga page and extract chapters from DOM
      html = await scheduleAndText({ url: `${DOMAIN}/${mangaId}/`, method: "GET" });
    }

    const $ = cheerio.load(html);
    const total = $("li.wp-manga-chapter").length;

    return $("li.wp-manga-chapter").map((index, el) => {
      const a = $("a", el).first();
      const href = a.attr("href") ?? "";
      const id = href.replace(DOMAIN, "").replace(/^\/+|\/+$/g, "");
      const name = a.text().trim();
      const chapNum = parseFloat(name.replace(/[^0-9.]/g, "")) || (total - index);
      return {
        chapterId: id,
        sourceManga,
        title: name,
        chapNum,
        volume: 0,
        langCode: "ar",
        sortingIndex: total - index - 1,
        publishDate: new Date($("span.chapter-release-date i", el).attr("title") ?? Date.now()),
      };
    }).get();
  }

  // ── Chapter Details ───────────────────────────────────────────
  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const { chapterId, sourceManga } = chapter;
    const html = await scheduleAndText({ url: `${DOMAIN}/${chapterId}/`, method: "GET" });
    const $ = cheerio.load(html);

    const pages = $("div.reading-content img")
      .map((_, el) => ($(el).attr("data-src") ?? $(el).attr("src") ?? "").trim())
      .get()
      .filter(Boolean);

    return { id: chapterId, mangaId: sourceManga.mangaId, pages };
  }

  // ── Search ────────────────────────────────────────────────────
  async getSearchResults(
    query: SearchQuery,
    metadata?: { page?: number },
    _sortingOption?: any
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const url = query.title
      ? `${DOMAIN}/page/${page}/?s=${encodeURIComponent(query.title)}&post_type=wp-manga`
      : `${DOMAIN}/manga/?page=${page}`;

    const html = await scheduleAndText({ url, method: "GET" });
    const $ = cheerio.load(html);

    const items: SearchResultItem[] = $("div.c-tabs-item__content, div.page-item-detail").map((_, el) => {
      const a = $("h3.h5 a, h4 a", el).first();
      return {
        mangaId: (a.attr("href") ?? "").replace(DOMAIN, "").replace(/^\/+|\/+$/g, ""),
        title: a.text().trim(),
        imageUrl: $("img", el).attr("data-src") ?? $("img", el).attr("src") ?? "",
        contentRating: ContentRating.EVERYONE,
      };
    }).get();

    return { items, metadata: items.length > 0 ? { page: page + 1 } : undefined };
  }
}

export const DetectiveConanArSource = new DetectiveConanArExtension();
