import * as cheerio from "cheerio";
import iconv from "iconv-lite";

const allowedHosts = [
  "amazon.co.jp",
  "www.amazon.co.jp",
  "item.rakuten.co.jp",
  "search.rakuten.co.jp",
  "shopping.yahoo.co.jp",
  "store.shopping.yahoo.co.jp",
  "jp.mercari.com",
  "mercari.com",
  "zozo.jp",
  "www.qoo10.jp"
];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function detectSite(url) {
  if (/amazon\.co\.jp/i.test(url)) return "amazon";
  if (/rakuten\.co\.jp/i.test(url)) return "rakuten";
  if (/shopping\.yahoo\.co\.jp/i.test(url)) return "yahoo";
  if (/mercari\.com|jp\.mercari/i.test(url)) return "mercari";
  if (/zozo\.jp/i.test(url)) return "zozo";
  if (/qoo10\.jp/i.test(url)) return "qoo10";
  return "generic";
}

function cleanPrice(text = "") {
  const normalized = String(text)
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ",")
    .replace(/[^\d]/g, "");
  const value = parseInt(normalized, 10);
  return Number.isFinite(value) ? value : 0;
}

function cleanTitle(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/^Title:\s*/i, "")
    .replace(/【楽天市場】/g, "")
    .replace(/\s*[-–|｜]\s*(楽天市場|楽天|Amazon|Yahoo!|ZOZOTOWN|メルカリ).*$/i, "")
    .trim();
}

function decodeHtml(buffer, contentType = "") {
  const headerCharset = contentType.match(/charset=([^;]+)/i)?.[1]?.toLowerCase();
  if (headerCharset) {
    try { return iconv.decode(buffer, headerCharset); } catch {}
  }

  const utf8Preview = buffer.toString("utf8", 0, Math.min(buffer.length, 5000));
  const metaCharset = utf8Preview.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  if (metaCharset) {
    try { return iconv.decode(buffer, metaCharset); } catch {}
  }

  for (const enc of ["utf8", "shift_jis", "euc-jp"]) {
    try {
      const decoded = iconv.decode(buffer, enc);
      if (decoded && decoded.length > 100) return decoded;
    } catch {}
  }
  return buffer.toString("utf8");
}

function extractJsonLd($) {
  const results = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) results.push(...parsed);
      else if (parsed?.["@graph"] && Array.isArray(parsed["@graph"])) results.push(...parsed["@graph"]);
      else results.push(parsed);
    } catch {}
  });
  return results;
}

function findTitleFromJsonLd(items) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = Array.isArray(item["@type"]) ? item["@type"].join(",") : item["@type"];
    if (/Product/i.test(type || "") && item.name) return cleanTitle(item.name);
  }
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = Array.isArray(item["@type"]) ? item["@type"].join(",") : item["@type"];
    if (item.name && !/BreadcrumbList|WebSite/i.test(type || "")) return cleanTitle(item.name);
  }
  return "";
}

function findPriceFromJsonLd(items) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const offers = item.offers;
    if (offers) {
      const arr = Array.isArray(offers) ? offers : [offers];
      for (const offer of arr) {
        const p = cleanPrice(offer?.price || offer?.lowPrice || offer?.highPrice || "");
        if (p > 0) return p;
      }
    }
    const direct = cleanPrice(item.price || "");
    if (direct > 0) return direct;
  }
  return 0;
}

function extractCommon($) {
  const jsonLd = extractJsonLd($);
  let title = findTitleFromJsonLd(jsonLd);
  let price = findPriceFromJsonLd(jsonLd);

  if (!title) {
    const titleSelectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'h1[itemprop="name"]',
      "#productTitle",
      "h1.item_name",
      ".item_name",
      '[class*="item_name"]',
      ".normal_reserve_title",
      ".ratRichItemTitle",
      ".elHeadMainTitle",
      ".ProductTitle__title",
      "h1",
      "title"
    ];
    for (const sel of titleSelectors) {
      const t = sel.startsWith("meta") ? $(sel).attr("content") : $(sel).first().text();
      const cleaned = cleanTitle(t || "");
      if (cleaned && cleaned.length > 2) { title = cleaned; break; }
    }
  }

  if (!price) {
    const priceSelectors = [
      'meta[property="product:price:amount"]',
      'meta[itemprop="price"]',
      '[itemprop="price"]',
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#price_inside_buybox",
      "#newBuyBoxPrice",
      ".elPriceNumber",
      '[class*="PriceNumber"]',
      ".price2",
      ".price",
      '[class*="price"]',
      ".item_price",
      ".yen",
      "strong.price",
      ".normal_price"
    ];
    for (const sel of priceSelectors) {
      const elements = $(sel);
      for (let i = 0; i < elements.length; i++) {
        const el = elements.eq(i);
        const text = sel.startsWith("meta") ? el.attr("content") : el.text();
        const p = cleanPrice(text || "");
        if (p > 10 && p < 10000000) { price = p; break; }
      }
      if (price) break;
    }
  }
  return { title, price };
}

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractByRegex(html) {
  let title = "";
  let price = 0;

  const titlePatterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /"name"\s*:\s*"([^"]{3,200})"/i,
    /<title[^>]*>([^<]{3,200})<\/title>/i
  ];
  for (const pat of titlePatterns) {
    const m = html.match(pat);
    if (m) {
      title = cleanTitle(decodeEntities(m[1]));
      if (title) break;
    }
  }

  const pricePatterns = [
    /"price"\s*:\s*"?([0-9０-９,，]+)"?/i,
    /"priceAmount"\s*:\s*"?([0-9０-９,，]+)"?/i,
    /商品価格[^0-9０-９]{0,30}([0-9０-９,，]+)\s*円/i,
    /販売価格[^0-9０-９]{0,30}([0-9０-９,，]+)\s*円/i,
    /税込[^0-9０-９]{0,30}([0-9０-９,，]+)\s*円/i,
    /[¥￥]\s*([0-9０-９,，]+)/i
  ];
  for (const pat of pricePatterns) {
    const m = html.match(pat);
    if (m) {
      const p = cleanPrice(m[1]);
      if (p > 10 && p < 10000000) { price = p; break; }
    }
  }
  return { title, price };
}

function parseReaderText(markdown) {
  let title = "";
  let price = 0;

  const lines = String(markdown).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 30)) {
    const m = line.match(/^Title:\s*(.+)$/i) || line.match(/^#\s+(.+)$/);
    if (m) {
      const t = cleanTitle(m[1]);
      if (t && !/楽天市場|ログイン|買い物かご/i.test(t)) { title = t; break; }
    }
  }

  const joined = lines.join("\n");
  const pricePatterns = [
    /価格\s*[:：]?\s*([0-9０-９,，]+)\s*円/i,
    /販売価格\s*[:：]?\s*([0-9０-９,，]+)\s*円/i,
    /税込\s*[:：]?\s*([0-9０-９,，]+)\s*円/i,
    /([0-9０-９,，]{3,})\s*円\s*\(?(税込|税抜)?/i,
    /[¥￥]\s*([0-9０-９,，]+)/i
  ];
  for (const pat of pricePatterns) {
    const m = joined.match(pat);
    if (m) {
      const p = cleanPrice(m[1]);
      if (p > 10 && p < 10000000) { price = p; break; }
    }
  }

  return { title, price };
}

async function fetchDirect(target) {
  const response = await fetch(target.toString(), {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "ja-JP,ja;q=0.9,ko-KR;q=0.8,ko;q=0.7,en;q=0.6",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    }
  });
  if (!response.ok) throw new Error(`쇼핑몰 응답 오류: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";
  return decodeHtml(buffer, contentType);
}

async function fetchViaJina(target) {
  const readerUrl = `https://r.jina.ai/${target.toString()}`;
  const response = await fetch(readerUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/plain, text/markdown, */*",
      "Accept-Language": "ja-JP,ja;q=0.9,ko-KR;q=0.8,ko;q=0.7,en;q=0.6"
    }
  });
  if (!response.ok) throw new Error(`Reader 응답 오류: HTTP ${response.status}`);
  return await response.text();
}

function mergeProduct(base, fallback) {
  return {
    title: base.title || fallback.title || "",
    price: base.price > 0 ? base.price : (fallback.price || 0)
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ ok: false, message: "url 파라미터가 필요합니다." });

    const target = new URL(rawUrl);
    if (!["http:", "https:"].includes(target.protocol)) {
      return res.status(400).json({ ok: false, message: "http 또는 https URL만 허용됩니다." });
    }

    const hostAllowed = allowedHosts.some(host => target.hostname === host || target.hostname.endsWith("." + host));
    if (!hostAllowed) return res.status(400).json({ ok: false, message: "허용되지 않은 쇼핑몰 URL입니다." });

    const site = detectSite(target.toString());
    let html = "";
    let directProduct = { title: "", price: 0 };
    let readerProduct = { title: "", price: 0 };
    let method = "direct";
    let warnings = [];

    try {
      html = await fetchDirect(target);
      const $ = cheerio.load(html);
      directProduct = mergeProduct(extractCommon($), extractByRegex(html));
    } catch (e) {
      warnings.push(`direct: ${e.message}`);
    }

    let product = directProduct;

    if (!product.title || !product.price) {
      try {
        const readerText = await fetchViaJina(target);
        readerProduct = parseReaderText(readerText);
        product = mergeProduct(product, readerProduct);
        method = "direct+jina";
      } catch (e) {
        warnings.push(`jina: ${e.message}`);
      }
    }

    return res.status(200).json({
      ok: true,
      sourceUrl: target.toString(),
      site,
      method,
      title: product.title || "",
      price: product.price || 0,
      weight: null,
      warning: warnings.length ? warnings.join(" / ") : undefined
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || "서버 오류" });
  }
  }
