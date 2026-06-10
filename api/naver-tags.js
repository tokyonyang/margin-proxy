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

  // 1차: 검색 페이지를 먼저 열어 쿠키를 받은 뒤 내부 XHR API 호출
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

  // 2차 fallback: HTML 페이지 안에 manuTag가 직접 포함되는 경우 대비
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const query = String(req.query.query || '').replace(/\s+/g, ' ').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ ok: false, message: 'query 파라미터가 필요합니다.' });
    }

    const fetched = await fetchNaverShoppingJson(query);
    if (!fetched.ok) {
      return res.status(502).json({
        ok: false,
        query,
        message: '네이버 쇼핑 내부 all?query/API 응답을 가져오지 못했습니다.',
        errors: fetched.errors || []
      });
    }

    const set = new Set();
    if (fetched.json) collectManuTagsDeep(fetched.json, set);
    extractManuTagsFromText(fetched.text).forEach(tag => set.add(tag));
    const tags = Array.from(set).slice(0, 30);

    return res.status(200).json({
      ok: true,
      query,
      source: fetched.label,
      sourceUrl: fetched.url,
      count: tags.length,
      tags,
      manuTags: tags,
      manuTag: tags.join(', ')
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || '서버 오류' });
  }
}
