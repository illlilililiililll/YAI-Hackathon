# Deferred Work

- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: Exact closed-world causal graph와 frozen execution-trust literal을 완성한다.
  evidence: 해커톤 수직 경로는 receipt와 hash를 보존하지만 모든 executable·prompt·artifact를 상호 재연산하는 전체 Spine proof는 구현량이 크다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: esbuild IIFE와 capability-limited vm.Script 기반 hermetic renderer를 추가한다.
  evidence: 이번 경로는 source-controlled pure renderer와 byte/hash 검증을 사용하며 별도 bundle loader는 후속 hardening으로 남긴다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: HtmlAst 전체 문법과 exhaustive PostCSS allowlist 검사를 구현한다.
  evidence: 이번 경로는 escape와 script/style/img/table/external resource 차단을 우선하고 모든 CSS selector/value 조합 증명은 보류한다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: 라이브 브라우저 causal gate가 완성된 뒤 `SIGNAL_ACQUISITION_LIVE_PROVENANCE_READY`를 증거 기반으로 승격한다.
  evidence: fixture/mock 또는 불완전 receipt를 `ready_to_publish`로 표시하는 것은 심각한 신뢰 위험이라 시간 압박으로 우회하지 않는다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: Evidence fetch를 strict Agents SDK tool call과 process-private causal receipt에 결속한다.
  evidence: 현재 fetch는 SSRF·host policy를 강제하지만 SDK call/result provenance가 없어 전체 Run은 replay preview로 제한했다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: Browser operation·lease·invocation·extractor bundle과 raw semantic audit를 sealed operations journal에 보존한다.
  evidence: current adapter-local receipt와 global raw seq는 검증하지만 publish manifest가 재연산할 complete causal bundle은 아직 없다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: RunStore가 article/evidence/quality/render/operation graph를 내부에서 schema parse·재연산·deep-equal한다.
  evidence: production validator는 fail-closed false지만, 향후 live 승격 전 boolean callback만으로는 artifact semantics를 증명할 수 없다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: Claim-surface entailment, qualification 포함, 공식 출처 충돌, temporal locator receipt gate를 추가한다.
  evidence: 이번 품질 경계는 Claim ID와 Evidence link 무결성까지 검증하며 의미적 모순·과장 판정은 publish gate 전 필수 후속 작업이다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: 실제 composition dependency bundle과 fake/live 동일 wiring E2E 테스트를 만든다.
  evidence: 현재 Orchestrator ports는 주입 테스트되지만 createArticlePipeline의 SDK·browser·fetch 조합은 API key 없는 환경에서 live 검증하지 못했다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: 실패 Run manifest/raw journal 영속화와 preview/RunStore staging 재시도 복구를 구현한다.
  evidence: 현재 terminal outcome은 fail-closed지만 transient write 실패 뒤의 forensic artifact와 retry idempotency는 보존되지 않는다.
- source_spec: `_bmad-output/implementation-artifacts/spec-hackathon-e2e-completion.md`
  summary: Source fetch의 DNS·redirect 전체를 단일 deadline으로 묶고 preflight에 Google/browser 실연결 probe를 추가한다.
  evidence: 전역 Run timeout은 있으나 개별 fetch hop 누적과 로그인·Google 화면 유효성은 첫 수집에서만 최종 확인된다.
- source_spec: `_bmad-output/implementation-artifacts/spec-require-five-field-commercial-input.md`
  summary: 미검증 프리뷰 draft의 safety·Persona 검증 계약과 현재 테스트 기대값을 별도 작업에서 다시 일치시킨다.
  evidence: 전체 suite의 기존 3개 실패는 미커밋 `unverified-preview-agent.ts` 변경에서 해당 검증이 제거된 상태와 관련되며, 이번 5필드 입력 계약 변경 범위와 독립적이다.
- source_spec: `_bmad-output/implementation-artifacts/spec-api-first-fast-trend-pipeline.md`
  summary: 제거된 publish·evidence·Playwright 계약을 전제하는 기존 테스트를 새 preview-only 계약에 맞춰 정리한다.
  evidence: 마감 우선 지시에 따라 활성 `src` 타입검사만 통과시켰고 구계약 테스트 갱신과 실행은 연기했다.
- source_spec: `_bmad-output/implementation-artifacts/spec-api-first-fast-trend-pipeline.md`
  summary: 실제 X Actor·SerpApi·Writer까지 포함하는 유료 live E2E smoke를 수행한다.
  evidence: Apify MCP 인증과 도구 목록은 확인했지만 비용이 발생하는 Actor 및 SerpApi 검색 실행은 이번 마감 작업에서 생략했다.
- source_spec: `_bmad-output/implementation-artifacts/spec-google-score-seo-fallback.md`
  summary: live API 실행과 preview 발행 provenance 표기를 별도 필드로 분리한다.
  evidence: 현재 실제 API를 호출해도 stage provenance가 replay로 표시되는 기존 계약이 있어 실행 사실과 발행 검증 상태가 한 값에 섞여 있다.
- source_spec: `_bmad-output/implementation-artifacts/spec-move-api-folder-into-project.md`
  summary: 제거되거나 변경된 활성 계약과 기존 전체 Vitest 스위트를 다시 일치시킨다.
  evidence: 전체 테스트에서 legacy Playwright 모듈 import와 기존 CLI·preflight·orchestrator·preview 기대값 불일치가 재현되지만, 이는 API 폴더 이동 전부터 존재한 별도 리팩터링 부채다.
- source_spec: `_bmad-output/implementation-artifacts/spec-brand-type-retry-seed-keyword.md`
  summary: Demo가 여는 raw Terminal watcher에 timeout과 종료 수명주기를 추가한다.
  evidence: 기존 `osascript`와 `tail -F`는 권한 대화상자에서 지연되거나 Demo 종료 뒤 남을 수 있으며, brand_type 재시도 이전부터 존재한 별도 프로세스 관리 부채다.
- source_spec: `_bmad-output/implementation-artifacts/spec-readable-live-sdk-stream.md`
  summary: 자연어 상업 입력 추출 단계의 OpenAI SDK 이벤트도 실시간 데모 이벤트 ingress에 연결한다.
  evidence: 해당 추출은 현재 article pipeline의 raw/progress 출력 연결보다 먼저 실행되어 데모 시작 직후 최대 수십 초 동안 보조 화면에 활동이 표시되지 않을 수 있다.
