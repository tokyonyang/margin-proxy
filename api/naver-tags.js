import crypto from "crypto";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr || []) {
    const s = cleanTag(v);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function cleanTag(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[~!@#$%^&*()_=+\[\]{};:'"\\|<>/?`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeyword(value) {
  return cleanTag(value).slice(0, 80);
}

function extractTagsDeep(value, keyNames = ["manuTag"]) {
  const tags = [];
  const stack = [value];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (typeof cur === "object") {
      for (const [key, val] of Object.entries(cur)) {
        if (keyNames.includes(key)) {
          if (Array.isArray(val)) tags.push(...val);
          else if (typeof val === "string") tags.push(...splitTagString(val));
          else if (val != null) tags.push(String(val));
        }
        if (val && typeof val === "object") stack.push(val);
      }
    }
  }

  return uniq(tags);
}

function splitTagString(value) {
  return String(value ?? "")
    .split(/[,，|/·#\n\r\t]+/)
    .map(cleanTag)
    .filter(Boolean);
}

function tagCandidatesFromText(...values) {
  const tags = [];
  for (const value of values) {
    const text = cleanTag(value);
    if (!text) continue;

    const chunks = text
      .replace(/[+\-_/|()[\]{}]/g, " ")
      .split(/\s+/)
      .map(cleanTag)
      .filter(Boolean);

    for (const c of chunks) {
      if (c.length < 2 || c.length > 18) continue;
      if (/^\d+$/.test(c)) continue;
      if (/^(무료배송|정품|공식|당일|오늘|특가|할인|쿠폰|국내|해외|배송|상품|제품|판매|구매)$/i.test(c)) continue;
      tags.push(c);
    }

    if (text.length >= 2 && text.length <= 18 && !/^\d+$/.test(text)) tags.push(text);
  }
  return uniq(tags);
}

function getEnv() {
  const accessLicense =
    process.env.NAVER_SEARCHAD_ACCESS_LICENSE ||
    process.env.NAVER_SEARCHAD_API_KEY ||
    process.env.NAVER_SEARCHAD_ACCESS_KEY ||
    "";

  const secretKey =
    process.env.NAVER_SEARCHAD_SECRET_KEY ||
    process.env.NAVER_SEARCHAD_API_SECRET ||
    process.env.NAVER_SEARCHAD_SECRET ||
    "";

  const customerId =
    process.env.NAVER_SEARCHAD_CUSTOMER_ID ||
    process.env.NAVER_SEARCHAD_CUSTOMER ||
    process.env.NAVER_SEARCHAD_CUSTOMERID ||
    "";

  const openApiClientId = process.env.NAVER_CLIENT_ID || "";
  const openApiClientSecret = process.env.NAVER_CLIENT_SECRET || "";

  return {
    accessLicense: String(accessLicense).trim(),
    secretKey: String(secretKey).trim(),
    customerId: String(customerId).trim(),
    openApiClientId: String(openApiClientId).trim(),
    openApiClientSecret: String(openApiClientSecret).trim()
  };
}

function makeSearchAdSignature(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto
    .createHmac("sha256", secretKey)
    .update(message)
    .digest("base64");
}

function parseSearchAdCount(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const s = String(value).replace(/[^\d]/g, "");
  return s ? Number(s) : 0;
}

async function fetchSearchAdKeywords(query, diagnostics) {
  const env = getEnv();
  const configured = !!(env.accessLicense && env.secretKey && env.customerId);

  diagnostics.searchAd = {
    configured,
    hasAccessLicense: !!env.accessLicense,
    hasSecretKey: !!env.secretKey,
    hasCustomerId: !!env.customerId
  };

  if (!configured) {
    diagnostics.searchAd.error = "검색광고 API 환경변수 3개가 모두 설정되지 않았습니다.";
    return null;
  }

  const method = "GET";
  const uri = "/keywordstool";
  const timestamp = Date.now().toString();
  const signature = makeSearchAdSignature(timestamp, method, uri, env.secretKey);
  const url = `https://api.searchad.naver.com${uri}?hintKeywords=${encodeURIComponent(query)}&showDetail=1`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": env.accessLicense,
      "X-Customer": env.customerId,
      "X-Signature": signature,
      "Accept": "application/json"
    }
  });

  const raw = await response.text();
  diagnostics.searchAd.httpStatus = response.status;

  let data = {};
  try { data = JSON.parse(raw); }
  catch { data = { raw: raw.slice(0, 500) }; }

  if (!response.ok) {
    diagnostics.searchAd.error = data?.title || data?.detail || data?.message || `HTTP ${response.status}`;
    diagnostics.searchAd.response = data;
    return null;
  }

  const keywordList = Array.isArray(data.keywordList) ? data.keywordList : [];
  const ranked = keywordList
    .map(item => {
      const keyword = cleanTag(item.relKeyword || item.keyword || "");
      const pc = parseSearchAdCount(item.monthlyPcQcCnt);
      const mobile = parseSearchAdCount(item.monthlyMobileQcCnt);
      return {
        keyword,
        pc,
        mobile,
        total: pc + mobile,
        competition: item.compIdx || item.plAvgDepth || undefined
      };
    })
    .filter(item => item.keyword && item.keyword.length >= 2)
    .sort((a, b) => b.total - a.total);

  const tags = uniq([
    query,
    ...ranked.slice(0, 30).map(item => item.keyword)
  ]).slice(0, 30);

  diagnostics.searchAd.keywordCount = ranked.length;

  if (!tags.length) {
    diagnostics.searchAd.error = "검색광고 API 응답은 왔지만 키워드 후보가 비어 있습니다.";
    return null;
  }

  return {
    ok: true,
    verified: false,
    tagType: "searchAdKeywordFallback",
    source: "Naver SearchAd KeywordTool fallback",
    query,
    count: tags.length,
    tags,
    manuTags: [],
    manuTag: "",
    keywordStats: ranked.slice(0, 30)
  };
}

async function fetchNaverShoppingOpenApi(query, diagnostics) {
  const env = getEnv();
  const configured = !!(env.openApiClientId && env.openApiClientSecret);

  diagnostics.openApiShopping = {
    configured,
    hasClientId: !!env.openApiClientId,
    hasClientSecret: !!env.openApiClientSecret
  };

  if (!configured) {
    diagnostics.openApiShopping.error = "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없습니다.";
    return null;
  }

  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=20&start=1&sort=sim`;
  const response = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": env.openApiClientId,
      "X-Naver-Client-Secret": env.openApiClientSecret,
      "Accept": "application/json"
    }
  });

  const raw = await response.text();
  diagnostics.openApiShopping.httpStatus = response.status;

  let data = {};
  try { data = JSON.parse(raw); }
  catch { data = { raw: raw.slice(0, 500) }; }

  if (!response.ok) {
    diagnostics.openApiShopping.error = data?.errorMessage || data?.message || `HTTP ${response.status}`;
    diagnostics.openApiShopping.response = data;
    return null;
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const tags = uniq([
    query,
    ...items.flatMap(item => tagCandidatesFromText(
      item.brand,
      item.maker,
      item.category1,
      item.category2,
      item.category3,
      item.category4,
      item.mallName,
      item.title
    ))
  ]).slice(0, 30);

  diagnostics.openApiShopping.total = data.total;
  diagnostics.openApiShopping.itemCount = items.length;

  if (!tags.length) return null;

  return {
    ok: true,
    verified: false,
    tagType: "officialShoppingFallback",
    source: "Naver OpenAPI Shopping fallback",
    sourceUrl: url,
    query,
    count: tags.length,
    tags,
    manuTags: [],
    manuTag: "",
    officialTotal: data.total
  };
}

async function fetchNaverInternalManuTag(query, diagnostics) {
  const errors = [];
  const urls = [
    `https://search.shopping.naver.com/api/search/all?query=${encodeURIComponent(query)}&pagingIndex=1&pagingSize=20&sort=rel&viewType=list`,
    `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
          "Accept": "application/json,text/html,*/*",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6",
          "Referer": `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`
        }
      });

      const text = await response.text();
      if (!response.ok) {
        errors.push(`${url.includes("/api/") ? "api/search/all" : "search/all html"}: HTTP ${response.status}`);
        continue;
      }

      let data = null;
      try { data = JSON.parse(text); } catch {}

      let tags = [];
      if (data) {
        tags = extractTagsDeep(data, ["manuTag"]);
      } else {
        const matches = [...text.matchAll(/"manuTag"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)];
        for (const m of matches) {
          try {
            const parsed = JSON.parse(m[1]);
            if (Array.isArray(parsed)) tags.push(...parsed);
            else tags.push(...splitTagString(parsed));
          } catch {}
        }
        tags = uniq(tags);
      }

      if (tags.length) {
        diagnostics.internal = { attempted: true, success: true, errors };
        return {
          ok: true,
          verified: true,
          tagType: "verifiedManuTag",
          source: "Naver Shopping internal all?query manuTag",
          query,
          count: tags.length,
          tags,
          manuTags: tags,
          manuTag: tags.join(", ")
        };
      }

      errors.push(`${url.includes("/api/") ? "api/search/all" : "search/all html"}: manuTag 없음`);
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }

  diagnostics.internal = { attempted: true, success: false, errors };
  return null;
}

function queryFallback(query, diagnostics) {
  const tags = uniq([
    query,
    ...tagCandidatesFromText(query)
  ]).slice(0, 10);

  return {
    ok: true,
    verified: false,
    tagType: "queryFallback",
    source: "query fallback",
    query,
    count: tags.length,
    tags,
    manuTags: [],
    manuTag: "",
    message: "검색광고 API/공식 쇼핑 API/내부 all?query가 모두 실패해 검색어 기반 후보만 반영했습니다.",
    diagnostics
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const diagnostics = {
    version: "searchad-debug-2026-06-10",
    order: [
      "verified manuTag from internal all?query",
      "SearchAd KeywordTool",
      "Naver OpenAPI Shopping",
      "query fallback"
    ]
  };

  try {
    const query = normalizeKeyword(req.query.query || req.query.q || "");
    const debug = String(req.query.debug || "") === "1";

    if (!query) {
      return res.status(400).json({
        ok: false,
        message: "query 파라미터가 필요합니다.",
        diagnostics
      });
    }

    const internal = await fetchNaverInternalManuTag(query, diagnostics);
    if (internal) {
      if (debug) internal.diagnostics = diagnostics;
      return res.status(200).json(internal);
    }

    const searchAd = await fetchSearchAdKeywords(query, diagnostics);
    if (searchAd) {
      searchAd.message = "내부 all?query가 차단되어 네이버 검색광고 API 기반 키워드 후보를 자동 반영했습니다.";
      if (debug) searchAd.diagnostics = diagnostics;
      return res.status(200).json(searchAd);
    }

    const shopping = await fetchNaverShoppingOpenApi(query, diagnostics);
    if (shopping) {
      shopping.message = "내부 all?query와 검색광고 API를 사용할 수 없어 공식 쇼핑 API 기반 태그 후보를 자동 반영했습니다.";
      if (debug) shopping.diagnostics = diagnostics;
      return res.status(200).json(shopping);
    }

    return res.status(200).json(queryFallback(query, diagnostics));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "서버 오류",
      diagnostics
    });
  }
}
