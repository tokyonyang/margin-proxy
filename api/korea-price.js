// Vercel Serverless Function
// 경로: /api/korea-price?query=상품명
// 필요 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET

const NAVER_SHOP_API = 'https://openapi.naver.com/v1/search/shop.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function requestNaverShop({ query, display = 30, sort = 'sim' }) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error('Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 없습니다.');
    err.statusCode = 500;
    throw err;
  }

  const url = new URL(NAVER_SHOP_API);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(Math.min(Math.max(Number(display) || 10, 1), 100)));
  url.searchParams.set('start', '1');
  url.searchParams.set('sort', sort);
  // 국내 시세 비교 목적: 중고/렌탈/해외직구·구매대행 후보 제외
  url.searchParams.set('exclude', 'used:rental:cbshop');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
      'Accept': 'application/json'
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(data.errorMessage || data.message || `Naver API HTTP ${response.status}`);
    err.statusCode = response.status;
    err.detail = data;
    throw err;
  }

  return data;
}

function normalizeItems(items = []) {
  return items
    .map((item) => {
      const price = toNumber(item.lprice);
      return {
        title: stripHtml(item.title),
        link: item.link || '',
        image: item.image || '',
        mallName: stripHtml(item.mallName || ''),
        brand: stripHtml(item.brand || ''),
        maker: stripHtml(item.maker || ''),
        category1: stripHtml(item.category1 || ''),
        category2: stripHtml(item.category2 || ''),
        category3: stripHtml(item.category3 || ''),
        category4: stripHtml(item.category4 || ''),
        productId: item.productId || '',
        productType: item.productType || '',
        price,
        shippingFee: 0,
        totalPrice: price,
        // 네이버 쇼핑 검색 공식 API에는 배송비 필드가 없습니다.
        shippingIncluded: false
      };
    })
    .filter((item) => item.price > 0);
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'GET 요청만 지원합니다.' });
  }

  const query = String(req.query.query || '').replace(/\s+/g, ' ').trim();

  if (!query || query.length < 2) {
    return res.status(400).json({ ok: false, message: 'query 파라미터에 상품명을 입력해주세요.' });
  }

  try {
    // 최저가는 가격순 오름차순, 평균가는 정확도순 결과 기준으로 계산합니다.
    const [lowestRaw, averageRaw] = await Promise.all([
      requestNaverShop({ query, display: 10, sort: 'asc' }),
      requestNaverShop({ query, display: 30, sort: 'sim' })
    ]);

    const lowestItems = normalizeItems(lowestRaw.items || []);
    const averageItems = normalizeItems(averageRaw.items || []);
    const averageSource = averageItems.length ? averageItems : lowestItems;

    const lowestPrice = lowestItems.length
      ? Math.min(...lowestItems.map((item) => item.totalPrice))
      : 0;

    const averagePrice = averageSource.length
      ? Math.round(averageSource.reduce((sum, item) => sum + item.totalPrice, 0) / averageSource.length)
      : 0;

    return res.status(200).json({
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
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || '국내가 조회 중 오류가 발생했습니다.',
      detail: error.detail || undefined
    });
  }
};
