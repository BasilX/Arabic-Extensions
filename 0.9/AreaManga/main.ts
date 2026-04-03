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

const DOMAIN = "https://ar.kenmanga.com";

class AreaMangaInterceptor extends PaperbackInterceptor {
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
    request: Request, response: Response, data: ArrayBuffer
  ): Promise<ArrayBuffer> {
    if (response.headers?.["cf-mitigated"] === "challenge") {
      throw new CloudflareError({ url: request.url, method: request.method ?? "GET" });
    }
    return data;
  }
}

export class AreaManga implements Extension, DiscoverSectionProviding,
  SearchResultsProviding, MangaProviding, ChapterProviding,
  CloudflareBypassRequestProviding {

  rateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5, bufferInterval: 1, ignoreImages: true
  });
  cookieStorage = new CookieStorageInterceptor({ storage: "stateManager" });
  interceptor = new AreaMangaInterceptor("interceptor");

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookieStorage.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const c of cookies) {
      if (c.name.startsWith("cf") || c.name.startsWith("_cf") || c.name.startsWith("__cf")) {
        this.cookieStorage.setCookie(c);
      }
    }
  }

  async bypassCloudflareRequest(r: Request): Promise<Request> { return r; }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: "popular", title: "الأكثر شعبية", type: DiscoverSectionType.simpleCarousel },
      { id: "latest", title: "أحدث التحديثات", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata?: { page?: number }
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = metadata?.page ?? 1;
    const order = section.id === "popular" ? "popular" : "update";

    const urlReq = new URL(DOMAIN)
      .addPathComponent("manga")
      .setQueryItem("order", order)
      .setQueryItem("page", page.toString())
      .toString();

    const [, buffer] = await Application.scheduleRequest({ url: urlReq, method: "GET" });
    const html = Application.arrayBufferToUTF8String(buffer);
    const $ = cheerio.load(html);

    const items: DiscoverSectionItem[] = [];
    const elements = $(".listupd .manga-card-v").toArray();

    for (const element of elements) {
      const el = $(element);
      const aTag = el.find("a").first();
      const href = aTag.attr("href");
      if (!href) continue;

      const mangaId = href.replace(DOMAIN, "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/^manga\//, "");
      let title = el.find(".bigor .tt, h3 a").first().text().trim();
      if (!title) title = aTag.attr("title") || "Unknown";

      const img = el.find("img").first();
      const imgUrl = img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src") || "";

      items.push({
        type: "simpleCarouselItem",
        mangaId: mangaId,
        title: title,
        imageUrl: imgUrl,
        contentRating: ContentRating.EVERYONE,
      });
    }

    return { items, metadata: elements.length > 0 ? { page: page + 1 } : undefined };
  }

  async getSearchFilters(): Promise<any[]> { return []; }

  async getSearchResults(
    query: SearchQuery,
    metadata?: { page?: number },
    _sortingOption?: any
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const urlReq = new URL(DOMAIN)
      .setQueryItem("s", query.title || "")
      .setQueryItem("page", page.toString())
      .toString();

    const [, buffer] = await Application.scheduleRequest({ url: urlReq, method: "GET" });
    const html = Application.arrayBufferToUTF8String(buffer);
    const $ = cheerio.load(html);

    const items: SearchResultItem[] = [];
    const elements = $(".listupd .manga-card-v").toArray();

    for (const element of elements) {
      const el = $(element);
      const aTag = el.find("a").first();
      const href = aTag.attr("href");
      if (!href) continue;

      const mangaId = href.replace(DOMAIN, "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/^manga\//, "");
      let title = el.find(".bigor .tt, h3 a").first().text().trim();
      if (!title) title = aTag.attr("title") || "Unknown";

      const img = el.find("img").first();
      const imgUrl = img.attr("src") || img.attr("data-src") || img.attr("data-lazy-src") || "";

      items.push({
        mangaId: mangaId,
        title: title,
        imageUrl: imgUrl,
        contentRating: ContentRating.EVERYONE,
      });
    }

    return { items, metadata: elements.length > 0 ? { page: page + 1 } : undefined };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const url = mangaId.startsWith("http") ? mangaId : `${DOMAIN}/manga/${mangaId}/`;
    const [, buffer] = await Application.scheduleRequest({ url, method: "GET" });
    const html = Application.arrayBufferToUTF8String(buffer);
    const $ = cheerio.load(html);

    const title = $(".manga-title-large").text().trim() || "Unknown Title";
    const thumbnail = $(".manga-poster img").attr("src") || $(".manga-poster img").attr("data-src") || "";
    const synopsis = $("div.story-text").text().trim();

    const parseLabel = (label: string) => {
      return $(".info-label").filter((_, el) => $(el).text().includes(label)).next("span").text().trim();
    };

    const author = parseLabel("المؤلف") || undefined;
    const artist = parseLabel("الرسام") || undefined;
    const rawStatus = parseLabel("الحالة");

    let status = "Unknown";
    if (rawStatus.includes("مستمر")) status = "Ongoing";
    else if (rawStatus.includes("مكتمل")) status = "Completed";
    else if (rawStatus.includes("متوقف")) status = "Hiatus";

    const tags = $("div.filter-tags a").toArray().map(el => {
      const t = $(el).text().trim();
      return { id: t, title: t };
    }).filter(t => t.id);

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: [],
        thumbnailUrl: thumbnail,
        synopsis: synopsis,
        author: author,
        artist: artist,
        status: status,
        contentRating: ContentRating.EVERYONE,
        tagGroups: tags.length > 0 ? [{ id: "tags", title: "Tags", tags }] : [],
        shareUrl: url,
      }
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const { mangaId } = sourceManga;
    const url = mangaId.startsWith("http") ? mangaId : `${DOMAIN}/manga/${mangaId}/`;

    const [, buffer] = await Application.scheduleRequest({ url, method: "GET" });
    const html = Application.arrayBufferToUTF8String(buffer);
    const $ = cheerio.load(html);

    const chapters: Chapter[] = [];
    const elements = $("a.ch-item").toArray();

    const parseDate = (dateStr: string): Date => {
      if (!dateStr) return new Date();
      const d = new Date(dateStr.trim());
      return isNaN(d.getTime()) ? new Date() : d;
    };

    for (const [index, element] of elements.entries()) {
      const el = $(element);
      const href = el.attr("href");
      if (!href) continue;

      const chapterUrlId = href.replace(DOMAIN, "").replace(/^\/+/, "").replace(/\/+$/, "");
      const chapTitle = el.find(".chap-num").text().trim() || "Chapter";
      const chapDate = el.find(".chap-date").text().trim();
      const chapNum = parseFloat(el.attr("data-ch") || chapTitle.match(/[\d.]+/)?.[0] || "0") || 0;

      chapters.push({
        chapterId: chapterUrlId,
        sourceManga: sourceManga,
        title: chapTitle,
        chapNum: chapNum,
        volume: 0,
        langCode: "ar",
        sortingIndex: elements.length - index - 1,
        publishDate: parseDate(chapDate),
      });
    }

    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const url = chapter.chapterId.startsWith("http") ?
      chapter.chapterId :
      `${DOMAIN}/${chapter.chapterId}`;

    const [, buffer] = await Application.scheduleRequest({ url, method: "GET" });
    const html = Application.arrayBufferToUTF8String(buffer);
    const $ = cheerio.load(html);

    const wpPostId = $("#comment_post_ID").attr("value");
    if (!wpPostId) {
      throw new Error("Chapter ID not found on page.");
    }

    const [, apiBuf] = await Application.scheduleRequest({
      url: `${DOMAIN}/wp-admin/admin-ajax.php`,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "referer": url,
        "user-agent": await Application.getDefaultUserAgent(),
      },
      body: `action=get_secure_chapter_images&chapter_id=${encodeURIComponent(wpPostId)}`
    });

    const apiJsonData = JSON.parse(Application.arrayBufferToUTF8String(apiBuf));

    if (!apiJsonData.success) {
      throw new Error("Failed to load chapter API.");
    }

    if (apiJsonData.data?.status === "locked") {
      throw new Error("Chapter locked. Open in WebView to unlock.");
    }

    if (apiJsonData.data?.status === "unlocked") {
      const chapterHtml = apiJsonData.data?.content || "";
      const c$ = cheerio.load(chapterHtml);
      
      const pages = c$("img").toArray().map(el => {
        return c$(el).attr("src") || c$(el).attr("data-src") || c$(el).attr("data-lazy-src") || "";
      }).filter(Boolean);

      return {
        id: chapter.chapterId,
        mangaId: chapter.sourceManga.mangaId,
        pages: pages,
      };
    }

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: [],
    };
  }
}

export const AreaMangaSource = new AreaManga();
