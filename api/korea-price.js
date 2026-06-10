// api/korea-price.js
// Vercel Serverless Function - ES Module version
// package.json에 "type": "module" 이 있는 프로젝트용입니다.

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(statusCode).json(payload);
}

function stripHtml(input = '') {
  return String(input)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
}

function toNumber(value) {
  const n = Number(String(value ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, {
      ok: false,
      message: 'GET 방식만 지원합니다.'
    });
  }

  try {
    const query = String(req.query?.query || '').trim();

    if (!query) {
      return sendJson(res, 400, {
        ok: false,
        message: 'query 파라미터가 없습니다. 예: /api/korea-price?query=adidas%20gx4461'
      });
    }

    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return sendJson(res, 500, {
        ok: false,
        message: 'Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 없습니다.',
        hint: 'Vercel Project Settings > Environment Variables에 두 값을 추가한 뒤 Redeploy 해주세요.'
      });
    }

    const display = 20;
    const apiUrl = new URL('https://openapi.naver.com/v1/search/shop.json');
    apiUrl.searchParams.set('query', query);
    apiUrl.searchParams.set('display', String(display));
    apiUrl.searchParams.set('start', '1');
    apiUrl.searchParams.set('sort', 'asc');

    const naverRes = await fetch(apiUrl.toString(), {
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      }
    });

    const rawText = await naverRes.text();
    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      data = null;
    }

    if (!naverRes.ok) {
      return sendJson(res, naverRes.status, {
        ok: false,
        message: '네이버 쇼핑 검색 API 호출에 실패했습니다.',
        status: naverRes.status,
        naverMessage: data?.errorMessage || data?.message || rawText.slice(0, 500)
      });
    }

    const items = Array.isArray(data?.items) ? data.items : [];

    const normalizedItems = items
      .map((item) => {
        const price = toNumber(item.lprice);
        return {
          title: stripHtml(item.title),
          price,
          shippingFee: null,
          totalPrice: price,
          mallName: item.mallName || '',
          brand: item.brand || '',
          maker: item.maker || '',
          category1: item.category1 || '',
          category2: item.category2 || '',
          category3: item.category3 || '',
          category4: item.category4 || '',
          image: item.image || '',
          link: item.link || ''
        };
      })
      .filter((item) => item.price > 0)
      .sort((a, b) => a.totalPrice - b.totalPrice);

    const prices = normalizedItems.map((item) => item.totalPrice);
    const lowestPrice = prices.length ? Math.min(...prices) : 0;
    const averagePrice = prices.length
      ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length)
      : 0;

    return sendJson(res, 200, {
      ok: true,
      source: 'naver-shopping-search-api',
      query,
      count: normalizedItems.length,
      lowestPrice,
      averagePrice,
      shippingIncluded: false,
      note: '네이버 쇼핑 검색 API는 배송비 필드를 제공하지 않아 상품가 기준으로 계산합니다.',
      items: normalizedItems.slice(0, 10)
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      message: 'korea-price 함수 실행 중 예외가 발생했습니다.',
      error: error?.message || String(error)
    });
  }
}
