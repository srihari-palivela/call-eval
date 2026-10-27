# JavaScript semantics the API's numbers, strings and dates depend on. The platform was first
# written in TypeScript; scores, rationales, labels and stored JSON must read exactly as they did,
# so rounding, number formatting, JSON output and date formats follow the JavaScript rules here.

from __future__ import annotations

import json
import math
import re
import time
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo

NAN = float('nan')
INF = float('inf')


def js_round(x: float) -> int:
    """Math.round: halves round towards +Infinity."""
    return math.floor(x + 0.5)


def is_finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def is_nan(x: Any) -> bool:
    return isinstance(x, float) and math.isnan(x)


def to_fixed(x: float, digits: int = 0) -> str:
    """Number.prototype.toFixed: exact decimal value, ties away from zero, sign kept for x < 0."""
    if isinstance(x, float):
        if math.isnan(x):
            return 'NaN'
        if math.isinf(x):
            return 'Infinity' if x > 0 else '-Infinity'
    if abs(x) >= 1e21:
        return js_str(x)
    q = Decimal(1).scaleb(-digits)
    s = format(abs(Decimal(x)).quantize(q, rounding=ROUND_HALF_UP), 'f')
    return f'-{s}' if x < 0 else s


def fixed(x: float, digits: int = 0) -> float:
    """+x.toFixed(digits): the rounded number. NaN stays NaN."""
    if isinstance(x, float) and not math.isfinite(x):
        return x
    v = float(to_fixed(x, digits))
    return int(v) if v.is_integer() else v


def js_str(x: Any) -> str:
    """String(x) for the values the API formats: numbers the JavaScript way, booleans, null."""
    if x is None:
        return 'null'
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        if math.isnan(x):
            return 'NaN'
        if math.isinf(x):
            return 'Infinity' if x > 0 else '-Infinity'
        if x == 0:
            return '0'
        sign = '-' if x < 0 else ''
        d = Decimal(repr(abs(x))).normalize()
        _, digits_t, exp = d.as_tuple()
        digits = ''.join(map(str, digits_t))
        k = len(digits)
        n = exp + k  # position of the decimal point relative to the digits
        if k <= n <= 21:
            return sign + digits + '0' * (n - k)
        if 0 < n <= 21:
            return sign + digits[:n] + '.' + digits[n:]
        if -6 < n <= 0:
            return sign + '0.' + '0' * (-n) + digits
        e = n - 1
        es = f'e+{e}' if e >= 0 else f'e-{-e}'
        return sign + (digits if k == 1 else digits[0] + '.' + digits[1:]) + es
    return str(x)


def js_number(v: Any) -> float | int:
    """Number(v): '' and null are 0, unparseable text is NaN."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    if not s:
        return 0
    try:
        if re.fullmatch(r'[+-]?\d+', s):
            return int(s)
        if re.fullmatch(r'0[xX][0-9a-fA-F]+', s):
            return int(s, 16)
        return float(s) if re.fullmatch(r'[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|[+-]?Infinity', s) else NAN
    except ValueError:
        return NAN


def num_or(v: Any, d: float) -> float:
    """Number(v) || d."""
    n = js_number(v)
    return n if n and not is_nan(n) else d


def js_json(v: Any) -> str:
    """JSON.stringify: no spaces, integral numbers without '.0', NaN and Infinity as null."""
    out: list[str] = []
    _enc(v, out)
    return ''.join(out)


def _enc(v: Any, out: list[str]) -> None:
    if v is None:
        out.append('null')
    elif v is True:
        out.append('true')
    elif v is False:
        out.append('false')
    elif isinstance(v, int):
        out.append(str(v))
    elif isinstance(v, float):
        out.append(js_str(v) if math.isfinite(v) else 'null')
    elif isinstance(v, str):
        out.append(json.dumps(v, ensure_ascii=False))
    elif isinstance(v, dict):
        out.append('{')
        first = True
        for k, x in v.items():
            if x is UNDEFINED or callable(x):
                continue
            if not first:
                out.append(',')
            first = False
            out.append(json.dumps(str(k), ensure_ascii=False))
            out.append(':')
            _enc(x, out)
        out.append('}')
    elif isinstance(v, (list, tuple)):
        out.append('[')
        for i, x in enumerate(v):
            if i:
                out.append(',')
            _enc(None if x is UNDEFINED else x, out)
        out.append(']')
    elif isinstance(v, datetime):
        out.append(json.dumps(iso(v)))
    elif isinstance(v, (set, frozenset)):
        _enc(list(v), out)
    else:
        out.append(json.dumps(str(v), ensure_ascii=False))


class _Undefined:
    """Marks a key JSON.stringify would drop (a TypeScript `undefined`)."""

    def __repr__(self) -> str:
        return 'UNDEFINED'

    def __bool__(self) -> bool:
        return False


UNDEFINED = _Undefined()


def jsonable(v: Any) -> Any:
    """A value the way JSON.stringify would emit it, as plain Python data (NaN → None, sets → lists)."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items() if x is not UNDEFINED and not callable(x)}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [None if x is UNDEFINED else jsonable(x) for x in v]
    if isinstance(v, datetime):
        return iso(v)
    return v


def at(xs: Any, i: Any) -> Any:
    """xs[i] with JavaScript out-of-range behaviour: a negative or missing index gives None."""
    if i is None or isinstance(i, bool) or not isinstance(i, int) or i < 0:
        return None
    try:
        return xs[i]
    except (IndexError, TypeError):
        return None


# ---------- Regular expressions ----------

# JavaScript's \s: ASCII whitespace plus the Unicode space separators, line separators and the BOM.
_JS_SPACE = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'


def _js_whitespace(source: str) -> str:
    """Rewrite \\s and \\S to JavaScript's whitespace set (re.ASCII would otherwise narrow them)."""
    out: list[str] = []
    i, in_class = 0, False
    while i < len(source):
        c = source[i]
        if c == '\\' and i + 1 < len(source):
            n = source[i + 1]
            if n == 's':
                out.append(_JS_SPACE if in_class else f'[{_JS_SPACE}]')
            elif n == 'S' and not in_class:
                out.append(f'[^{_JS_SPACE}]')
            else:
                out.append(c + n)  # \S inside a class has no simple equivalent; it never occurs in this codebase
            i += 2
            continue
        if c == '[' and not in_class:
            in_class = True
        elif c == ']' and in_class:
            in_class = False
        out.append(c)
        i += 1
    return ''.join(out)


def jsre(source: str, flags: str = '') -> re.Pattern[str]:
    """Compile a JavaScript regex. Without the u flag JavaScript's \\d, \\w and \\b are ASCII-only, while
    \\s always includes Unicode spaces, as in JavaScript."""
    source = _js_whitespace(source)
    f = 0
    if 'i' in flags:
        f |= re.IGNORECASE
    if 'm' in flags:
        f |= re.MULTILINE
    if 's' in flags:
        f |= re.DOTALL
    if 'u' not in flags:
        f |= re.ASCII
    return re.compile(source, f)


def test(rx: re.Pattern[str], s: str | None) -> bool:
    """rx.test(s)."""
    return rx.search('' if s is None else s) is not None


def match_all(rx: re.Pattern[str], s: str) -> list[str]:
    """s.match(/…/g) ?? []: the whole matched strings."""
    return [m.group(0) for m in rx.finditer(s)]


def js_split(s: str, rx: re.Pattern[str] | str) -> list[str]:
    """s.split(regex) (or s.split(literal)), keeping empty pieces like JavaScript does."""
    if isinstance(rx, str):
        return s.split(rx)
    return rx.split(s) if rx.groups == 0 else [p for p in rx.split(s) if p is not None]


def replace_first(s: str, old: str, new: str) -> str:
    """s.replace('literal', new): JavaScript replaces only the first occurrence."""
    return s.replace(old, new, 1)


# ---------- Time ----------

def now_ms() -> int:
    return int(time.time() * 1000)


def utc_from_ms(ms: float) -> datetime:
    return datetime.fromtimestamp(int(ms) / 1000, UTC)


def to_ms(d: datetime) -> int:
    return round(d.timestamp() * 1000)


def iso(v: Any) -> str | None:
    """Date.prototype.toISOString, from a datetime, epoch milliseconds or a parseable string."""
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        d = utc_from_ms(v)
    elif isinstance(v, datetime):
        d = v if v.tzinfo else v.replace(tzinfo=UTC)
    else:
        d = parse_date(str(v))
        if d is None:
            raise ValueError(f'Invalid time value: {v}')
    d = d.astimezone(UTC)
    return d.strftime('%Y-%m-%dT%H:%M:%S.') + f'{d.microsecond // 1000:03d}Z'


def now_iso() -> str:
    return iso(now_ms())  # type: ignore[return-value]


def parse_date(s: str | None) -> datetime | None:
    """new Date(string) for ISO 8601 text; a date or time without an offset is read as UTC. None when invalid."""
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    try:
        d = datetime.fromisoformat(t.replace('z', 'Z'))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=UTC)


MONTHS_GB = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
DUBAI = ZoneInfo('Asia/Dubai')


def day_month_gb(d: datetime) -> str:
    """toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) → '5 Sept'."""
    d = d.astimezone(UTC)
    return f'{d.day} {MONTHS_GB[d.month - 1]}'


def dubai_when(d: datetime) -> str:
    """toLocaleString('en-GB', { day, month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' }) → '5 Oct, 14:07'."""
    d = d.astimezone(DUBAI)
    return f'{d.day} {MONTHS_GB[d.month - 1]}, {d.hour:02d}:{d.minute:02d}'


def utc_string(d: datetime) -> str:
    """Date.prototype.toUTCString → 'Mon, 05 Oct 2026 01:02:03 GMT'."""
    d = d.astimezone(UTC)
    return f'{_DAYS[d.weekday()]}, {d.day:02d} {_MONTHS[d.month - 1]} {d.year} {d.hour:02d}:{d.minute:02d}:{d.second:02d} GMT'


def en_us(n: float) -> str:
    """toLocaleString('en-US') for whole numbers: thousands separators."""
    if isinstance(n, float) and not n.is_integer():
        return f'{n:,.3f}'.rstrip('0').rstrip('.')
    return f'{int(n):,}'


def base36(n: int) -> str:
    """Number.prototype.toString(36) for non-negative integers."""
    if n == 0:
        return '0'
    chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out
