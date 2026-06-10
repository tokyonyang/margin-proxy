import * as cheerio from "cheerio";

const allowedHosts = [
  "amazon.co.jp",
  "www.amazon.co.jp",
  "item.rakuten.co.jp",
  "search.rakuten.co.jp",
  "books.rakuten.co.jp",
  "biccamera.rakuten.co.jp",
  "shopping.yahoo.co.jp",
  "store.shopping.yahoo.co.jp",
  "jp.mercari.com",
  "mercari.com",
  "zozo.jp",
  "www.qoo10.jp"
];

function setCors(res) {
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
  const n = String(text).replace(/[^\d]/g, "");
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? v : 0;
}

function firstText($, selectors) {
  for (const sel of selectors) {
    const t = $(sel).first().text().replace(/\s+/g, " ").trim();
    if (t.length > 2) return t;
  }
  return "";
}

function firstPrice($, selectors) {
  for (const sel of selectors) {
    let found = 0;
    $(sel).each((_, el) => {
      if (found) return;
      const v = cleanPrice($(el).text());
      if (v > 10 && v < 10000000) found = v;
    });
    if (found) return found;
  }
  return 0;
}

function extractWeight($) {
  const text = $("body").text().replace(/\s+/g, " ");
  const kg = text.match(/(重量|重さ|商品重量|本体重量)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*kg/i);
  if (kg) return parseFloat(kg[2]);
  const g = text.match(/(重量|重さ|商品重量|本体重量)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*g/i);
  if (g) return parseFloat(g[2]) / 1000;
  return null;
}

function parseProduct(html, url) {
  const $ = cheerio.load(html);
  const site = detectSite(url);

  let title = "";
  let price = 0;
  const weight = extractWeight($);

  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const pageTitle = $("title").text().replace(/\s+/g, " ").trim() || "";

  if (site === "amazon") {
    title = firstText($, ["#productTitle", "h1"]) || ogTitle || pageTitle;
    price = firstPrice($, [
      ".a-price .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#price_inside_buybox",
      "#newBuyBoxPrice",
      ".a-price-whole"
    ]);
  } else if (site === "rakuten") {
    title = firstText($, [
      "h1.item_name",
      ".item_name",
      '[class*="item_name"]',
      'h1[itemprop="name"]',
      ".normal_reserve_title",
      ".ratRichItemTitle",
      "h1"
    ]) || ogTitle || pageTitle;

    price = firstPrice($, [
      'meta[property="product:price:amount"]',
      'span[itemprop="price"]',
      ".price2",
      ".price",
      '[class*="price"]',
      ".item_price",
      ".yen",
      "strong.price",
      ".normal_price"
    ]);

    if (!price) {
      const metaPrice = $('meta[property="product:price:amount"]').attr("content") || $('[itemprop="price"]').attr("content") || "";
      price = cleanPrice(metaPrice);
    }

    if (!price) {
      const body = $("body").text();
      const m = body.match(/[¥￥]\s*([\d,]+)/);
      if (m) price = parseInt(m[1].replace(/,/g, ""), 10);
    }
  } else if (site === "yahoo") {
    title = firstText($, [".elHeadMainTitle", ".ProductTitle__title", 'h1[class*="Title"]', "h1"]) || ogTitle || pageTitle;
    price = firstPrice($, [".elPriceNumber", '[class*="PriceNumber"]', '[class*="price"]']);
  } else if (site === "mercari") {
    title = firstText($, ['[data-testid="name"]', ".item-name", "h1"]) || ogTitle || pageTitle;
    price = firstPrice($, ['[data-testid="price"] span', ".item-price", '[class*="price"]']);
  } else if (site === "zozo") {
    title = firstText($, [".p-item-detail__name", ".item-name", "h1"]) || ogTitle || pageTitle;
    price = firstPrice($, [".price", '[class*="Price"]']);
  } else {
    title = ogTitle || firstText($, ["h1"]) || pageTitle;
    const body = $("body").text();
    const m = body.match(/[¥￥]\s*([\d,]+)/);
    if (m) price = parseInt(m[1].replace(/,/g, ""), 10);
  }

  title = String(title)
    .replace(/\s*[-–|｜]\s*(Amazon|楽天|Yahoo!|ZOZOTOWN|メルカリ).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return { site, title, price, weight };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "GET만 지원합니다." });

  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ ok: false, message: "url 파라미터가 필요합니다." });

    const target = new URL(rawUrl);
    if (!["http:", "https:"].includes(target.protocol)) {
      return res.status(400).json({ ok: false, message: "http 또는 https URL만 허용됩니다." });
    }

    const hostAllowed = allowedHosts.some(host => target.hostname === host || target.hostname.endsWith("." + host));
    if (!hostAllowed) {
      return res.status(400).json({ ok: false, message: `허용되지 않은 쇼핑몰 URL입니다: ${target.hostname}` });
    }

    const response = await fetch(target.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,ko-KR;q=0.8,ko;q=0.7,en;q=0.6"
      }
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, message: `쇼핑몰 응답 오류: HTTP ${response.status}` });
    }

    const html = await response.text();
    const product = parseProduct(html, target.toString());

    return res.status(200).json({ ok: true, sourceUrl: target.toString(), ...product });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || "서버 오류" });
  }
}
