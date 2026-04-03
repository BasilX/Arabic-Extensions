import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "شبكة كونان العربية",
  description: "Detective Conan Arabic reading site (Madara Theme)",
  version: "1.0.0-alpha.1",
  icon: "icon.png",
  language: "ar",
  contentRating: ContentRating.EVERYONE,
  capabilities:
    SourceIntents.CHAPTER_PROVIDING |
    SourceIntents.DISCOVER_SECTION_PROVIDING |
    SourceIntents.SEARCH_RESULT_PROVIDING |
    SourceIntents.CLOUDFLARE_BYPASS_PROVIDING,
  badges: [],
  developers: [{ name: "Paperback Community" }],
} satisfies ExtensionInfo;
