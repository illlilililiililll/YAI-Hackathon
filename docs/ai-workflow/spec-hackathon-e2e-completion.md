---
title: 'Hackathon Article E2E Completion'
type: 'feature'
created: '2026-08-02'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'UNBORN_HEAD'
context:
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-yai_ai-2026-08-01/ARCHITECTURE-SPINE.md'
  - '{project-root}/docs/NEXT_SESSION_HANDOFF.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** X·Google 수집 어댑터와 causal receipt는 있으나, 키워드 하나를 실제 근거 기반 정적 글로 만드는 Orchestrator·Evidence·Writer·Renderer·RunStore 수직 경로가 없다. 해커톤 시연을 위해 분리된 조각을 실행 가능한 한 경로로 빠르게 연결해야 한다.

**Approach:** `npm run article -- "<keyword>"` 한 명령이 입력 정규화, X 후보 탐색, Google 보조 확인, 공식 출처 조사, 구조화 글 작성, 품질 검증, 정적 렌더링과 Run 저장까지 수행하는 얇은 종단 경로를 만든다. 이미 구현된 signal runtime과 strict DTO를 재사용하고 외부 경계는 주입 가능하게 만들어 fake 기반 테스트와 live 실행을 같은 계약으로 검증한다.

## Boundaries & Constraints

**Always:** Node 24 고정; Agents SDK는 `stream:true`, strict tool, `parallelToolCalls:false`, 전역 timeout을 사용한다. X·Google 신호는 주제 선택에만 쓰고 본문 사실 근거로 쓰지 않는다. 본문 Claim은 승인된 HTTPS 출처의 정확한 Evidence block과 연결한다. SDK raw event는 출력·redaction·순서 보존 JSONL 저장을 거쳐 seal한다. fixture/mock/unavailable 결과는 `ready_to_publish`로 승격하지 않는다. 렌더러는 escape하고 외부 script·style·image를 허용하지 않는다. 기존 검색 CLI와 47개 테스트를 보존한다.

**Ask First:** 새로운 유료 서비스·자격증명 도입, Spine의 불변조건 변경, 외부 배포 또는 실제 게시, 기존 사용자 데이터 삭제.

**Never:** live provenance guard를 임의 해제하거나 API 결과를 Playwright로 위장하지 않는다. source snippet·X 게시물·Google Trends를 Evidence로 쓰지 않는다. secrets를 event/artifact에 기록하지 않는다. manifest 검증 전 ready 상태를 반환하지 않는다. 자동 provider fallback이나 무제한 retry를 사용하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Happy path | 유효 키워드, live signal, 공식 Evidence 충분 | article/evidence/quality/events/HTML/CSS를 원자 저장하고 `ready_to_publish` | N/A |
| 후보 없음 | 검색 결과가 비었거나 유효 후보 0 | `no_viable_topic`, publish artifact 없음 | 종료 코드를 실패로 반환 |
| 근거 부족 | 핵심 Claim Evidence 부족 | 검색 1회 추가 후 `needs_evidence` | ready 승격 금지 |
| provider unavailable | Google 429·차단 또는 X 실패 | Google은 `unavailable`로 기록하고 X 순위 유지; X 실패는 Run 실패 | 증거와 오류를 보존 |
| unsafe source/event | private host, secret, oversized body, write 실패 | fetch/event ingestion 거절 | Run 전체 실패 |

</frozen-after-approval>

## Code Map

- `x-trend-playwright-mvp/src/content-domain.ts` -- Run, Evidence, Writer, Render 공용 strict DTO.
- `x-trend-playwright-mvp/src/playwright-signal-runtime.ts` -- 기존 X·Google signal acquisition port.
- `x-trend-playwright-mvp/src/content-orchestrator.ts` -- 상태, timeout, SDK stream과 단계 조합.
- `x-trend-playwright-mvp/src/source-*.ts`, `claim-ledger.ts`, `evidence-agent.ts` -- 공식 출처 discovery/fetch/extraction/Claim 연결.
- `x-trend-playwright-mvp/src/article-agent.ts`, `draft-assembler.ts` -- persona 적용 구조화 초안과 안전한 URL 조립.
- `x-trend-playwright-mvp/src/static-html-renderer.ts`, `run-store.ts` -- 결정적 정적 파일과 원자 저장.
- `x-trend-playwright-mvp/src/article-index.ts` -- 단일 키워드 CLI 진입점.

## Tasks & Acceptance

**Execution:**
- [x] 공용 schema와 설정 -- 단계 간 strict 계약과 code-owned 정책을 고정한다.
- [x] Runtime 트랙 -- Agents tool wrapper, raw ingress, Orchestrator, RunStore, CLI를 구현한다.
- [x] Evidence 트랙 -- web discovery, SSRF-safe fetch, source policy, ledger, 1회 보강을 구현한다.
- [x] Writer/Output 트랙 -- persona, structured draft, assembler, gate, static renderer를 구현한다.
- [x] 통합 -- 세 트랙을 한 명령에 연결하고 상태·artifact·종료 코드를 일치시킨다.
- [x] 테스트 -- matrix의 정상·실패 경로와 기존 회귀를 Node 24에서 검증한다.

**Acceptance Criteria:**
- Given 주입된 live-like providers와 충분한 Evidence, when 단일 키워드 Run을 실행하면, then 순서화된 단계와 검증 가능한 정적 artifact가 생성된다.
- Given fake/mock 또는 Evidence 부족, when Run을 실행하면, then 상태가 명시적으로 중단되고 publish-ready artifact가 없다.
- Given 동일한 승인 DTO, when renderer와 manifest를 반복 실행하면, then byte-identical 결과가 나온다.
- Given raw event, fetch, gate 또는 final manifest 검증 실패, when 처리하면, then 성공 상태가 발급되지 않는다.

## Spec Change Log

## Design Notes

해커톤 범위에서는 full cryptographic closed-world proof보다 실행 가능한 수직 경로를 우선한다. 다만 readiness 경계, Evidence lineage, redaction, SSRF, HTML escape는 축소하지 않는다. exact causal graph 완전화와 exhaustive CSS AST 검사는 deferred-work에 기록한다.

## Verification

**Commands:**
- `npm install` -- lockfile가 수정된 pinned dependencies와 일치.
- `npm run typecheck` -- TypeScript 오류 0건.
- `npm test` -- 신규 및 기존 테스트 전체 통과.
- `npm run article -- "여행"` -- preflight가 충족된 환경에서 artifact Run 생성 또는 명시적 fail-closed 상태.

## Suggested Review Order

**종단 실행과 상태 경계**

- 단일 CLI 경로가 모든 단계와 fail-closed preview 정책을 조합한다.
  [`article-pipeline.ts:194`](../../x-trend-playwright-mvp/src/article-pipeline.ts#L194)

- 상태 전이·재시도·전역 deadline·raw seal을 한 곳에서 통제한다.
  [`content-orchestrator.ts:196`](../../x-trend-playwright-mvp/src/content-orchestrator.ts#L196)

- 실행 파일·profile·key·raw 채널을 Run 생성 전에 확인한다.
  [`article-preflight.ts:65`](../../x-trend-playwright-mvp/src/article-preflight.ts#L65)

**신호와 근거 경계**

- SDK tool call 결과를 private acquisition receipt와 정확히 결속한다.
  [`agent-signal-tools.ts:123`](../../x-trend-playwright-mvp/src/agent-signal-tools.ts#L123)

- 공식 host만 DNS·outbound 전에 허용하고 Evidence를 두 번까지만 조사한다.
  [`evidence-agent.ts:84`](../../x-trend-playwright-mvp/src/evidence-agent.ts#L84)

- HTTPS·public IP pinning·redirect·크기·문자셋 제한을 fetch 경계에서 강제한다.
  [`source-fetch.ts:398`](../../x-trend-playwright-mvp/src/source-fetch.ts#L398)

- hosted web search의 typed action.sources만 출처 후보로 투영한다.
  [`openai-content-providers.ts:75`](../../x-trend-playwright-mvp/src/openai-content-providers.ts#L75)

**작성·품질·정적 출력**

- 구조화 초안의 ID·Claim·H2·repair 불변조건을 검증한다.
  [`article-agent.ts:343`](../../x-trend-playwright-mvp/src/article-agent.ts#L343)

- Evidence·freshness·integrity·persona·SEO·GEO·safety gate를 집계한다.
  [`quality-gates.ts:216`](../../x-trend-playwright-mvp/src/quality-gates.ts#L216)

- canonical article을 escape된 로컬 HTML/CSS bytes로 렌더링한다.
  [`static-html-renderer.ts:198`](../../x-trend-playwright-mvp/src/static-html-renderer.ts#L198)

- DOM surface와 canonical text/hash를 다시 대조한다.
  [`render-integrity-v1.ts:78`](../../x-trend-playwright-mvp/src/render-integrity-v1.ts#L78)

**저장과 검증**

- manifest-last·fsync·atomic rename으로 publishable Run을 저장한다.
  [`run-store.ts:216`](../../x-trend-playwright-mvp/src/run-store.ts#L216)

- 상태머신의 성공·중단·repair·deadline 경로를 fake ports로 검증한다.
  [`content-orchestrator.test.ts:51`](../../x-trend-playwright-mvp/test/content-orchestrator.test.ts#L51)

- SSRF와 근거 재조사·차단 분류 회귀를 고정한다.
  [`evidence-agent.test.ts:192`](../../x-trend-playwright-mvp/test/evidence-agent.test.ts#L192)

- Writer부터 deterministic HTML까지 전체 출력 계약을 검증한다.
  [`article-output-pipeline.test.ts:215`](../../x-trend-playwright-mvp/test/article-output-pipeline.test.ts#L215)
