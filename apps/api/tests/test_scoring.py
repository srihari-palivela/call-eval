import json
import subprocess
from pathlib import Path

import pytest

from calleval.framework import (
    DEFAULT_WEIGHTS, DIMS, GATES, METRICS, PERSONAS, SCENARIOS, band_name, bootstrap_median_diff, cohens_kappa, cqs_of, normalise, roll_up, score_call,
)


def test_maps_low_is_better_metrics_linearly_between_green_and_red():
    assert normalise({'kind': 'low', 'green': 2.5, 'red': 4}, 2) == 100
    assert normalise({'kind': 'low', 'green': 2.5, 'red': 4}, 4.2) == 0
    assert normalise({'kind': 'low', 'green': 2.5, 'red': 4}, 3.25) == pytest.approx(50)


def test_maps_high_is_better_and_two_sided_metrics():
    assert normalise({'kind': 'high', 'green': 95, 'red': 80}, 87.5) == pytest.approx(50)
    assert normalise({'kind': 'two', 'green': [40, 60], 'red': [25, 75]}, 50) == 100
    assert normalise({'kind': 'two', 'green': [40, 60], 'red': [25, 75]}, 67.5) == pytest.approx(50)
    assert normalise({'kind': 'two', 'green': [40, 60], 'red': [25, 75]}, 20) == 0


def test_rescales_judge_scales_and_handles_pass_fail():
    assert normalise({'kind': 'judge', 'min': -2, 'max': 2}, 1) == 75
    assert normalise({'kind': 'judge', 'min': 0, 'max': 2}, 1.8) == pytest.approx(90)
    assert normalise({'kind': 'pass'}, True) == 100
    assert normalise({'kind': 'pass'}, 0) == 0
    assert normalise({'kind': 'pass'}, None) is None


def test_drops_metrics_that_do_not_apply_instead_of_scoring_them_100():
    dims = roll_up({'trel': 80, 'reask': None, 'cco': 60})
    assert dims['und']['v'] == 70
    assert dims['und']['n'] == 2


def test_counts_reask_and_wrong_path_twice():
    assert roll_up({'trel': 100, 'reask': 40})['und']['v'] == 60  # (100 + 2*40) / 3


def test_renormalises_weights_when_a_dimension_is_missing_and_caps_gated_calls_at_40():
    r = cqs_of({'und': 80, 'body': 60}, DEFAULT_WEIGHTS, False)
    assert r['raw'] == pytest.approx((20 * 80 + 15 * 60) / 35)
    g = cqs_of({'und': 90, 'body': 90}, DEFAULT_WEIGHTS, True)
    assert g['cqs'] == 40
    assert g['raw'] == 90


def test_scores_a_full_call_and_bands_it():
    s = score_call({m['key']: 90 for m in METRICS}, 0)
    assert s['cqs'] == 90
    assert s['band'] == 'Excellent'
    assert band_name(69) == 'Needs review'
    assert band_name(49) == 'Fail'


def test_bootstrap_interval_excludes_zero_for_a_clear_shift_and_includes_it_for_noise():
    a = [60 + (i % 7) for i in range(60)]
    b = [x + 8 for x in a]
    r = bootstrap_median_diff(a, b)
    assert r['d'] == 8
    assert r['lo'] > 0
    n = bootstrap_median_diff(a, list(reversed(a)))
    assert n['lo'] <= 0 <= n['hi']


def test_computes_cohens_kappa():
    assert cohens_kappa([['a', 'a'], ['b', 'b'], ['a', 'a'], ['b', 'b']]) == 1
    assert cohens_kappa([['a', 'a'], ['a', 'b'], ['b', 'b'], ['b', 'a']]) == pytest.approx(0)


FRAMEWORK_TS = Path(__file__).resolve().parents[3] / 'packages/framework'


@pytest.mark.skipif(not (FRAMEWORK_TS / 'node_modules').exists() and not (FRAMEWORK_TS.parent.parent / 'node_modules/tsx').exists(),
                    reason='needs the console workspace installed (npm install) to read the TypeScript framework')
def test_framework_matches_the_console_copy():
    """The console reads packages/framework (TypeScript); the API's Python copy must define the same framework."""
    script = ("import * as F from './src/index.ts';"
              "process.stdout.write(JSON.stringify({DIMS:F.DIMS,METRICS:F.METRICS,GATES:F.GATES,PERSONAS:F.PERSONAS,SCENARIOS:F.SCENARIOS}))")
    p = subprocess.run(['npx', 'tsx', '-e', script], cwd=FRAMEWORK_TS, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        pytest.skip(f'tsx unavailable: {p.stderr[-300:]}')
    ts = json.loads(p.stdout)
    assert ts == json.loads(json.dumps({'DIMS': DIMS, 'METRICS': METRICS, 'GATES': GATES, 'PERSONAS': PERSONAS, 'SCENARIOS': SCENARIOS}))
