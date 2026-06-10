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
    .replace(/[^\d]/g, "");

  const value = parseInt(normalized, 10);
  return Number.isFinite(value) ? value : 0;
}

function cleanTitle(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/\s*[-–|｜]\s*(楽天市場|楽天|Amazon|Yahoo!|ZOZOTOWN|メルカリ).*$/i, "")
    .trim();
}

function decodeHtml(buffer, contentType = "") {
  const headerCharset = contentType.match(/charset=([^;]+)/i)?.[1]?.toLowerCase();

  if (headerCharset) {
    try {
      return iconv.decode(buffer, headerCharset);
    } catch {}
  }

  const utf8Preview = buffer.toString("utf8", 0, Math.min(buffer.length, 5000));
  const metaCharset = utf8Preview.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();

  if (metaCharset) {
    try {
      return iconv.decode(buffer, metaCharset);
    } catch {}
  }

  // 일본 쇼핑몰 fallback
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
      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else if (parsed["@graph"] && Array.isArray(parsed["@graph"])) {
        results.push(...parsed["@graph"]);
      } else {
        results.push(parsed);
      }
    } catch {}
  });

  return results;
}

function findTitleFromJsonLd(items) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const type = Array.isArray(item["@type"]) ? item["@type"].join(",") : item["@type"];

    if (/Product/i.test(type || "") && item.name) {
      return cleanTitle(item.name);
    }

    if (item.name && !/BreadcrumbList/i.test(type || "")) {
      return cleanTitle(item.name);
    }
  }

  return "";
}

function findPriceFromJsonLd(items) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const offers = item.offers;

    if (offers) {
      if (Array.isArray(offers)) {
        for (const offer of offers) {
          const p = cleanPrice(offer.price || offer.lowPrice || offer.highPrice || "");
          if (p > 0) return p;
        }
      } else {
        const p = cleanPrice(offers.price || offers.lowPrice || offers.highPrice || "");
        if (p > 0) return p;
      }
    }

    const direct = cleanPrice(item.price || "");
    if (direct > 0) return direct;
  }

  return 0;
}

function parseRakuten($, html) {
  const jsonLd = extractJsonLd($);

  let title = findTitleFromJsonLd(jsonLd);
  let price = findPriceFromJsonLd(jsonLd);

  if (!title) {
    const titleSelectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'h1.item_name',
      '.item_name',
      '[class*="item_name"]',
      'h1[itemprop="name"]',
      '.normal_reserve_title',
      '.ratRichItemTitle',
      'h1',
      'title'
    ];

    for (const sel of titleSelectors) {
      let t = "";

      if (sel.startsWith("meta")) {
        t = $(sel).attr("content") || "";
      } else {
        t = $(sel).first().text();
      }

      t = cleanTitle(t);

      if (t && t.length > 2) {
        title = t;
        break;
      }
    }
  }

  if (!price) {
    const priceSelectors = [
      'meta[property="product:price:amount"]',
      'meta[itemprop="price"]',
      '[itemprop="price"]',
      '.price2',
      '.price',
      '[class*="price"]',
      '.item_price',
      '.yen',
      'strong.price',
      '.normal_price'
    ];

    for (const sel of priceSelectors) {
      const elements = $(sel);

      for (let i = 0; i < elements.length; i++) {
        const el = elements.eq(i);
        const text = sel.startsWith("meta") ? el.attr("content") : el.text();
        const p = cleanPrice(text);

        if (p > 10 && p < 10000000) {
          price = p;
          break;
        }
      }

      if (price) break;
    }
  }

  if (!price) {
    const patterns = [
      /"price"\s*:\s*"?([\d,]+)"?/i,
      /"priceAmount"\s*:\s*"?([\d,]+)"?/i,
      /商品価格[^0-9０-９]{0,20}([0-9０-９,，]+)/i,
      /販売価格[^0-9０-９]{0,20}([0-9０-９,，]+)/i,
      /税込[^0-9０-９]{0,20}([0-9０-９,，]+)\s*円/i,
      /[¥￥]\s*([0-9０-９,，]+)/i
    ];

    for (const pattern of patterns) {
      const m = html.match(pattern);
      if (m) {
        const p = cleanPrice(m[1]);
        if (p > 10 && p < 10000000) {
          price = p;
          break;
        }
      }
    }
  }

  return { title, price };
}

function parseProduct(html, url) {
  const $ = cheerio.load(html);
  const site = detectSite(url);

  let title = "";
  let price = 0;
  let weight = null;

  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const pageTitle = $("title").text().trim() || "";

  if (site === "rakuten") {
    const r = parseRakuten($, html);
    title = r.title;
    price = r.price;
  }

  else if (site === "amazon") {
    title =
      $("#productTitle").text().trim() ||
      ogTitle ||
      pageTitle;

    const priceSelectors = [
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#price_inside_buybox",
      "#newBuyBoxPrice",
      ".a-price-whole"
    ];

    for (const sel of priceSelectors) {
      const p = cleanPrice($(sel).first().text());
      if (p > 0) {
        price = p;
        break;
      }
    }
  }

  else if (site === "yahoo") {
    title =
      $(".elHeadMainTitle").first().text().trim() ||
      $(".ProductTitle__title").first().text().trim() ||
      $('h1[class*="Title"]').first().text().trim() ||
      $("h1").first().text().trim() ||
      ogTitle ||
      pageTitle;

    const priceSelectors = [
      ".elPriceNumber",
      '[class*="PriceNumber"]',
      '[class*="price"]'
    ];

    for (const sel of priceSelectors) {
      const p = cleanPrice($(sel).first().text());
      if (p > 0) {
        price = p;
        break;
      }
    }
  }

  else {
    title = ogTitle || $("h1").first().text().trim() || pageTitle;

    $("body *").each((_, el) => {
      if (price) return;
      const txt = $(el).text();
      const m = txt.match(/[¥￥]\s*([0-9０-９,，]+)/);
      if (m) {
        const p = cleanPrice(m[1]);
        if (p > 100 && p < 10000000) price = p;
      }
    });
  }

  title = cleanTitle(title);

  return {
    site,
    title,
    price,
    weight
  };
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const rawUrl = req.query.url;

    if (!rawUrl) {
      return res.status(400).json({
        ok: false,
        message: "url 파라미터가 필요합니다."
      });
    }

    const target = new URL(rawUrl);

    if (!["http:", "https:"].includes(target.protocol)) {
      return res.status(400).json({
        ok: false,
        message: "http 또는 https URL만 허용됩니다."
      });
    }

    const hostAllowed = allowedHosts.some(host =>
      target.hostname === host || target.hostname.endsWith("." + host)
    );

    if (!hostAllowed) {
      return res.status(400).json({
        ok: false,
        message: "허용되지 않은 쇼핑몰 URL입니다."
      });
    }

    const response = await fetch(target.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language":
          "ja-JP,ja;q=0.9,ko-KR;q=0.8,ko;q=0.7,en;q=0.6",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        message: `쇼핑몰 응답 오류: HTTP ${response.status}`
      });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || "";
    const html = decodeHtml(buffer, contentType);

    const product = parseProduct(html, target.toString());

    return res.status(200).json({
      ok: true,
      sourceUrl: target.toString(),
      ...product
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "서버 오류"
    });
  }
}
