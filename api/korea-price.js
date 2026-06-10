// Vercel Serverless Function
// Route: /api/korea-price?query=상품명
// Env: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
// 이 버전은 fetch 미지원/네이버 오류/환경변수 누락 시에도 Vercel 함수가 크래시하지 않고 JSON으로 원인을 반환합니다.

const https = require('https');

const NAVER_SHOP_HOST = 'openapi.naver.com';
const NAVER_SHOP_PATH = '/v1/search/shop.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

function json(res, statusCode, payload) {
  setCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  const n = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function requestNaverShop({ query, display, sort }) {
  return new Promise((resolve, reject) => {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      const e = new Error('Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 없습니다.');
      e.statusCode = 500;
      return reject(e);
    }

    const params = new URLSearchParams({
      query,
      display: String(Math.min(Math.max(Number(display) || 10, 1), 100)),
      start: '1',
      sort: sort || 'sim'
    });

    const options = {
      hostname: NAVER_SHOP_HOST,
      path: `${NAVER_SHOP_PATH}?${params.toString()}`,
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
        'Accept': 'application/json',
        'User-Agent': 'margin-price-checker/1.0'
      },
      timeout: 10000
    };

    const req = https.request(options, (naverRes) => {
      let body = '';
      naverRes.setEncoding('utf8');
      naverRes.on('data', (chunk) => { body += chunk; });
      naverRes.on('end', () => {
        let data = {};
        try {
          data = body ? JSON.parse(body) : {};
        } catch (parseError) {
          const e = new Error(`네이버 API 응답 JSON 파싱 실패: ${body.slice(0, 200)}`);
          e.statusCode = 502;
          return reject(e);
        }

        if (naverRes.statusCode < 200 || naverRes.statusCode >= 300) {
          const e = new Error(data.errorMessage || data.message || `Naver API HTTP ${naverRes.statusCode}`);
          e.statusCode = naverRes.statusCode || 502;
          e.detail = data;
          return reject(e);
        }

        resolve(data);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('네이버 API 요청 시간이 초과되었습니다.'));
    });

    req.on('error', (error) => {
      error.statusCode = 502;
      reject(error);
    });

    req.end();
  });
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const price = toNumber(item.lprice);
      return {
        title: stripHtml(item.title),
        link: item.link || '',
        image: item.image || '',
        mallName: stripHtml(item.mallName),
        brand: stripHtml(item.brand),
        maker: stripHtml(item.maker),
        category1: stripHtml(item.category1),
        category2: stripHtml(item.category2),
        category3: stripHtml(item.category3),
        category4: stripHtml(item.category4),
        productId: item.productId || '',
        productType: item.productType || '',
        price,
        shippingFee: 0,
        totalPrice: price,
        shippingIncluded: false
      };
    })
    .filter((item) => item.price > 0);
}

module.exports = async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    if (req.method !== 'GET') {
      return json(res, 405, { ok: false, message: 'GET 요청만 지원합니다.' });
    }

    const query = String((req.query && req.query.query) || '').replace(/\s+/g, ' ').trim();

    if (!query || query.length < 2) {
      return json(res, 400, { ok: false, message: 'query 파라미터에 상품명을 입력해주세요.' });
    }

    const lowestRaw = await requestNaverShop({ query, display: 10, sort: 'asc' });
    const averageRaw = await requestNaverShop({ query, display: 30, sort: 'sim' });

    const lowestItems = normalizeItems(lowestRaw.items);
    const averageItems = normalizeItems(averageRaw.items);
    const averageSource = averageItems.length ? averageItems : lowestItems;

    const lowestPrice = lowestItems.length ? Math.min(...lowestItems.map((item) => item.totalPrice)) : 0;
    const averagePrice = averageSource.length
      ? Math.round(averageSource.reduce((sum, item) => sum + item.totalPrice, 0) / averageSource.length)
      : 0;

    return json(res, 200, {
      ok: true,
      source: 'naver-shopping-search-api',
      query,
      total: Number(averageRaw.total || lowestRaw.total || 0),
      count: averageSource.length,
      priceBasis: 'product',
      shippingIncluded: false,
      message: '네이버 쇼핑 검색 API는 배송비 필드를 제공하지 않아 상품가 기준으로 반환합니다.',
      lowestPrice,
      averagePrice,
      items: lowestItems.slice(0, 10)
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      ok: false,
      message: error.message || '국내가 조회 중 오류가 발생했습니다.',
      hint: 'Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 설정 후 Redeploy 했는지 확인하세요.',
      detail: error.detail || null
    });
  }
};
