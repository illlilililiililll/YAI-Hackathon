# 구현 모호성 기록

## Signal Provider Runtime Slice — 2026-08-02

- Google Trends 실제 Explore UI는 2026-08-01 smoke에서 HTTP 429를 반환했다. 따라서 Top/Rising control의 실제 접근성 이름·card별 개수는 합성된 실제형 snapshot으로만 검증했다. 런타임은 예상 cardinality가 다르면 `schema_changed`로 닫고 control을 추측하지 않는다.
- Google Trends의 향후 `official_api_mcp` provider는 등록 seam과 acquisition receipt variant만 고정했다. 승인된 공식 endpoint, 인증 방식, `providerContractVersion`, raw observation 동등성 규칙이 합의되기 전에는 adapter를 등록하지 않으며 Playwright로 fallback하지 않는다.
- X batch는 화면에 timestamp가 명시되지 않은 기존 DOM 추출을 재사용하므로 `visibleTimestamp`를 `null`로 보존한다. 화면에서 보이지 않는 시간을 추정하지 않는다.
- profile lock은 MCP 종료 성공 후에만 제거한다. 종료 실패로 남은 lock의 자동 stale 판단·강제 해제는 이번 slice에서 구현하지 않았다. 데모 preflight에서 원인을 확인한 뒤 사람의 명시적 판단으로만 처리해야 한다.
- Playwright MCP가 제공하는 stable public server-info API가 현재 adapter 경계에 없다. lease receipt는 실제 `connect()` 성공과 runtime descriptor hash를 결속하지만, 향후 SDK가 negotiated server info를 노출하면 그 exact projection으로 교체해야 한다.
- Google mode 전환 fixture는 각 누락 card에 직접 선택 가능한 `Top`/`Rising` 접근성 control이 하나씩 나타나는 형태다. 실제 UI가 dropdown open과 option select의 2단계라면 selector owner만 수정하고 observation/provider port 및 scorer는 유지한다.
- 현재 acquisition receipt는 adapter-local audit 증거일 뿐 live `ObservationProvenance`가 아니다. fixture/mock도 `BrowserRuntime`을 실행할 수 있고, 완전한 download receipt 증거·deterministic extractor replay·branded live MCP capability가 아직 없다. `assertSignalAcquisitionMayBecomeLiveProvenance()`가 승격을 항상 차단하며 Orchestrator의 success/ready 경로에는 연결하지 않았다.
