# X 여행 검색 Playwright MCP MVP

키워드 하나를 입력하면 OpenAI Agents SDK가 공식 Microsoft Playwright MCP를 실행해 X 최신 검색 페이지를 실제 Chrome으로 열고, 첫 화면에서 읽힌 게시물 최대 10개를 JSON으로 출력하는 로컬 검증용 CLI입니다.

## 요구 사항

- Node.js 24 LTS (`>=24 <25`)
- macOS에 설치된 Google Chrome
- `OPENAI_API_KEY`

## 설치와 실행

```bash
cd /Users/myu/Documents/yai_ai/x-trend-playwright-mvp
npm install
cp .env.example .env
# .env에 실제 OPENAI_API_KEY 입력
npm run profile:login
npm run search:raw -- 여행
npm run search -- 여행
```

기본 모델은 `gpt-5.4-mini`입니다. 다른 모델은 `.env`의 `OPENAI_MODEL`로 지정할 수 있습니다. 브라우저는 headed 모드로 열리며 로그인 상태는 `.browser-profile/`에 저장됩니다. 이 폴더와 `.env`는 Git에서 제외됩니다.

`npm run profile:login`은 같은 지속 프로필로 X 로그인 페이지를 연다. 열린 Chrome에서 직접 로그인한 뒤 터미널에서 Enter를 누르면 세션이 보존된다. 검색 실행에서 다시 로그인을 요구하면 결과가 `login_required`와 종료 코드 3으로 끝난다. 로그인·CAPTCHA·접근 제한은 자동으로 우회하지 않는다.

`npm run search:raw -- 여행`은 OpenAI API 키 없이 Playwright MCP가 X 화면 DOM에서 첫 게시물 최대 10개를 직접 읽는 연결 테스트다. `npm run search -- 여행`은 OpenAI Agent가 접근성 Snapshot을 판단하는 최종 경로다.

두 명령의 결과는 터미널 출력과 함께 `output/<UTC시각>-<키워드>.json`에 원자적으로 저장된다. `output/`은 Git에서 제외된다.

## Signal provider 확장 경계

Article 경로용 신호 수집은 X와 Google Trends를 각각 독립 port로 분리한다. provider를 생략하면 둘 다 `playwright`를 사용한다. 향후 승인된 공식 API/MCP adapter는 같은 batch shape 뒤에 등록할 수 있고 acquisition receipt만 `official_api_mcp` variant로 달라진다. 선택한 provider가 등록되지 않았으면 브라우저를 시작하기 전에 `unsupported_provider`로 실패하며 Playwright로 자동 fallback하지 않는다.

Playwright runtime은 기존 X `.browser-profile/`과 별도의 Google `.browser-profile-google-trends/`를 사용한다. 한 프로세스의 lease는 직렬 실행되고 profile별 atomic lock을 사용한다. X batch는 한 lease에서 요청 순서대로 1..3개 query를 수집한다. Google은 Related queries/topics의 Top/Rising mode를 명시적으로 확인·전환하고, Interest over time의 UI Download CSV만 읽는다. 비공식 Google endpoint/XHR와 `pytrends`는 runtime 경로에 연결하지 않는다.

두 기본 provider를 함께 구성할 때는 `createDefaultPlaywrightSignalRuntime()`을 사용한다. 이 helper는 X와 Google adapter에 하나의 `BrowserRuntime`을 주입해 process-local 직렬화 경계를 공유한다. 현재 acquisition receipt는 audit 전용이며 live provenance나 Orchestrator의 success/ready 상태로 승격할 수 없다.

현재 자동 검증은 fixture 기반이다. 실제 Google UI는 최근 429 때문에 selector 성공 smoke를 완료하지 못했으며, cardinality가 예상과 다르면 `schema_changed`, 429는 `rate_limited/unavailable`로 보존한다. 세부 미결정 사항은 [docs/AMBIGUITIES.md](../docs/AMBIGUITIES.md)에 기록한다.

## 결과 형식

```json
{
  "status": "ok",
  "posts": [
    {
      "author": "visible author",
      "text": "visible post text",
      "url": "https://x.com/user/status/123"
    }
  ],
  "message": "수집 완료",
  "keyword": "여행",
  "searchUrl": "https://x.com/search?...",
  "collectedAt": "2026-08-01T08:00:00.000Z"
}
```

MCP의 툴 호출·결과 상태는 표준 오류 스트림에 한 줄 JSON으로 출력됩니다. 최종 결과 JSON은 표준 출력으로 분리됩니다.

## 검증

```bash
npm run typecheck
npm test
```

## 제한과 주의

- 스크롤하지 않고 첫 화면의 공개 게시물만 읽습니다.
- X의 UI, 로그인 정책, CAPTCHA에 따라 실패할 수 있습니다.
- X 이용약관은 사전 서면 동의 없는 자동 스크래핑을 제한합니다. 이 코드는 로컬 기술 검증용이며 운영·판매 기능으로 사용하기 전에 별도 정책 검토가 필요합니다.
