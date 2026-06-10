# 일본 구매대행 마진 계산기 - 상품정보 프록시 API

## 파일 구성

- `api/product.js`: 쇼핑몰 URL을 받아 상품명/가격/무게를 JSON으로 반환하는 Vercel API
- `package.json`: Vercel 배포에 필요한 의존성

## 배포 순서

1. GitHub에서 새 저장소를 만듭니다.
2. 이 폴더 안의 `api` 폴더와 `package.json`을 업로드합니다.
3. Vercel에서 GitHub 저장소를 Import합니다.
4. Deploy를 누릅니다.
5. 배포 주소가 예를 들어 `https://margin-proxy.vercel.app`이면, HTML 파일의 아래 줄을 바꿉니다.

```js
const PRODUCT_API_BASE = 'https://YOUR-VERCEL-PROJECT.vercel.app';
```

아래처럼 변경합니다.

```js
const PRODUCT_API_BASE = 'https://margin-proxy.vercel.app';
```

## 테스트 주소

브라우저에서 아래처럼 열어봅니다.

```text
https://내-vercel-주소.vercel.app/api/product?url=https%3A%2F%2Fitem.rakuten.co.jp%2F...
```

`{"ok":true,...}` 형태가 나오면 정상입니다.
