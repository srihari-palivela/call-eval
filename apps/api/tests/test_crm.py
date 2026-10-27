from datetime import UTC, datetime, timedelta

from calleval.crm.outcomes import attribute, normalise_stage, parse_csv, upsert_outcomes
from calleval.js import iso


def test_normalises_stages_and_synonyms():
    assert normalise_stage('Meeting booked') == 'meeting_booked'
    assert normalise_stage(' SPA-signed ') == 'sale'
    assert normalise_stage('EOI') == 'reservation'
    assert normalise_stage('closed won') == 'sale'
    assert normalise_stage('not-a-stage') is None


def test_parses_quoted_csv_with_crlf():
    rows = parse_csv('Lead_ID,stage,occurred_at,project,value_aed\r\n"lead_999",sale,2026-10-01,"Hatta Lakes","1,250,000"\r\n\r\n')
    assert rows == [{'lead_id': 'lead_999', 'stage': 'sale', 'occurred_at': '2026-10-01', 'project': 'Hatta Lakes', 'value_aed': '1,250,000'}]
    assert parse_csv('a,b\n"x ""quoted""",2') == [{'a': 'x "quoted"', 'b': '2'}]
    assert parse_csv('') == []


async def _insert_call(db, call_id: str, lead_id: str, started: datetime):
    await db.query(
        "insert into calls (call_id, provider, external_id, lead_id, started_at, status) values ($1, 'demo', $1, $2, $3, 'scored')",
        [call_id, lead_id, iso(started)],
    )


async def test_credits_outcomes_to_the_call_before_them_within_the_window(db):
    now = datetime.now(UTC)
    await _insert_call(db, 'dm_a', 'lead_a', now - timedelta(days=10))
    await _insert_call(db, 'dm_b', 'lead_a', now - timedelta(days=2))
    await _insert_call(db, 'dm_c', 'lead_c', now - timedelta(days=60))
    r = await upsert_outcomes(db, [
        {'lead_id': 'lead_a', 'stage': 'Meeting attended', 'occurred_at': iso(now - timedelta(days=1))},
        {'lead_id': 'lead_a', 'stage': 'site visit', 'occurred_at': iso(now - timedelta(days=5))},
        # 60 days after the call: outside the 30-day window for meetings, inside the 90-day one for reservations.
        {'lead_id': 'lead_c', 'stage': 'meeting_attended', 'occurred_at': iso(now)},
        {'lead_id': 'lead_c', 'stage': 'EOI', 'occurred_at': iso(now), 'value_aed': 'AED 1,200,000'},
        {'lead_id': 'lead_x', 'stage': 'nope', 'occurred_at': iso(now)},
        {'lead_id': 'lead_x', 'stage': 'sale', 'occurred_at': 'not a date'},
    ], 'api')
    assert r['imported'] == 4 and r['skipped'] == 2
    rows = {(o['lead_id'], o['stage']): o for o in await db.query('select * from lead_outcome')}
    assert rows[('lead_a', 'meeting_attended')]['credited_call_id'] == 'dm_b'
    assert rows[('lead_a', 'site_visit')]['credited_call_id'] == 'dm_a'
    assert rows[('lead_c', 'meeting_attended')]['credited_call_id'] is None
    assert rows[('lead_c', 'reservation')]['credited_call_id'] == 'dm_c'
    assert rows[('lead_c', 'reservation')]['value_aed'] == 1200000


async def test_resending_an_outcome_updates_it(db):
    at = iso(datetime.now(UTC))
    await upsert_outcomes(db, [{'lead_id': 'lead_r', 'stage': 'reservation', 'occurred_at': at, 'value_aed': 100, 'external_id': 'crm_1'}])
    await upsert_outcomes(db, [{'lead_id': 'lead_r', 'stage': 'sale', 'occurred_at': at, 'value_aed': 200, 'external_id': 'crm_1'}])
    rows = await db.query("select stage, value_aed from lead_outcome where external_id = 'crm_1'")
    assert rows == [{'stage': 'sale', 'value_aed': 200}]
    assert await attribute(db, ['lead_r']) == 0
