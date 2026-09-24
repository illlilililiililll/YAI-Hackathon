---
title: '5필드 상업 입력 계약 강제'
type: 'feature'
created: '2026-08-02'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'fcb99c66cfbd661072422574b17c702753155016'
context:
  - '{project-root}/project-context.md'
  - '{project-root}/docs/writer-persona.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 현재 CLI가 자연어를 규칙으로 추론하고 누락값을 유럽 여행 기본값으로 채워, 서로 다른 브랜드·업종·독자·상품 맥락이 섞이는 잘못된 실행을 허용한다.

**Approach:** 사용자 실행 입력을 `brand_name`, `brand_type`, `target_reader`, `offering`, `cta_goal` 다섯 개의 명시적 `key:value` 필드로 고정한다. 별도 `search_topic` 입력, 추론, 기본값과 별칭을 제거하고, 입력이 완전하고 일관될 때만 `offering`을 검색 seed로 사용해 외부 호출을 시작한다.

## Boundaries & Constraints

**Always:** 다섯 canonical key를 각각 정확히 한 번 요구한다. 모든 반환 필드는 `source: "explicit"`이다. 누락·중복·빈 값·미인식 key·잔여 자연어와 `brand_type`·`target_reader`·`offering` 간 지역 충돌은 preflight 및 외부 호출 전에 실패한다. 기존 안전 검증과 미커밋 사용자 변경을 보존한다.

**Ask First:** AI 자동 채우기 또는 대화형 확인 UI 추가, 기존 저장 산출물 마이그레이션, 다섯 필드 외 새 필드 추가가 필요하면 먼저 사용자 승인을 받는다.

**Never:** 유럽 등 지역 기본값을 삽입하지 않는다. 누락값이나 검색 주제를 자연어 규칙·AI로 조용히 생성하지 않는다. `search_topic`, `topic`, `keyword`를 여섯 번째 실행 입력으로 받지 않는다. 테스트에서 외부 API나 브라우저를 호출하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 정상 입력 | 세미콜론 또는 줄바꿈으로 구분된 정확한 다섯 필드 | 다섯 필드만 `explicit` source로 반환하고 실행 진행 | N/A |
| 누락·빈 값 | 하나 이상의 필드가 없거나 값이 비어 있음 | 실행하지 않음 | 누락 필드명을 포함한 입력 오류 |
| 비정규 입력 | 자연어, unknown key, `search_topic`/별칭, 중복 key, 잔여 텍스트 | 실행하지 않음 | 해당 segment/key를 포함한 입력 오류 |
| 지역 충돌 | `brand_type`, `target_reader`, `offering`에 서로 다른 알려진 지역 | 실행하지 않음 | 충돌한 필드와 지역을 표시 |
| 안전 위반 | URL/markup/제어문자/가격·특가·보장 또는 미지원 CTA | 실행하지 않음 | 기존 안전 오류 유지 |

</frozen-after-approval>

## Code Map

- `x-trend-playwright-mvp/src/commercial-context.ts` -- 5필드 strict parser와 public schema의 단일 소유자.
- `x-trend-playwright-mvp/src/article-index.ts` -- 입력 오류를 preflight 전에 종료하고 사용법을 표시하는 CLI 진입점.
- `x-trend-playwright-mvp/src/article-pipeline.ts` -- commercial progress 및 Persona 입력 소비자; 기존 사용자 수정과 겹치는 최소 라인만 변경.
- `x-trend-playwright-mvp/src/content-domain.ts` -- `PersonaSnapshotV1` 및 상업 입력 소비자 schema.
- `x-trend-playwright-mvp/src/writer-persona.ts` -- Persona runtime 입력과 identity hash.
- `x-trend-playwright-mvp/src/unverified-preview-renderer.ts` -- 프리뷰 브랜드 표시 소비자.
- `docs/writer-persona.md` -- PersonaSnapshot identity 문서의 공식 원본.
- `x-trend-playwright-mvp/test/commercial-context.test.ts` -- strict 입력 경계 단위 테스트.
- `x-trend-playwright-mvp/test/writer-persona.test.ts`, `x-trend-playwright-mvp/test/article-output-pipeline.test.ts`, `x-trend-playwright-mvp/test/unverified-preview.test.ts` -- 입력·Persona fixture와 회귀 테스트.

## Tasks & Acceptance

**Execution:**
- [x] `x-trend-playwright-mvp/src/commercial-context.ts` -- 추론/default/별칭/`search_topic`을 제거하고 정확한 5필드 parser 및 지역 일관성 검사를 구현한다.
- [x] `x-trend-playwright-mvp/src/article-index.ts`, `x-trend-playwright-mvp/src/article-progress.ts` -- 사용법과 progress 계약을 explicit 5필드에 맞춘다.
- [x] Pipeline·Persona·프리뷰 관련 Code Map 파일 -- `brand_type`/`brandType`을 유지하고 `offering`을 검색 seed로 연결하되 기존 사용자 변경을 보존한다.
- [x] 관련 테스트 -- 정상, 필드별 누락, 중복, unknown/별칭/자연어, 빈 값, 안전 위반, 지역 충돌과 소비자 fixture를 갱신한다.

**Acceptance Criteria:**
- Given 정확한 다섯 필드가 모두 명시된 입력, when CLI 입력을 파싱하면, then 정확히 다섯 값만 explicit source로 생성된다.
- Given 불완전하거나 비정규인 입력, when CLI를 실행하면, then 브라우저·OpenAI·preflight 전에 종료 코드 2로 실패하고 원인을 표시한다.
- Given 성공한 context와 progress/preview 산출물, when 구조를 검사하면, then 정확한 5필드와 `brand_type`이 존재하고 `search_topic`, `inferred`, `default`가 존재하지 않는다.
- Given 기존 미커밋 프리뷰·Persona 개선 코드, when 변경 diff를 비교하면, then 입력 계약과 직접 관련 없는 수정은 그대로 남는다.

## Spec Change Log

## Design Notes

현재 CLI에는 확인 UI가 없으므로 자연어 자동 채우기는 이번 범위에서 실행 계약에 포함하지 않는다. `brand_type`은 필수 상업 정보이자 Persona identity에 유지한다. 별도 검색 주제를 만들지 않고 명시적으로 받은 `offering`을 검색 seed로 사용한다. 이 결정은 기존 PRD의 기본값 허용보다 최신 사용자 지시를 우선한다.

## Verification

**Commands:**
- `npm run typecheck` -- TypeScript 오류 0건.
- `npm test -- test/commercial-context.test.ts test/writer-persona.test.ts test/article-output-pipeline.test.ts` -- 변경 경계 테스트 통과.
- `npm test` -- 전체 회귀 테스트 통과.

**Observed:**
- TypeScript와 입력 계약 관련 19개 테스트는 통과했다.
- 자연어 단독 CLI 입력은 preflight 전에 종료 코드 2로 거절된다.
- 전체 suite는 29/30 파일, 104/107 테스트가 통과했다. 남은 3건은 기존 미커밋 `unverified-preview-agent.ts`에서 safety/persona 검증이 제거된 상태와 관련되며 이번 입력 계약 범위 밖이다.

## Suggested Review Order

**입력 경계**

- CLI가 다섯 필드를 먼저 파싱하고 실패 시 preflight 전에 종료한다.
  [`article-index.ts:13`](../../x-trend-playwright-mvp/src/article-index.ts#L13)

- Public schema와 parser가 정확한 canonical 5필드만 허용한다.
  [`commercial-context.ts:25`](../../x-trend-playwright-mvp/src/commercial-context.ts#L25)

- 누락·중복·추가 colon·잔여 지시를 명시적으로 거절한다.
  [`commercial-context.ts:203`](../../x-trend-playwright-mvp/src/commercial-context.ts#L203)

**하류 연결**

- `offering`이 유일한 검색 seed이며 별도 주제 입력은 없다.
  [`article-pipeline.ts:253`](../../x-trend-playwright-mvp/src/article-pipeline.ts#L253)

- progress와 Persona에 5필드 및 `brand_type`을 그대로 유지한다.
  [`article-pipeline.ts:264`](../../x-trend-playwright-mvp/src/article-pipeline.ts#L264)

- progress 타입도 정확한 다섯 explicit 필드로 닫는다.
  [`article-progress.ts:7`](../../x-trend-playwright-mvp/src/article-progress.ts#L7)

**검증과 데모**

- 정상·누락·오염·안전·지역 충돌 계약을 단위 검증한다.
  [`commercial-context.test.ts:26`](../../x-trend-playwright-mvp/test/commercial-context.test.ts#L26)

- 잘못된 CLI 입력이 외부 작업 전에 종료되는지 검증한다.
  [`article-cli-options.test.ts:34`](../../x-trend-playwright-mvp/test/article-cli-options.test.ts#L34)

- 데모 명령도 동일한 5필드 계약을 사용한다.
  [`LIVE_DEMO_GUIDE.md:77`](../../docs/LIVE_DEMO_GUIDE.md#L77)
