# Traces: where response latency goes per day, tool span health, agent spans by prompt version,
# evaluator runs, and the slowest turns, all joined to calls by conversation id.

from __future__ import annotations

import re
from typing import Any

from ..framework import quantile
from ..js import at, en_us, fixed, iso, js_number, js_round, now_ms, num_or, to_fixed, utc_from_ms
from .filters import parse_slice, slice_where, versions

_RUN_NAME = {'judge': 'LLM judge', 'classifier': 'Classifier', 'judge_heuristic': 'Heuristic judge', 'classifier_heuristic': 'Heuristic classifier', 'audio': 'Audio models'}


async def traces(db, q: dict[str, Any]) -> dict:
    f = parse_slice(q)
    w = await slice_where(db, f, ['ver', 'dir', 'path'])
    span_rows = await db.query(
        f"""select t.call_id, c.external_id, t.turn, t.kind, t.duration_s as d, to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') as day, c.prompt_version as ver
     from trace_span t join calls c on c.call_id = t.call_id
     where {w['sql']} and t.kind in ('eot','llm','tool','tts') and t.turn is not null""",
        w['params'],
    )
    by_turn: dict[str, dict] = {}
    for r in span_rows:
        k = f"{r['call_id']}#{r['turn']}"
        t = by_turn.get(k) or {'call': r['call_id'], 'ext': r['external_id'], 'turn': r['turn'], 'day': r['day'], 'eot': 0, 'llm': 0, 'tool': 0, 'tts': 0, 'total': 0, 'ver': r['ver']}
        d = num_or(r['d'], 0)
        t[r['kind']] += d
        t['total'] += d
        by_turn[k] = t
    turns = list(by_turn.values())

    # Each day's slowest 10% of agent turns, split by where the time went.
    n_days = min(f['range'], 14)
    today = now_ms()
    days = []
    i = n_days - 1
    while i >= 0:
        dt = utc_from_ms(int(today - i * 86_400_000))
        key = iso(dt)[:10]
        lst = [t for t in turns if t['day'] == key]
        i -= 1
        if not lst:
            days.append({'day': str(dt.day), 'date': key, 'total': 0, 'eot': 0, 'llm': 0, 'tool': 0, 'tts': 0, 'n': 0})
            continue
        p90 = quantile([t['total'] for t in lst], 0.9)
        slow = [t for t in lst if t['total'] >= p90]

        def avg(k: str) -> float:
            return fixed(sum(t[k] for t in slow) / len(slow), 2)

        parts = {'eot': avg('eot'), 'llm': avg('llm'), 'tool': avg('tool'), 'tts': avg('tts')}
        days.append({'day': str(dt.day), 'date': key, 'total': fixed(parts['eot'] + parts['llm'] + parts['tool'] + parts['tts'], 2), **parts, 'n': len(lst)})

    sub = re.sub(r'c\.', 'c3.', w['sql'])
    cov = await db.one(
        f"""select count(*)::int as calls,
       count(*) filter (where exists (select 1 from trace_span t where t.call_id = c.call_id and t.kind in ('llm','tool','eot','tts')))::int as with_timing,
       coalesce(sum((select count(*) from jsonb_array_elements(c.canonical->'turns') x where x->>'speaker' = 'agent')), 0)::int as turns,
       (select count(*) from metric_result m join calls c2 on c2.call_id = m.call_id where m.applicable and m.method like '%judge%' and m.run_id is not null and c2.call_id in (select c3.call_id from calls c3 where {sub}))::int as linked,
       (select count(*) from metric_result m join calls c2 on c2.call_id = m.call_id where m.applicable and m.method like '%judge%' and c2.call_id in (select c3.call_id from calls c3 where {sub}))::int as judged
     from calls c where {w['sql']}""",
        w['params'],
    )

    tools = await db.query(
        f"""select t.name, count(*)::int as n, percentile_cont(0.5) within group (order by t.duration_s) as p50, percentile_cont(0.9) within group (order by t.duration_s) as p90,
       count(*) filter (where t.status = 'error')::int as errs
     from trace_span t join calls c on c.call_id = t.call_id where {w['sql']} and t.kind = 'tool_call' group by t.name order by count(*) desc""",
        w['params'],
    )
    top_err = await db.query(
        f"""select t.name, left(coalesce(t.meta->>'result', ''), 90) as msg, count(*)::int as n
     from trace_span t join calls c on c.call_id = t.call_id where {w['sql']} and t.kind = 'tool_call' and t.status = 'error'
     group by t.name, left(coalesce(t.meta->>'result', ''), 90) order by count(*) desc""",
        w['params'],
    )

    # Agent spans by prompt version: the two most recent versions.
    vs = await versions(db, f['agent'])
    va, vb = at(vs, len(vs) - 2), at(vs, len(vs) - 1)
    a, b = (va['label'] if va else None), (vb['label'] if vb else None)

    async def ver_stats(label: str | None) -> dict | None:
        if not label:
            return None
        tl = [t for t in turns if t['ver'] == label]
        r = await db.one(
            f"""select count(*)::int as calls, coalesce(sum(jsonb_array_length(coalesce(c.canonical->'toolCalls','[]'::jsonb))), 0)::int as tools,
         coalesce(sum((select count(*) from jsonb_array_elements(c.canonical->'turns') x where x->>'speaker' = 'agent')), 0)::int as agent_turns
       from calls c where {w['sql']} and c.prompt_version = ${len(w['params']) + 1}""",
            [*w['params'], label],
        )
        tot, llm = [t['total'] for t in tl], [t['llm'] for t in tl]
        return {
            'p50': quantile(tot, 0.5) if tot else None, 'p90': quantile(tot, 0.9) if tot else None, 'llm50': quantile(llm, 0.5) if llm else None,
            'tool': sum(t['tool'] for t in tl) / len(tl) if tl else None,
            'turnsPerCall': r['agent_turns'] / r['calls'] if r and r['calls'] else None, 'toolsPerCall': r['tools'] / r['calls'] if r and r['calls'] else None,
        }

    sa, sb = await ver_stats(a), await ver_stats(b)

    def g(s: dict | None, k: str) -> float | None:
        return s.get(k) if s else None

    def fmt_s(v: float | None) -> str:
        return '—' if v is None else f'{to_fixed(v, 2)} s'

    def fmt_n(v: float | None) -> str:
        return '—' if v is None else to_fixed(v, 1)

    def worse(x: float | None, y: float | None) -> bool:
        return x is not None and y is not None and y > x * 1.05

    llm_spans = [
        {'measure': 'Response latency · p50', 'a': fmt_s(g(sa, 'p50')), 'b': fmt_s(g(sb, 'p50')), 'flag': worse(g(sa, 'p50'), g(sb, 'p50'))},
        {'measure': 'Response latency · p90', 'a': fmt_s(g(sa, 'p90')), 'b': fmt_s(g(sb, 'p90')), 'flag': worse(g(sa, 'p90'), g(sb, 'p90'))},
        {'measure': 'Agent response span · p50', 'a': fmt_s(g(sa, 'llm50')), 'b': fmt_s(g(sb, 'llm50')), 'flag': worse(g(sa, 'llm50'), g(sb, 'llm50'))},
        {'measure': 'Tool wait per turn (mean)', 'a': fmt_s(g(sa, 'tool')), 'b': fmt_s(g(sb, 'tool')), 'flag': worse(g(sa, 'tool'), g(sb, 'tool'))},
        {'measure': 'Agent turns per call', 'a': fmt_n(g(sa, 'turnsPerCall')), 'b': fmt_n(g(sb, 'turnsPerCall')), 'flag': False},
        {'measure': 'Tool calls per call', 'a': fmt_n(g(sa, 'toolsPerCall')), 'b': fmt_n(g(sb, 'toolsPerCall')), 'flag': False},
    ]

    runs = await db.query(
        f"""select r.kind, max(r.model) as model, count(*)::int as n, count(*) filter (where r.status <> 'ok')::int as errs,
       percentile_cont(0.5) within group (order by r.latency_ms) as p50, avg(r.input_tokens) as tin, avg(r.output_tokens) as tout
     from eval_run r join calls c on c.call_id = r.call_id where {w['sql']} group by r.kind order by count(*) desc""",
        w['params'],
    )
    eval_runs = []
    for r in runs:
        err = (r['errs'] / r['n']) * 100 if r['n'] else 0
        meta = ('Phrase patterns and the tool log · used when no Claude API key is configured' if r['kind'].endswith('heuristic')
                else f"{r['model'] if r['model'] is not None else ''} · p50 {to_fixed(num_or(r['p50'], 0) / 1000, 1)} s · {en_us(js_round(num_or(r['tin'], 0)))} in / {en_us(js_round(num_or(r['tout'], 0)))} out tokens a run")
        eval_runs.append({'name': _RUN_NAME.get(r['kind'], r['kind']), 'meta': meta, 'runs': f"{en_us(r['n'])} runs", 'err': f'{to_fixed(err, 1)}% errors', 'bad': err > 1})

    def why(t: dict) -> str:
        if t['tool'] > t['total'] * 0.5:
            return f"Waited {to_fixed(t['tool'], 1)} s on a tool with no filler line"
        if t['llm'] > 0 and t['eot'] + t['tts'] > 0:
            return f"LLM {to_fixed(t['llm'], 1)} s, end-of-turn {to_fixed(t['eot'], 1)} s, TTS {to_fixed(t['tts'], 1)} s"
        return f"Agent took {to_fixed(t['total'], 1)} s to respond"

    slow_turns = [{'callId': t['call'], 'turn': t['turn'], 'lat': fixed(t['total'], 1), 'why': why(t)} for t in sorted(turns, key=lambda t: -t['total'])[:5]]

    first = next((d['date'] for d in days if d['n']), None)
    last = days[-1]['date'] if days else None
    top_err_by = {}
    for e in top_err:
        top_err_by.setdefault(e['name'], e)
    return {
        'window': f'{first} – {last}' if first else 'No traced calls in this window',
        'days': days,
        'coverage': {'calls': (cov or {}).get('calls') or 0, 'withTiming': (cov or {}).get('with_timing') or 0, 'turns': (cov or {}).get('turns') or 0, 'turnsWithLatency': len(turns),
                     'metricsLinked': js_round(((cov['linked'] or 0) / cov['judged']) * 100) if cov and cov['judged'] else 100, 'orphan': 0},
        'toolSpans': [{'name': t['name'], 'n': t['n'], 'p50': None if t['p50'] is None else fixed(js_number(t['p50']), 2), 'p90': None if t['p90'] is None else fixed(js_number(t['p90']), 2),
                       'errPct': fixed((t['errs'] / t['n']) * 100, 1) if t['n'] else 0, 'topError': (top_err_by.get(t['name']) or {}).get('msg') or None} for t in tools],
        'llmSpans': llm_spans,
        'versions': {'a': a, 'b': b},
        'evalRuns': eval_runs,
        'slowTurns': slow_turns,
    }
