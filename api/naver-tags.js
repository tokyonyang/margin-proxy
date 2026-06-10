function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizeTag(value = '') {
  const tag = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^#+/, '')
    .replace(/^[\\"']+|[\\"']+$/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  if (!tag) return '';
  if (/^(undefined|null|nan|false|true)$/i.test(tag)) return '';
  if (/^[0-9,]+원?$/.test(tag)) return '';
  if (tag.length > 30) return '';
  return tag;
}

function addTagsFromValue(value, set) {
  if (value == null) return;

  if (Array.isArray(value)) {
    value.forEach(v => addTagsFromValue(v, set));
    return;
  }

  if (typeof value === 'object') {
    Object.keys(value).forEach(key => addTagsFromValue(value[key], set));
    return;
  }

  String(value)
    .split(/[,+/|｜#\n\r\t]+/)
    .forEach(part => {
      const tag = normalizeTag(part);
      if (tag) set.add(tag);
    });
}

function collectManuTagsDeep(value, set = new Set()) {
  if (value == null) return set;

  if (Array.isArray(value)) {
    value.forEach(item => collectManuTagsDeep(item, set));
    return set;
  }

  if (typeof value === 'object') {
    Object.keys(value).forEach(key => {
      if (String(key).toLowerCase() === 'manutag') {
        addTagsFromValue(value[key], set);
      } else {
        collectManuTagsDeep(value[key], set);
      }
    });
  }

  return set;
}

function extractManuTagsFromText(rawText) {
  const text = String(rawText || '');
  const set = new Set();
  if (!text.trim()) return [];

  try {
    const parsed = JSON.parse(text);
    collectManuTagsDeep(parsed, set);
    addTagsFromValue(parsed.tags || parsed.manuTags || parsed.manuTag || [], set);
  } catch (e) {}

  const decodedText = text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  const regexes = [
    /"manuTag"\s*:\s*"([^"]*)"/gi,
    /'manuTag'\s*:\s*'([^']*)'/gi,
    /"manuTag"\s*:\s*\[([^\]]*)\]/gi,
    /manuTag\s*[:=]\s*"([^"]*)"/gi
  ];

  regexes.forEach(regex => {
    let match;
    while ((match = regex.exec(decodedText)) !== null) {
      addTagsFromValue(match[1], set);
    }
  });

  return Array.from(set).slice(0, 30);
}

function buildNaverApiUrl(query, page = 1) {
  const params = new URLSearchParams({
    sort: 'rel',
    pagingIndex: String(page),
    pagingSize: '40',
    viewType: 'list',
    productSet: 'total',
    deliveryFee: '',
    deliveryTypeValue: '',
    frm: 'NVSHATC',
    query,
    origQuery: query,
    adQuery: query,
    iq: '',
    eq: '',
    xq: ''
  });
  return `https://search.shopping.naver.com/api/search/all?${params.toString()}`;
}

function buildNaverSearchUrl(query) {
  const params = new URLSearchParams({ query, frm: 'NVSHATC' });
  return `https://search.shopping.naver.com/search/all?${params.toString()}`;
}

function cookieHeaderFromResponse(response) {
  try {
    if (typeof response.headers.getSetCookie === 'function') {
      return response.headers.getSetCookie().map(v => String(v).split(';')[0]).join('; ');
    }
  } catch (e) {}

  const raw = response.headers.get('set-cookie') || '';
  return raw
    .split(/,(?=[^;]+=)/)
    .map(v => v.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function naverHeaders(query, cookie = '') {
  const referer = buildNaverSearchUrl(query);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
    'Referer': referer,
    'Origin': 'https://search.shopping.naver.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'logic': 'PART'
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function fetchNaverShoppingJson(query) {
  const searchUrl = buildNaverSearchUrl(query);
  let cookie = '';

  try {
    const pageRes = await fetchWithTimeout(searchUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }, 10000);
    cookie = cookieHeaderFromResponse(pageRes);
  } catch (e) {}

  const apiUrl = buildNaverApiUrl(query, 1);
  const attempts = [
    { label: 'api/search/all with cookie', cookie },
    { label: 'api/search/all direct', cookie: '' }
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const res = await fetchWithTimeout(apiUrl, {
        redirect: 'follow',
        headers: naverHeaders(query, attempt.cookie)
      }, 12000);

      const text = await res.text();
      if (!res.ok) {
        errors.push(`${attempt.label}: HTTP ${res.status}`);
        continue;
      }

      let json = null;
      try { json = JSON.parse(text); } catch (e) {}

      return {
        ok: true,
        label: attempt.label,
        url: apiUrl,
        text,
        json
      };
    } catch (e) {
      errors.push(`${attempt.label}: ${e.message}`);
    }
  }

  try {
    const res = await fetchWithTimeout(searchUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }, 12000);

    const text = await res.text();
    if (!res.ok) errors.push(`search/all html: HTTP ${res.status}`);
    else return { ok: true, label: 'search/all html', url: searchUrl, text, json: null };
  } catch (e) {
    errors.push(`search/all html: ${e.message}`);
  }

  return { ok: false, errors };
}

function addQueryTokens(query, set) {
  const q = normalizeTag(query);
  if (q) set.add(q);
  String(query || '')
    .replace(/[()\[\]{}.,:;!?~]/g, ' ')
    .split(/\s+/)
    .forEach(part => {
      const tag = normalizeTag(part);
      if (tag && tag.length >= 2) set.add(tag);
    });
}

function titleTokens(title, set) {
  String(title || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^0-9a-zA-Z가-힣\s]/g, ' ')
    .split(/\s+/)
    .forEach(part => {
      const tag = normalizeTag(part);
      if (!tag || tag.length < 2 || tag.length > 18) return;
      if (/^(무료배송|당일배송|해외직구|정품|새상품|공식|특가|세일|할인|추천)$/i.test(tag)) return;
      set.add(tag);
    });
}

async function fetchNaverOfficialShopping(query) {
  const clientId = process.env.NAVER_CLIENT_ID || process.env.NAVER_SEARCH_CLIENT_ID || '';
  const clientSecret = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SEARCH_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    return { ok: false, reason: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 없음' };
  }

  const url = `https://openapi.naver.com/v1/search/shop.json?${new URLSearchParams({ query, display: '20', start: '1', sort: 'sim' }).toString()}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
        'Accept': 'application/json'
      }
    }, 12000);
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `OpenAPI HTTP ${res.status}`, text: text.slice(0, 300) };
    const json = JSON.parse(text);
    const set = new Set();
    addQueryTokens(query, set);
    (json.items || []).slice(0, 10).forEach(item => {
      addTagsFromValue(item.brand, set);
      addTagsFromValue(item.maker, set);
      addTagsFromValue(item.category2, set);
      addTagsFromValue(item.category3, set);
      addTagsFromValue(item.category4, set);
      titleTokens(item.title, set);
    });
    return { ok: true, tags: Array.from(set).slice(0, 30), sourceUrl: url, total: json.total || 0 };
  } catch (e) {
    return { ok: false, reason: e.message || 'OpenAPI 실패' };
  }
}

function fallbackTagsFromQuery(query) {
  const set = new Set();
  addQueryTokens(query, set);
  return Array.from(set).slice(0, 10);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const query = String(req.query.query || '').replace(/\s+/g, ' ').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ ok: false, message: 'query 파라미터가 필요합니다.' });
    }

    const internal = await fetchNaverShoppingJson(query);
    if (internal.ok) {
      const set = new Set();
      if (internal.json) collectManuTagsDeep(internal.json, set);
      extractManuTagsFromText(internal.text).forEach(tag => set.add(tag));
      const tags = Array.from(set).slice(0, 30);
      if (tags.length) {
        return res.status(200).json({
          ok: true,
          query,
          verified: true,
          tagType: 'manuTag',
          source: internal.label,
          sourceUrl: internal.url,
          count: tags.length,
          tags,
          manuTags: tags,
          manuTag: tags.join(', ')
        });
      }
    }

    const official = await fetchNaverOfficialShopping(query);
    if (official.ok && official.tags.length) {
      return res.status(200).json({
        ok: true,
        query,
        verified: false,
        tagType: 'officialShoppingFallback',
        source: 'Naver OpenAPI Shopping fallback',
        sourceUrl: official.sourceUrl,
        count: official.tags.length,
        tags: official.tags,
        manuTags: [],
        manuTag: '',
        message: '네이버 내부 all?query가 차단되어 공식 쇼핑 검색 API 기반 태그 후보를 자동 반영했습니다.',
        internalErrors: internal.errors || [],
        officialTotal: official.total
      });
    }

    const fallback = fallbackTagsFromQuery(query);
    return res.status(200).json({
      ok: true,
      query,
      verified: false,
      tagType: 'queryFallback',
      source: 'Query fallback after Naver 418 block',
      count: fallback.length,
      tags: fallback,
      manuTags: [],
      manuTag: '',
      message: '네이버 내부 all?query가 HTTP 418로 차단되어 검색어 기반 최소 태그만 자동 반영했습니다. 실제 manuTag 확인은 네이버 쇼핑 화면에서 확인이 필요합니다.',
      internalErrors: internal.errors || [],
      officialError: official.reason || null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || '서버 오류' });
  }
}
