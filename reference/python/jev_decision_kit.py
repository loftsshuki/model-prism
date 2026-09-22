"""Reference implementation of Jev Decision Spec v1.

Stdlib-only and intentionally free of network/provider code. Repos may pair these
pure resolution functions with their own Jev client while preserving fleet-wide
mode semantics.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, Sequence, TypeVar

DecisionMode = Literal["off", "shadow", "assist", "enforce"]
DecisionAction = Literal[
    "baseline", "observed", "expanded", "promoted", "enforced",
    "preserved", "suppressed", "fallback",
]
VerifyDecision = Literal["pass", "review", "fail"]
SPEC_VERSION = "jev-decision-spec/v1"
VERIFY_ORDER: tuple[VerifyDecision, ...] = ("pass", "review", "fail")

T = TypeVar("T", bound=str)


def _threshold(value: float | None) -> float:
    return 0.8 if value is None else value


def _confident(confidence: float | None, minimum: float) -> bool:
    return confidence is not None and confidence >= minimum


def _index(order: Sequence[T], value: T) -> int:
    try:
        return order.index(value)
    except ValueError as exc:
        raise ValueError(f'Decision value "{value}" is missing from the configured order') from exc


def _base_action(mode: DecisionMode, confident: bool) -> DecisionAction:
    if mode == "off":
        return "baseline"
    if mode == "shadow":
        return "observed"
    return "preserved" if confident else "fallback"


def resolve_classify(
    *, mode: DecisionMode, baseline_label: T, jev_label: T | None,
    confidence: float | None, threshold: float | None = None,
) -> dict[str, Any]:
    confident = _confident(confidence, _threshold(threshold))
    if mode == "enforce" and jev_label is not None and confident:
        return {"label": jev_label, "action": "enforced"}
    return {"label": baseline_label, "action": _base_action(mode, confident)}


def resolve_verify(
    *, mode: DecisionMode, baseline: VerifyDecision, jev: VerifyDecision | None,
    confidence: float | None, threshold: float | None = None,
    hard_floor: VerifyDecision = "pass",
) -> dict[str, Any]:
    confident = _confident(confidence, _threshold(threshold))
    if jev is None or not confident or mode in {"off", "shadow"}:
        return {"decision": baseline, "action": _base_action(mode, confident)}

    baseline_i = _index(VERIFY_ORDER, baseline)
    jev_i = _index(VERIFY_ORDER, jev)
    floor_i = _index(VERIFY_ORDER, hard_floor)

    if mode == "assist":
        index = max(baseline_i, jev_i, floor_i)
        return {
            "decision": VERIFY_ORDER[index],
            "action": "expanded" if index > baseline_i else "preserved",
        }

    index = max(jev_i, floor_i)
    action: DecisionAction
    if index == baseline_i:
        action = "preserved"
    elif index > baseline_i:
        action = "expanded"
    else:
        action = "suppressed"
    return {"decision": VERIFY_ORDER[index], "action": action}


resolve_gate = resolve_verify


def resolve_dedupe(
    *, mode: DecisionMode, baseline_label: T, jev_label: T | None,
    confidence: float | None, order: Sequence[T],
    threshold: float | None = None, hard_floor: T | None = None,
) -> dict[str, Any]:
    confident = _confident(confidence, _threshold(threshold))
    if jev_label is None or not confident or mode in {"off", "shadow"}:
        return {"label": baseline_label, "action": _base_action(mode, confident)}

    baseline_i = _index(order, baseline_label)
    jev_i = _index(order, jev_label)
    floor_i = 0 if hard_floor is None else _index(order, hard_floor)

    if mode == "assist":
        index = max(baseline_i, jev_i, floor_i)
        return {
            "label": order[index],
            "action": "expanded" if index > baseline_i else "preserved",
        }

    index = max(jev_i, floor_i)
    action: DecisionAction
    if index == baseline_i:
        action = "preserved"
    elif index > baseline_i:
        action = "expanded"
    else:
        action = "suppressed"
    return {"label": order[index], "action": action}


def resolve_rank(
    *, mode: DecisionMode, baseline_score: float, jev_score: float | None,
    confidence: float | None, threshold: float | None = None,
    minimum: float = 0, maximum: float = 100,
) -> dict[str, Any]:
    clamp = lambda value: max(minimum, min(maximum, value))
    baseline = clamp(baseline_score)
    confident = _confident(confidence, _threshold(threshold))

    if jev_score is None or not confident or mode in {"off", "shadow"}:
        return {"score": baseline, "action": _base_action(mode, confident)}

    jev = clamp(jev_score)
    if mode == "assist":
        score = max(baseline, jev)
        return {
            "score": score,
            "action": "promoted" if score > baseline else "preserved",
        }

    if jev == baseline:
        action = "preserved"
    elif jev > baseline:
        action = "promoted"
    else:
        action = "suppressed"
    return {"score": jev, "action": action}


def resolve_shortlist(
    *, mode: DecisionMode, baseline_selected: bool, jev_selected: bool | None,
    confidence: float | None, threshold: float | None = None,
    hard_selected: bool = False,
) -> dict[str, Any]:
    if hard_selected:
        return {"selected": True, "action": "preserved"}

    confident = _confident(confidence, _threshold(threshold))
    if jev_selected is None or not confident or mode in {"off", "shadow"}:
        return {
            "selected": baseline_selected,
            "action": _base_action(mode, confident),
        }

    if mode == "assist":
        selected = baseline_selected or jev_selected
        return {
            "selected": selected,
            "action": "promoted" if selected and not baseline_selected else "preserved",
        }

    if jev_selected == baseline_selected:
        action = "preserved"
    elif jev_selected:
        action = "promoted"
    else:
        action = "suppressed"
    return {"selected": jev_selected, "action": action}


def resolve_route(
    *, mode: DecisionMode, baseline_route: T, jev_route: T | None,
    confidence: float | None, order: Sequence[T],
    threshold: float | None = None, hard_floor: T | None = None,
) -> dict[str, Any]:
    confident = _confident(confidence, _threshold(threshold))
    if jev_route is None or not confident or mode in {"off", "shadow"}:
        return {
            "route": baseline_route,
            "action": _base_action(mode, confident),
        }

    baseline_i = _index(order, baseline_route)
    jev_i = _index(order, jev_route)
    floor_i = 0 if hard_floor is None else _index(order, hard_floor)

    if mode == "assist":
        index = max(baseline_i, jev_i, floor_i)
        return {
            "route": order[index],
            "action": "expanded" if index > baseline_i else "preserved",
        }

    index = max(jev_i, floor_i)
    if index == baseline_i:
        action = "preserved"
    elif index > baseline_i:
        action = "expanded"
    else:
        action = "suppressed"
    return {"route": order[index], "action": action}


@dataclass
class DecisionTelemetry:
    primitive: str
    key: str
    mode: DecisionMode
    baselineDecision: Any
    effectiveDecision: Any
    action: DecisionAction
    answer: Any | None = None
    confidence: float | None = None
    probabilities: dict[str, float] | None = None
    latencyMs: float | None = None
    costUsd: float | None = None
    generationId: str | None = None
    evaluatorVersion: str | None = None
    error: str | None = None
    specVersion: str = SPEC_VERSION

    def as_dict(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in asdict(self).items()
            if value is not None
        }
