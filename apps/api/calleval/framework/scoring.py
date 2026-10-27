# Scoring maths: normalise each metric, drop what doesn't apply, average into dimensions,
# weight the dimensions, apply the gates. CQS = min(Σ w·S ÷ Σ w, G), G = 40 if any gate failed.

from __future__ import annotations

import math
from collections.abc import Callable, Sequence

from ..js import NAN, js_round
from .metrics import DEFAULT_WEIGHTS, DIMS, METRICS

GATE_CAP = 40
GOOD_LINE = 70
MIN_CELL_CALLS = 30


def _clamp(v: float, a: float, b: float) -> float:
    return max(a, min(b, v))


def normalise(norm: dict, raw: float | bool | None) -> float | None:
    """Normalise a raw measurement into 0–100. Returns None for a missing raw value."""
    if raw is None:
        return None
    v = (1 if raw else 0) if isinstance(raw, bool) else raw
    if not math.isfinite(v):
        return None
    kind = norm['kind']
    if kind == 'pass':
        return 100 if v >= 1 else 0
    if kind == 'low':
        if v <= norm['green']:
            return 100
        if v >= norm['red']:
            return 0
        return ((norm['red'] - v) / (norm['red'] - norm['green'])) * 100
    if kind == 'high':
        if v >= norm['green']:
            return 100
        if v <= norm['red']:
            return 0
        return ((v - norm['red']) / (norm['green'] - norm['red'])) * 100
    if kind == 'two':
        (g0, g1), (r0, r1) = norm['green'], norm['red']
        if g0 <= v <= g1:
            return 100
        if v < g0:
            return 0 if v <= r0 else ((v - r0) / (g0 - r0)) * 100
        return 0 if v >= r1 else ((r1 - v) / (r1 - g1)) * 100
    if kind == 'judge':
        return _clamp(((v - norm['min']) / (norm['max'] - norm['min'])) * 100, 0, 100)
    return None


def normalise_metric(m: dict, raw: float | bool | None) -> int | None:
    out = normalise(m['norm'], raw)
    return None if out is None else js_round(out)


def _n(v: float) -> str:
    from ..js import js_str
    return js_str(v)


def norm_rule(norm: dict) -> str:
    kind = norm['kind']
    if kind == 'pass':
        return 'Pass = 100 · fail = 0'
    if kind == 'low':
        return f"≤ {_n(norm['green'])} · > {_n(norm['red'])}"
    if kind == 'high':
        return f"≥ {_n(norm['green'])} · < {_n(norm['red'])}"
    if kind == 'two':
        return f"{_n(norm['green'][0])}–{_n(norm['green'][1])} · < {_n(norm['red'][0])} or > {_n(norm['red'][1])}"
    return f"Scale {_n(norm['min'])} to {_n(norm['max'])}"


def roll_up(values: dict[str, float | None]) -> dict[str, dict]:
    """Roll metric scores (None = no opportunity in the call) into dimension scores {v, n}; weighted metrics count more."""
    acc: dict[str, dict] = {}
    for m in METRICS:
        v = values.get(m['key'])
        if v is None:
            continue
        w = m.get('weight', 1)
        a = acc.setdefault(m['dim'], {'s': 0, 'w': 0, 'n': 0})
        a['s'] += v * w
        a['w'] += w
        a['n'] += 1
    return {k: {'v': a['s'] / a['w'], 'n': a['n']} for k, a in acc.items() if a['w'] > 0}


def roll_up_array(scores: Sequence[float | None]) -> dict[str, dict]:
    """Same roll-up for an index-aligned score list in METRICS order."""
    return roll_up({m['key']: (scores[i] if i < len(scores) else None) for i, m in enumerate(METRICS)})


def cqs_of(dims: dict[str, float | None], weights: dict[str, float] = DEFAULT_WEIGHTS, gated: bool = False) -> dict:
    """CQS = min(Σ w·S ÷ Σ w, G); weights re-normalise over the dimensions present in the call."""
    num = den = 0.0
    for d in DIMS:
        v, w = dims.get(d['key']), weights.get(d['key']) or 0
        if v is not None and w > 0:
            num += w * v
            den += w
    raw = num / den if den else 0
    exact = min(raw, GATE_CAP) if gated else raw
    return {'raw': raw, 'num': num, 'den': den, 'exact': exact, 'cqs': js_round(exact), 'gated': gated}


BANDS: list[dict] = [
    {'name': 'Excellent', 'min': 85, 'action': 'Use as a reference call.'},
    {'name': 'Good', 'min': 70, 'action': 'No action.'},
    {'name': 'Needs review', 'min': 50, 'action': 'Sample for coaching or a prompt fix.'},
    {'name': 'Fail', 'min': 0, 'action': 'Review every call; every gated call lands here.'},
]


def _band(v: float) -> dict:
    return next((b for b in BANDS if v >= b['min']), BANDS[-1])


def band_name(v: float) -> str:
    return _band(v)['name']


def band_action(v: float) -> str:
    return _band(v)['action']


def score_call(values: dict[str, float | None], gates_failed: int, weights: dict[str, float] = DEFAULT_WEIGHTS) -> dict:
    """Full scoring for one call from its metric values and gate flags."""
    roll = roll_up(values)
    dims = {k: v['v'] for k, v in roll.items()}
    r = cqs_of(dims, weights, gates_failed > 0)
    return {'roll': roll, 'dims': dims, **r, 'band': band_name(r['cqs'])}


# ---------- Small statistics helpers ----------

def median(xs: Sequence[float]) -> float:
    if not xs:
        return NAN
    s = sorted(xs)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def quantile(xs: Sequence[float], q: float) -> float:
    if not xs:
        return NAN
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


_M32 = 0xFFFFFFFF


def mulberry32(seed: int) -> Callable[[], float]:
    """Deterministic PRNG (the same sequence as the TypeScript mulberry32), so bootstrap intervals and demo data are reproducible."""
    a = seed & _M32

    def rnd() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & _M32
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & _M32
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & _M32)) & _M32)) & _M32
        return ((t ^ (t >> 14)) & _M32) / 4294967296

    return rnd


def bootstrap_median_diff(a: Sequence[float], b: Sequence[float], iters: int = 1000, seed: int = 7,
                          stat: Callable[[Sequence[float]], float] = median) -> dict:
    """95% bootstrap interval for the difference of medians (b − a), or of another statistic."""
    d = (stat(b) if b else NAN) - (stat(a) if a else NAN)
    if not a or not b:
        return {'d': d, 'lo': NAN, 'hi': NAN}
    rnd = mulberry32(seed)

    def pick(xs: Sequence[float]) -> list[float]:
        n = len(xs)
        return [xs[math.floor(rnd() * n)] for _ in range(n)]

    diffs = [stat(pick(b)) - stat(pick(a)) for _ in range(iters)]
    return {'d': d, 'lo': quantile(diffs, 0.025), 'hi': quantile(diffs, 0.975)}


def cohens_kappa(pairs: Sequence[tuple[str, str] | list[str]]) -> float | None:
    """Cohen's kappa for two raters over categorical labels."""
    if not pairs:
        return None
    cats = list(dict.fromkeys(x for p in pairs for x in p))
    n = len(pairs)
    agree = 0
    ca: dict[str, int] = {}
    cb: dict[str, int] = {}
    for x, y in pairs:
        if x == y:
            agree += 1
        ca[x] = ca.get(x, 0) + 1
        cb[y] = cb.get(y, 0) + 1
    po = agree / n
    pe = sum((ca.get(c, 0) / n) * (cb.get(c, 0) / n) for c in cats)
    if pe == 1:
        return 1 if po == 1 else 0
    return (po - pe) / (1 - pe)
