"""여러 키워드의 Google Trends 기반 점수를 JSON 리스트로 반환한다.

최종 점수는 최근 30일 데이터를 이용한 절대점수(0~1)다.

- rising_score: Breakout/증가율/상위 검색어 존재 여부로 계산한다.
- trend_score: 스파이크·희소·지속 패턴에 따라 계산한다.
- cluster_score: 고유 관련 토픽 5개를 1점 기준으로 계산한다.
- intent_score: 의도 수식어가 있으면 1.0, 없으면 0.4다.
- preemption_score: 네 점수의 패턴별 가중합이다.

키워드 하나당 TIMESERIES, RELATED_QUERIES, RELATED_TOPICS 총 3회 요청한다.
공개 함수 analyze_keywords()는 반드시 비어 있지 않은 list[str]을 입력받는다.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://serpapi.com/search"
SEARCH_GEO = "KR"
# 서비스 성격에 맞게 자유롭게 추가/삭제할 수 있다.
INTENT_PATTERNS: dict[str, tuple[str, ...]] = {
    "구매": ("구매", "가격", "최저가", "할인", "쿠폰", "판매", "주문", "buy", "price", "discount"),
    "비교": ("비교", "추천", "순위", "후기", "리뷰", "장단점", "vs", "best", "review"),
    "정보": ("방법", "사용법", "뜻", "원리", "가이드", "튜토리얼", "강의", "how", "what", "guide"),
    "행동": ("다운로드", "설치", "가입", "예약", "신청", "무료", "download", "install", "signup"),
}

BREAKOUT_LABELS = ("breakout", "급등", "급상승", "폭발적 증가", "record")


def serpapi_request(api_key: str, keyword: str, data_type: str, geo: str, date: str) -> dict[str, Any]:
    params = {
        "engine": "google_trends",
        "q": keyword,
        "hl": "ko",
        "geo": geo,
        "date": date,
        "tz": "-540",  # Asia/Seoul (SerpApi 표기 방식)
        "data_type": data_type,
        "api_key": api_key,
    }
    request = Request(f"{API_URL}?{urlencode(params)}", headers={"Accept": "application/json"})

    try:
        with urlopen(request, timeout=45) as response:
            result = json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"네트워크 오류: {error.reason}") from error

    if result.get("error"):
        raise RuntimeError(str(result["error"]))
    return result


def parse_percent(label: Any) -> float | None:
    """'+1,250%' 같은 표시 문자열을 1250.0으로 변환한다."""
    if not isinstance(label, str):
        return None
    match = re.search(r"([+-]?[\d,.]+)\s*%", label)
    if not match:
        return None
    try:
        return float(match.group(1).replace(",", ""))
    except ValueError:
        return None


def calculate_rising_score(response: dict[str, Any]) -> dict[str, Any]:
    related = response.get("related_queries", {}) or {}
    items = related.get("rising", []) or []
    top_items = related.get("top", []) or []
    breakout = False
    percentages: list[float] = []

    for item in items:
        label = str(item.get("value", ""))
        lowered = label.casefold()
        if any(marker in lowered for marker in BREAKOUT_LABELS):
            breakout = True

        parsed = parse_percent(label)
        if parsed is None and isinstance(item.get("extracted_value"), (int, float)):
            parsed = float(item["extracted_value"])
        if parsed is not None:
            percentages.append(max(0.0, parsed))

    max_percent = max(percentages, default=0.0)
    if breakout:
        score = 1.0
    elif percentages:
        score = min(max_percent / 500.0, 1.0)
    elif top_items:
        score = 0.3
    else:
        score = 0.0

    return {
        "rising_score": round(score, 4),
        "rising_breakout": breakout,
        "rising_max_percent": round(max_percent, 2),
        "rising_query_count": len(items),
        "top_query_count": len(top_items),
    }


def calculate_trend_score(response: dict[str, Any]) -> dict[str, Any]:
    timeline = response.get("interest_over_time", {}).get("timeline_data", []) or []
    # 집계 중인 마지막 구간은 기울기를 왜곡하므로 제외한다.
    complete = [point for point in timeline if not point.get("partial_data")]
    all_values = [
        float(point["values"][0]["extracted_value"])
        for point in complete
        if point.get("values") and isinstance(point["values"][0].get("extracted_value"), (int, float))
    ]
    values = all_values[-30:]

    if not values:
        return {
            "trend_score": None,
            "trend_pattern": "sparse",
            "is_spike": False,
            "is_sparse": True,
            "nonzero_ratio": 0.0,
            "peak_z": 0.0,
            "days_since_peak": None,
            "trend_slope": 0.0,
            "trend_points": 0,
            "trend_average": None,
            "trend_latest": None,
        }

    n = len(values)
    nonzero_count = sum(value != 0 for value in values)
    nonzero_ratio = nonzero_count / n
    mean = statistics.fmean(values)
    std = statistics.pstdev(values) if n >= 2 else 0.0
    peak = max(values)
    peak_z = (peak - mean) / std if std else 0.0
    peak_idx = values.index(peak)
    days_since_peak = n - 1 - peak_idx
    is_spike = peak_z >= 2.5 and nonzero_ratio <= 0.4
    is_sparse = nonzero_count < 5

    slope = 0.0
    if is_spike:
        trend_score: float | None = max(0.0, 1.0 - days_since_peak / 14.0)
        pattern = "spike"
    elif is_sparse:
        trend_score = None
        pattern = "sparse"
    else:
        recent = values[-10:]
        recent_n = len(recent)
        mean_x = (recent_n - 1) / 2.0
        mean_y = statistics.fmean(recent)
        denominator = sum((x - mean_x) ** 2 for x in range(recent_n))
        slope = (
            sum((x - mean_x) * (y - mean_y) for x, y in enumerate(recent)) / denominator
            if denominator
            else 0.0
        )
        # ±5 관심도/일을 ±0.5점으로 대응하므로 slope/10을 0.5에 더한다.
        trend_score = max(0.0, min(1.0, 0.5 + slope / 10.0))
        pattern = "sustained"

    return {
        "trend_score": round(trend_score, 4) if trend_score is not None else None,
        "trend_pattern": pattern,
        "is_spike": is_spike,
        "is_sparse": is_sparse,
        "nonzero_ratio": round(nonzero_ratio, 4),
        "peak_z": round(peak_z, 4),
        "days_since_peak": days_since_peak,
        "trend_slope": round(slope, 4),
        "trend_points": n,
        "trend_average": round(mean, 2),
        "trend_latest": values[-1],
    }


def calculate_cluster_score(response: dict[str, Any]) -> dict[str, Any]:
    related = response.get("related_topics", {}) or {}
    items = list(related.get("rising", []) or []) + list(related.get("top", []) or [])
    unique_topics: set[str] = set()

    for item in items:
        topic = item.get("topic", {}) or {}
        identifier = str(topic.get("value") or topic.get("title") or "").strip().casefold()
        if identifier:
            unique_topics.add(identifier)

    count = len(unique_topics)
    return {
        "cluster_score": round(min(count / 5.0, 1.0), 4),
        "related_topic_count": count,
    }


def calculate_intent_score(keyword: str) -> dict[str, Any]:
    normalized = keyword.casefold()
    matches: dict[str, list[str]] = {}

    for category, modifiers in INTENT_PATTERNS.items():
        found = [modifier for modifier in modifiers if modifier.casefold() in normalized]
        if found:
            matches[category] = found

    return {
        "intent_score": 1.0 if matches else 0.4,
        "intent_matches": matches,
    }


def is_no_results_error(error: RuntimeError) -> bool:
    return "hasn't returned any results" in str(error).casefold()


def optional_trends_request(api_key: str, keyword: str, data_type: str, geo: str, date: str) -> dict[str, Any]:
    """관련 검색어/토픽이 없는 것은 정상적인 빈 결과로 취급한다."""
    try:
        return serpapi_request(api_key, keyword, data_type, geo, date)
    except RuntimeError as error:
        if is_no_results_error(error):
            return {}
        raise


def score_keyword(api_key: str, keyword: str, geo: str, date: str) -> dict[str, Any]:
    timeseries = serpapi_request(api_key, keyword, "TIMESERIES", geo, date)

    related_queries = optional_trends_request(
        api_key, keyword, "RELATED_QUERIES", geo, date
    )
    related_topics = optional_trends_request(
        api_key, keyword, "RELATED_TOPICS", geo, date
    )

    rising = calculate_rising_score(related_queries)
    trend = calculate_trend_score(timeseries)
    cluster = calculate_cluster_score(related_topics)
    intent = calculate_intent_score(keyword)

    if trend["is_spike"] or trend["is_sparse"]:
        weights = {"rising": 0.55, "trend": 0.10, "cluster": 0.20, "intent": 0.15}
    else:
        weights = {"rising": 0.40, "trend": 0.25, "cluster": 0.20, "intent": 0.15}

    trend_score = trend["trend_score"]
    trend_fallback = trend_score is None
    if trend_fallback:
        trend_score = rising["rising_score"]

    preemption_score = (
        weights["rising"] * rising["rising_score"]
        + weights["trend"] * trend_score
        + weights["cluster"] * cluster["cluster_score"]
        + weights["intent"] * intent["intent_score"]
    )

    result: dict[str, Any] = {
        "keyword": keyword,
        "geo_used": geo,
        "applied_weights": weights,
        "trend_used_rising_fallback": trend_fallback,
        "preemption_score": round(preemption_score, 4),
    }
    result.update(rising)
    result.update(trend)
    result["trend_score"] = round(trend_score, 4)
    result.update(cluster)
    result.update(intent)
    return result


def validate_keywords(keywords: list[str]) -> list[str]:
    """범용 키워드 목록을 검증하고 공백을 정리한다."""
    if not isinstance(keywords, list):
        raise TypeError("keywords는 ['키워드1', '키워드2'] 형태의 list여야 합니다.")
    if not keywords:
        raise ValueError("keywords 목록은 비어 있을 수 없습니다.")
    if not all(isinstance(keyword, str) for keyword in keywords):
        raise TypeError("keywords의 모든 항목은 문자열이어야 합니다.")

    cleaned = [keyword.strip() for keyword in keywords]
    if any(not keyword for keyword in cleaned):
        raise ValueError("keywords에는 빈 문자열을 넣을 수 없습니다.")
    if len(set(cleaned)) != len(cleaned):
        raise ValueError("비교 결과 왜곡을 막기 위해 중복 키워드는 허용하지 않습니다.")
    return cleaned


def parse_keywords_argument(argument: str) -> list[str]:
    """CLI의 JSON 배열 또는 PowerShell이 따옴표를 제거한 배열 표기를 읽는다."""
    try:
        parsed = json.loads(argument)
    except json.JSONDecodeError:
        stripped = argument.strip()
        if not (stripped.startswith("[") and stripped.endswith("]")):
            raise ValueError('키워드는 ["키워드1","키워드2"] 형태로 입력해야 합니다.')

        inner = stripped[1:-1].strip()
        if not inner:
            parsed = []
        else:
            # PowerShell은 위 명령의 내부 큰따옴표를 제거한 뒤
            # [키워드1,키워드2] 형태로 Python에 전달할 수 있다.
            parsed = [item.strip().strip('"\'') for item in inner.split(",")]

    return validate_keywords(parsed)


def compact_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """output.json에는 키워드와 네 가지 최종 점수만 남긴다."""
    compact: list[dict[str, Any]] = []
    for result in results:
        if "error" in result:
            compact.append({
                "keyword": result["keyword"],
                "rising_score": None,
                "trend_score": None,
                "cluster_score": None,
                "intent_score": None,
            })
        else:
            compact.append({
                "keyword": result["keyword"],
                "rising_score": result["rising_score"],
                "trend_score": result["trend_score"],
                "cluster_score": result["cluster_score"],
                "intent_score": result["intent_score"],
            })
    return compact


def analyze_keywords(
    keywords: list[str],
    *,
    api_key: str | None = None,
    date: str = "today 1-m",
) -> list[dict[str, Any]]:
    """여러 범용 키워드를 분석하고 후보군 내 비교점수를 반환한다."""
    cleaned_keywords = validate_keywords(keywords)
    resolved_api_key = api_key or os.getenv("SERPAPI_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("SERPAPI_API_KEY 환경변수가 설정되지 않았습니다.")

    results: list[dict[str, Any]] = []
    for keyword in cleaned_keywords:
        try:
            results.append(score_keyword(resolved_api_key, keyword, SEARCH_GEO, date))
        except RuntimeError as error:
            # 한 키워드가 실패해도 나머지 키워드는 계속 계산한다.
            results.append({"keyword": keyword, "error": str(error)})

    return results


def main() -> None:
    # Windows 콘솔의 레거시 코드페이지에서도 한글 JSON/도움말이 깨지지 않게 한다.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="키워드별 Google Trends 점수 계산")
    parser.add_argument(
        "keywords_json",
        nargs="+",
        help='JSON 배열 형식의 키워드 목록',
    )
    parser.add_argument("--date", default="today 1-m", help="조회 기간 (기본: today 1-m)")
    args = parser.parse_args()

    try:
        # PowerShell이 JSON을 공백 단위 argv로 나눠도 다시 하나로 복원한다.
        raw_keywords = " ".join(args.keywords_json)
        keywords = parse_keywords_argument(raw_keywords)
        results = analyze_keywords(keywords, date=args.date)
    except (TypeError, ValueError, RuntimeError) as error:
        parser.error(str(error))

    output = json.dumps(compact_results(results), ensure_ascii=False, indent=2)
    Path("output.json").write_text(output, encoding="utf-8")


if __name__ == "__main__":
    main()
