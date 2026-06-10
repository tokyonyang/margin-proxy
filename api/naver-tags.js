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
    .replace(/\s+/g, ' ')
    .trim();
  if (!tag) return '';
  if (/^(undefined|null|nan)$/i.test(tag)) return '';
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
  String(value).split(/[,+/|｜#\n\r\t]+/).forEach(part => {
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const query = String(req.query.query || '').replace(/\s+/g, ' ').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ ok: false, message: 'query 파라미터가 필요합니다.' });
    }

    const targetUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}&cat_id=&frm=NVSHATC`;
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, message: `네이버 응답 오류: HTTP ${response.status}` });
    }

    const html = await response.text();
    const tags = extractManuTagsFromText(html);

    return res.status(200).json({
      ok: true,
      query,
      source: 'naver-shopping-all-query',
      count: tags.length,
      tags,
      manuTags: tags,
      manuTag: tags.join(', ')
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || '서버 오류' });
  }
}
