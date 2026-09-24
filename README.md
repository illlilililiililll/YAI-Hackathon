# Rankwave — 트렌드 기반 여행 콘텐츠 생성 에이전트

**YAI AGENT:24 해커톤** (2026.08.01–02, 24시간) 출품작 · Team F

실시간 트렌드(X, Google Trends)를 분석해 브랜드 유입용 SEO 여행 콘텐츠를 자동으로 작성하는 AI 에이전트입니다.

## 핵심 설계: AI가 틀린 글을 쓰지 못하게 하는 두 겹의 검증

**1. 입력 계약** — [`commercial-context.ts`](x-trend-playwright-mvp/src/commercial-context.ts)
- 브랜드명·업종·타깃 독자·상품·CTA 목표 5개 필드를 명시적으로만 받습니다. 추측하거나 기본값으로 채우지 않습니다.
- 가격·할인·"무료"·"보장" 같은 표현, URL·마크업, 필드 간 지역 불일치는 차단합니다.
- 이 검증은 브라우저·OpenAI·외부 API 호출보다 **먼저** 실행되어, 잘못된 입력으로 비용이 나가지 않습니다.

**2. 출력 품질 게이트** — [`quality-gates.ts`](x-trend-playwright-mvp/src/quality-gates.ts)
- 생성된 글은 무결성·SEO·GEO·안전성 게이트를 통과해야 결과로 인정됩니다.
- 고칠 수 있는 실패는 한 번 다시 쓰게 하고, 그래도 안 되면 실패로 처리합니다.
- 근거는 정부·관광청 같은 공식 출처에서만 가져옵니다.

## AI 활용 방식

- **OpenAI Codex + BMAD 스펙 우선 워크플로**로 24시간을 20개가 넘는 작은 구현 스펙으로 나눠, 스펙마다 경계와 인수 조건을 정하고 구현·테스트를 반복했습니다. 일부 스펙은 [`docs/ai-workflow/`](docs/ai-workflow/)에 있습니다.
- 에이전트가 비밀값 파일(`.env`)을 절대 읽지 못하도록 규칙으로 보안 경계를 먼저 정했습니다.
- 검증이 끝나지 않은 결과는 "발행 가능"으로 표시하지 않고 미리보기로 제한했으며, 남은 검증은 [`deferred-work.md`](docs/ai-workflow/deferred-work.md)에 기록했습니다.

## 구성

| 경로 | 내용 |
|---|---|
| `x-trend-playwright-mvp/src` | 에이전트 파이프라인, 입력·출력 검증, 수집 런타임 |
| `x-trend-playwright-mvp/test` | 테스트 파일 30개 (정상 흐름과 실패해야 하는 경우) |
| `API/` | Google Trends·X 수집 설정 |
| `docs/` | 데모 가이드, 페르소나, 작업 인계 문서 |

## 스택

TypeScript · Zod v4 · OpenAI Agents SDK · Playwright MCP

## 실행

[`x-trend-playwright-mvp/README.md`](x-trend-playwright-mvp/README.md)와 [`docs/LIVE_DEMO_GUIDE.md`](docs/LIVE_DEMO_GUIDE.md)를 참고하세요.

## 팀

- 유민규 ([@Minkyu01](https://github.com/Minkyu01)) — 에이전트 파이프라인, 입력·출력 검증, 테스트
- [@illlilililiililll](https://github.com/illlilililiililll) — Google Trends·X 수집 API 설정
