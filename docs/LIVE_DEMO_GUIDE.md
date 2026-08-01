# 라이브 데모 실행 가이드

상업 입력 하나로 Apify MCP X 수집, SerpApi Google Trends 평가, OpenAI Agents SDK 실행, 실시간 SDK 이벤트 표시, HTML 미리보기 생성을 시연한다. 현재 파이프라인은 빠른 `PREVIEW_ONLY` 결과를 만든다.

## 데모에서 보여줄 항목

1. Apify MCP와 SerpApi로 X·Google Trends 신호를 실제 수집한다.
2. 보조 화면에서 SDK envelope와 파이프라인 상태를 실시간 요약 표시한다.
3. 주 화면에서 최종 실행 상태와 미리보기 경로를 확인한다.
4. 생성된 `index.html`을 브라우저로 연다.

라이브 피드에는 Agents SDK의 `raw_model_stream_event`, `run_item_stream_event`, `agent_updated_stream_event` envelope와 파이프라인 상태 이벤트가 함께 기록된다. API 서버의 원본 Server-Sent Events(SSE) 바이트가 아니라 SDK가 공개한 이벤트 객체이며, 민감한 값은 `[REDACTED]`로 대체된다. 성공 시 canonical SDK journal은 결과 폴더의 `events.jsonl`에도 저장된다.

## 사전 조건

- Node.js 24
- 설치된 프로젝트 의존성
- 설정된 `OPENAI_API_KEY`, `APIFY_TOKEN`, `SERPAPI_API_KEY`

프로젝트의 `.nvmrc`는 Node 24를 지정한다. 컴퓨터의 기본 Node가 25여도 데모 터미널에서만 24로 전환하면 된다. 이 전환은 시스템 Node를 삭제하거나 영구적으로 낮추지 않는다.

## 1. Node 24로 임시 전환

다음 예시는 `nvm`을 사용한다.

```bash
cd /Users/myu/Documents/yai_ai/x-trend-playwright-mvp
nvm install 24
nvm use 24
node --version
```

마지막 명령은 `v24.x.x`를 출력해야 한다. `nvm` 대신 다른 Node 버전 관리자를 사용한다면 현재 터미널에서 Node 24를 선택한다.

데모가 끝난 뒤 기본 버전으로 돌아가려면 다음 명령을 실행한다.

```bash
nvm use default
```

## 2. 코드와 테스트 확인

```bash
npm run typecheck
```

명령이 오류 없이 끝나야 한다. 실패하면 라이브 API를 호출하기 전에 원인을 해결한다.

## 3. 환경 준비

프로젝트 루트의 `.env` 또는 `src/.env`에 필수 키를 설정한다. 애플리케이션 실행 명령이 환경 파일을 직접 로드한다.

## 4. 한 번에 데모 실행

프로젝트 폴더에서 다음 명령 한 줄만 실행한다.

```bash
cd /Users/myu/Documents/yai_ai/x-trend-playwright-mvp
npm --silent run demo -- "트래블메이트라는 일본 전문 여행사야. 일본 여행을 준비하는 가족에게 일본 패키지 여행상품을 소개하고 문의를 받고 싶어."
```

이 명령이 고유한 원본 로그 생성, 실시간 이벤트 요약, 파이프라인 실행을 모두 처리한다. macOS Terminal 창을 하나 더 자동으로 열어 두 번째 창에는 가공하지 않은 JSONL 원문만 실시간 표시한다. 주 터미널에는 읽기 쉬운 요약과 최종 결과를 표시하고, 성공하면 마지막에 클릭 가능한 `WEBSITE URL`을 다시 출력한다. `LIVE LOG` 경로를 복사하거나 `YAI_LIVE_LOG`, `tail`, `2>>`를 직접 입력할 필요가 없다.

두 번째 원문 창은 데모가 끝난 뒤 `Ctrl+C`로 종료한다. Terminal 자동 실행이 차단되면 주 터미널에 동일한 원문을 여는 `tail` 명령이 출력된다.

주 터미널은 실제 데이터 흐름을 다음 순서로 표시한다.

1. `START`: X에 전달되는 최초 검색어
2. `X RESULT`: 선택된 X 게시물 요약
3. `TREND INPUT`: X 원문에서 추출해 Google Trends에 전달한 키워드 6개
4. `TREND RANK`: 상승·추세·군집·의도 점수, 실제 가중치, 선점점수 우선순위
5. `WRITER KEY/CTX`: Writer에 전달한 최종 주·보조 키워드와 캠페인 정보

## 5. 두 터미널로 분리해서 실행하기

두 화면을 반드시 따로 보여줘야 할 때만 아래 수동 방식을 사용한다.

### 실시간 이벤트 화면 준비

보조 터미널에서 다음 명령을 실행한다.

```bash
npm --silent run demo:watch
```

이 터미널은 `LIVE LOG: /tmp/yai-live-stream.XXXXXX` 형식으로 이번 데모의 고유 로그 경로를 먼저 출력한다. 해당 경로를 복사한다. 문자 단위 delta는 1초 단위 진행 상태로 묶고 중복 래퍼는 숨긴다. 단계, Agent, `tool_call`, `tool_result`, 완료, 오류는 아이콘 없이 정렬된 텍스트로 표시한다. 라이브 피드 파일은 종료 후에도 삭제하지 않는다.

현재 CLI는 사전점검 메시지도 표준 오류에 기록한다. 따라서 첫 Raw 이벤트 전에 `[preflight]`로 시작하는 일반 텍스트 한두 줄이 나타날 수 있다.

### 라이브 파이프라인 실행

주 터미널에서 다음 명령을 실행한다.

```bash
cd /Users/myu/Documents/yai_ai/x-trend-playwright-mvp
nvm use 24
YAI_LIVE_LOG="/tmp/yai-live-stream.보조-터미널에서-복사한-값"
npm --silent run article -- \
  "트래블메이트라는 일본 전문 여행사야. 일본 여행을 준비하는 가족에게 일본 패키지 여행상품을 소개하고 문의를 받고 싶어." \
  2>> "$YAI_LIVE_LOG"
```

다음 순서로 데모가 진행된다.

1. OpenAI가 자연어 입력을 상업 컨텍스트로 해석한다.
2. Apify MCP에서 X 원문을 수집하고 선택한다.
3. OpenAI가 SEO 키워드 6개를 생성한다.
4. SerpApi 기반 Google Trends 점수로 최고 키워드를 선택한다.
5. 글과 HTML/CSS 미리보기를 생성한다.

주 터미널의 표준 출력에는 최종 결과 JSON만 남는다. 보조 터미널에는 파이프라인과 Agents SDK 이벤트가 실시간으로 요약 표시된다.

## 6. 결과 미리보기

최종 JSON의 `websiteUrl`을 터미널에서 클릭하거나 다음처럼 연다.

```bash
open "<websiteUrl>"
```

## 문제 해결

### Node.js 24가 필요하다는 오류

현재 터미널에서 `nvm use 24`를 다시 실행하고 `node --version`을 확인한다.

### `nvm: command not found`

현재 셸에 `nvm`이 설치되어 있거나 로드되어 있는지 확인한다. `nvm`을 사용하지 않는 환경이라면 설치된 Node 버전 관리자로 Node 24를 선택한다. Node 25를 제거할 필요는 없다.

### Apify MCP X 호출 실패

최종 오류 코드가 `x_provider_failed`인지 확인한다. `APIFY_TOKEN` 설정과 네트워크 상태는 사용자가 직접 확인한다.

### Google Trends가 `rate_limited`를 반환함

반복 실행을 중단하고 잠시 기다린다. 데모 직전에 같은 키워드로 여러 번 연속 실행하지 않는다.

### `previewDirectory`가 없음

파이프라인이 렌더링 전에 종료된 상태다. 최종 JSON의 `errorCode`와 보조 터미널에 표시된 LIVE LOG 파일의 마지막 이벤트를 확인한다.

### 보조 화면에 이벤트가 표시되지 않음

주 터미널의 `2>>` 뒤 경로가 보조 터미널에 출력된 `LIVE LOG` 경로와 정확히 같은지 확인한다. 보조 터미널은 주 터미널보다 먼저 실행한다.

## 데모 종료

보조 터미널에서 `Ctrl+C`를 눌러 `tail`을 종료한다. Node 버전을 되돌리려면 `nvm use default`를 실행한다.
