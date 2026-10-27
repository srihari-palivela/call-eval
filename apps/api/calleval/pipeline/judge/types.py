# Judge contract. A judge is an object with `mode` ('llm' | 'heuristic'), `model` (str | None) and two
# coroutines: classify(inp) -> ClassifierOutput and judge(inp) -> JudgeOutput (dicts with the TypeScript keys).
#
# ClassifierOutput: persona, scenarioPrimary, scenarioSecondary, intentStart, intentEnd ({value, confidence,
#   evidence}), personaResolvedTurn, events [{type, turn}], fields, budgetAed, timelineMonths, language, summary,
#   turnSegments ({turn: segment}, optional), run.
# JudgeOutput: metrics {key: {applicable, raw, evidence, rationale}}, gates {id: {failed, turn, detail}},
#   checkpoints {id: {hit, turn}}, coaching [{turn, issue, better}], run.
# RunInfo: id, kind ('classifier' | 'judge'), mode, model, inputTokens, outputTokens, latencyMs, status, error, output.

from __future__ import annotations

from typing import Any, Protocol

from ...framework import METRICS

# Metrics the judge scores (alone, or alongside a code check).
JUDGED_METRICS = [m for m in METRICS if m.get('rubric')]
JUDGED_GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G7', 'G8']


class Judge(Protocol):
    mode: str
    model: str | None

    async def classify(self, inp: dict[str, Any]) -> dict[str, Any]: ...

    async def judge(self, inp: dict[str, Any]) -> dict[str, Any]: ...
