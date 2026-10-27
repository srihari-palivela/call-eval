# The co-pilot with a fake Claude client: what it asks for (schema, tools, evidence), and how its answers are
# checked before a person sees them (invalid fields dropped with a note, impossible operations removed,
# operations that would fail flagged, funnels repaired or refused).

import json
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from calleval import copilot, taxonomy
from calleval.analytics.meta import seed_taxonomy
from calleval.lib import claude
from calleval.pipeline.judge import llm as judge_llm
from calleval.server import build_app

pytestmark = pytest.mark.asyncio(loop_scope='session')


def fake_client(handler):
    calls: list[dict] = []

    class Stream:
        def __init__(self, req):
            self.req = req

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get_final_message(self):
            out = handler(self.req)
            if isinstance(out, Exception):
                raise out
            blocks, data = out if isinstance(out, tuple) else ([], out)
            return SimpleNamespace(stop_reason='end_turn', content=[*blocks, SimpleNamespace(type='text', text=json.dumps(data))], model='fake',
                                   usage=SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0, cache_creation_input_tokens=0))

    def stream(**req):
        calls.append(req)
        return Stream(req)

    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)), calls=calls)


@pytest.fixture(scope='module')
async def client(db):
    await seed_taxonomy(db)
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        yield c
    taxonomy.reset()


@pytest.fixture
def claude_on(monkeypatch):
    monkeypatch.setattr(copilot, 'llm_enabled', lambda: True)
    monkeypatch.setattr(claude, '_fallbacks', False)

    def use(handler):
        f = fake_client(handler)
        monkeypatch.setattr(judge_llm, '_client', f)
        return f
    return use


BUSINESS = {
    'company': {'change': True, 'name': 'Acme Solar', 'website': 'https://acme.example', 'industry': 'Renewable energy', 'description': 'Rooftop solar for homes.',
                'offer': 'A free roof survey', 'markets': ['United Arab Emirates'], 'languages': ['en', 'ar']},
    'icp': {'change': True, 'titles': ['Homeowner'], 'excludeTitles': [], 'seniorities': ['owner'], 'industries': [], 'personLocations': ['Dubai, United Arab Emirates'],
            'organizationLocations': [], 'employeeRanges': ['1,10'], 'keywords': 'villa solar', 'personaHint': 'P1'},
    'goals': {'change': True, 'meetingsPerWeek': 25, 'targetMeetingRate': -1, 'targetCqs': 75, 'leadsPerWeek': -1, 'monthlyCallBudget': -1,
              'focusPersonas': ['P1'], 'focusScenarios': ['S1']},
    'calling': {'change': True, 'timezone': 'Mars/Olympus', 'startHour': 10, 'endHour': 19, 'days': [0, 1, 2, 3, 4], 'maxAttemptsPerLead': 3, 'allowUnknownConsent': False},
    'assumptions': ['Homeowners are the buyers.'], 'questions': ['Do you also sell to businesses?'],
}


async def test_the_copilot_needs_a_claude_key(client):
    r = await client.post('/api/business/copilot', json={'description': 'We sell solar'})
    assert r.status_code == 400 and 'Claude API key' in r.json()['message']


async def test_drafts_a_business_profile_reading_the_website(client, claude_on):
    page = SimpleNamespace(type='web_fetch_tool_result', content=SimpleNamespace(type='web_fetch_result'))
    f = claude_on(lambda req: ([page], BUSINESS))
    r = (await client.post('/api/business/copilot', json={'description': 'We install rooftop solar on villas.', 'website': 'acme.example'})).json()
    req = f.calls[0]
    assert req['tools'] == [{'type': 'web_fetch_20260209', 'name': 'web_fetch', 'max_uses': 5, 'allowed_domains': ['acme.example', 'www.acme.example']}]
    assert req['thinking'] == {'type': 'adaptive'} and 'Apollo' in req['system'][0]['text']
    assert 'https://acme.example' in req['messages'][0]['content'] and 'P1 Family end-user' in req['messages'][0]['content']
    assert r['websiteRead'] is True and set(r['profile']) == {'company', 'icp', 'goals', 'calling'}
    goals = r['profile']['goals']
    assert goals['meetingsPerWeek'] == 25 and goals['targetMeetingRate'] is None  # -1 means unknown: left unset
    assert r['profile']['calling']['timezone'] == 'Asia/Dubai' and r['profile']['calling']['days'] == [0, 1, 2, 3, 4]
    assert any('calling.timezone' in a and 'Unknown timezone' in a for a in r['assumptions'])
    assert {'section': 'company', 'field': 'name', 'from': '', 'to': 'Acme Solar'} in r['changes']
    assert r['questions'] == ['Do you also sell to businesses?'] and r['usage'] == {'inputTokens': 1000, 'outputTokens': 200, 'model': 'fake'}
    # Applying a section is an ordinary profile update.
    saved = (await client.put('/api/business', json={'company': r['profile']['company']})).json()
    assert saved['company']['name'] == 'Acme Solar' and saved['icp']['titles'] == []


async def test_drafts_from_the_description_when_web_fetch_is_unavailable(client, claude_on):
    def handler(req):
        if req.get('tools'):
            return anthropic.BadRequestError('tools.0: web_fetch is not enabled for this organization',
                                             response=httpx.Response(400, request=httpx.Request('POST', 'https://x')), body=None)
        return {**BUSINESS, 'icp': {**BUSINESS['icp'], 'change': False}, 'goals': {**BUSINESS['goals'], 'change': False}, 'calling': {**BUSINESS['calling'], 'change': False}}
    f = claude_on(handler)
    r = (await client.post('/api/business/copilot', json={'description': 'Solar for villas', 'website': 'https://acme.example/about'})).json()
    assert len(f.calls) == 2 and 'tools' not in f.calls[1]
    assert r['websiteRead'] is False and 'couldn’t be read' in r['assumptions'][0]
    assert r['profile'] == {} and r['changes'] == []  # the same company was saved by the previous test: nothing to change
    bad = await client.post('/api/business/copilot', json={'description': 'x', 'website': 'javascript:alert(1)'})
    assert bad.status_code == 400


async def test_proposes_taxonomy_changes_and_flags_the_ones_that_would_fail(client, claude_on, db):
    await db.query("insert into cluster (id, label, size, nearest) values ('cl1', 'Golden visa through a purchase', 31, 'S11 Out of scope')")
    answer = {
        'summary': 'Adds holiday-home buyers.', 'domain': 'Acme Homes, which sells villas in Dubai. Callers are buyers and brokers.',
        'personas': [
            {'op': 'add', 'id': '', 'name': 'Holiday-home buyer', 'path': 'Investor', 'signals': 'Second home for holidays', 'watch': 'Usage months',
             'checkLabel': 'Usage asked', 'basedOn': '', 'keywords': ['holiday home'], 'reason': 'A cluster of 31 calls'},
            {'op': 'update', 'id': 'P99', 'name': 'Ghost', 'path': 'Investor', 'signals': '', 'watch': '', 'checkLabel': '', 'basedOn': '', 'keywords': [], 'reason': 'x'},
        ],
        'scenarios': [
            {'op': 'add', 'id': '', 'name': 'Callback request', 'short': 'Callback', 'trigger': 'x', 'path': 'x', 'success': 'x', 'basedOn': 'S4', 'keywords': [],
             'checkpoints': [{'id': 'booked', 'label': 'Callback booked', 'hint': '', 'by': 'tool', 'tools': ['schedule_callback'], 'rule': ''}], 'reason': 'dup'},
        ],
        'events': [{'op': 'retire', 'id': 'tool_failure', 'label': '', 'group': 'Agent or system', 'keywords': [], 'reason': 'x'}],
        'questions': ['Are holiday homes a separate team?'],
    }
    f = claude_on(lambda req: answer)
    r = (await client.post('/api/taxonomy/copilot', json={'mode': 'review', 'instruction': ''})).json()
    user = f.calls[0]['messages'][0]['content']
    assert 'TASK (review)' in user and 'Golden visa through a purchase: 31 calls' in user and '"P11"' in user
    schema = f.calls[0]['output_config']['format']['schema']
    assert 'P11' in schema['properties']['personas']['items']['properties']['basedOn']['enum']
    ops = r['operations']
    assert [(o['op'], o['kind']) for o in ops] == [('add', 'persona'), ('add', 'scenario')]  # P99 and a code event dropped
    assert ops[0]['id'] is None and ops[0]['entry']['basedOn'] is None and 'warnings' not in ops[0]
    assert 'Two scenarios are called “callback request”' in ops[1]['warnings'][0]
    assert ops[1]['entry']['checkpoints'] == [{'id': 'booked', 'label': 'Callback booked', 'detect': {'by': 'tool', 'tools': ['schedule_callback']}}]
    assert r['domain'].startswith('Acme Homes') and r['evidence']['clusters'] == 1 and r['questions']
    applied = (await client.post('/api/taxonomy/draft/apply', json={'operations': [ops[0]], 'domain': r['domain']})).json()
    assert applied['draft']['personas'][-1]['name'] == 'Holiday-home buyer' and applied['draft']['domain'].startswith('Acme Homes')
    assert (await client.post('/api/taxonomy/copilot', json={'mode': 'edit'})).status_code == 400


async def test_proposes_a_funnel_and_repairs_small_slips(client, claude_on):
    await client.put('/api/settings', json={'features': {'crm': True}})
    answer = {'name': 'Solar surveys', 'description': 'Survey to install', 'reason': 'Homeowners book a roof survey first.', 'questions': [],
              'match': {'paths': ['Investor'], 'personas': [], 'sources': ['apollo']},
              'stages': [
                  {'key': 'new', 'label': 'New', 'description': '', 'milestone': 'new', 'kind': 'open', 'callable': True},
                  {'key': 'survey', 'label': 'Survey booked', 'description': '', 'milestone': 'meeting_booked', 'kind': 'open', 'callable': True},
                  {'key': 'survey', 'label': 'Survey done', 'description': '', 'milestone': 'meeting_booked', 'kind': 'open', 'callable': True},
                  {'key': 'installed', 'label': 'Installed', 'description': '', 'milestone': 'sale', 'kind': 'won', 'callable': True},
              ]}
    claude_on(lambda req: answer)
    r = (await client.post('/api/crm/funnels/copilot', json={'instruction': 'Homeowners, roof survey first'})).json()
    st = r['funnel']['stages']
    assert [s['key'] for s in st] == ['new', 'survey', 'survey_2', 'installed', 'dnc']
    assert st[2]['milestone'] is None and st[3]['callable'] is False and r['funnel']['match']['sources'] == ['apollo']
    created = await client.post('/api/crm/funnels', json=r['funnel'])
    assert created.status_code == 200 and created.json()['name'] == 'Solar surveys'
    claude_on(lambda req: {**answer, 'stages': [{**answer['stages'][3]}, answer['stages'][0]]})
    bad = await client.post('/api/crm/funnels/copilot', json={'instruction': 'x'})
    assert bad.status_code == 502 and 'first stage must be an open stage' in bad.json()['message']
