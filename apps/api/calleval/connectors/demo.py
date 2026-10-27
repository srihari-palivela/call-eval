# Synthetic conversations for demo mode and tests. Each call is built turn by turn from the persona
# and scenario, with tool calls, timings and dynamic variables shaped like a real provider export.
# Known failure modes from the framework (a project fact with no tool output behind it, two
# questions in one turn, tool dead air, a list of three instead of a two-option fork, …) are
# injected with a probability that depends on the persona, the scenario and the prompt version, so
# the analytics have realistic variance and the pipeline has something real to find.
#
# The random draws happen in exactly the order the TypeScript generator made them, so a seed gives
# the same calls in both.

from __future__ import annotations

import math
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from ..framework import PERSONAS, SCENARIOS, mulberry32
from ..js import base36, en_us, fixed, iso, js_json, js_round, js_split, jsre, now_ms, to_fixed, to_ms

DEMO_PROJECTS: list[dict] = [
    {'id': 'island_park', 'name': 'Island Park Residences', 'community': 'Dubai Islands', 'vibe': 'the quieter one, set back from the beach with a park inside the community', 'beds': {1: [980_000, 780], 2: [1_600_000, 1_200], 3: [2_450_000, 1_750]}, 'handover': 'Q4 2027'},
    {'id': 'seafront_one', 'name': 'Seafront One', 'community': 'Dubai Islands', 'vibe': 'on the beachfront with more amenities, handing over later', 'beds': {1: [1_150_000, 820], 2: [1_950_000, 1_280], 3: [3_100_000, 1_900]}, 'handover': 'Q2 2028'},
    {'id': 'circle_gardens', 'name': 'Circle Gardens', 'community': 'JVC', 'vibe': 'the value option, close to schools and the circle park', 'beds': {1: [720_000, 760], 2: [1_100_000, 1_150], 3: [1_650_000, 1_600]}, 'handover': 'Q1 2027'},
    {'id': 'creek_heights', 'name': 'Creek Heights', 'community': 'Dubai Creek Harbour', 'vibe': 'the skyline option with metro access and a marina promenade', 'beds': {1: [1_300_000, 800], 2: [2_100_000, 1_250], 3: [3_200_000, 1_850]}, 'handover': 'Q3 2027'},
]

_TRAIL_ZEROS = jsre(r'\.?0+$')
_WS = jsre(r'\s+', 'u')
_KIDS = jsre(r'kids|family')


def _fmt_aed(n: float) -> str:
    if n >= 1_000_000:
        return f"{_TRAIL_ZEROS.sub('', to_fixed(n / 1_000_000, 1 if n % 100_000 == 0 else 2), count=1)} million dirhams"
    return f'{js_round(n / 1000)},000 dirhams'


# Weekly call mix by persona (rows) and scenario (columns), from the framework's sample volumes.
VOL = [
    [38, 22, 14, 12, 5, 6, 0, 16, 14, 6, 4, 3], [20, 16, 10, 8, 4, 2, 0, 8, 6, 4, 6, 2], [14, 24, 12, 6, 4, 2, 0, 10, 8, 4, 12, 2],
    [10, 12, 10, 8, 3, 3, 0, 5, 5, 3, 9, 3], [16, 12, 6, 6, 3, 4, 0, 8, 7, 3, 3, 1], [6, 10, 8, 6, 1, 0, 0, 6, 3, 22, 2, 4],
    [0, 3, 4, 2, 2, 1, 26, 1, 3, 2, 1, 1], [0, 3, 3, 2, 1, 1, 20, 1, 2, 2, 1, 1], [0, 1, 1, 1, 4, 1, 0, 0, 1, 1, 16, 1],
    [0, 1, 0, 0, 1, 0, 0, 0, 0, 4, 10, 1], [0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 3, 12],
]
# How well the agent tends to handle each persona and scenario (0–1), and what a prompt version changed.
PQ = [0.74, 0.56, 0.46, 0.52, 0.72, 0.56, 0.38, 0.46, 0.62, 0.72, 0.78]
SQ = [0.04, -0.04, 0.05, 0.08, -0.12, 0.02, -0.08, -0.08, 0.04, 0.06, -0.08, 0.05]


def _version_delta(ver: str, pi: int, si: int) -> float:
    if ver != 'v3':
        return 0
    d = 0.03
    if si == 6 and pi in (6, 7):
        d -= 0.12  # the longer v3 prompt muddled the broker flow
    if si == 0:
        d += 0.06  # two-option fork rule added
    if si == 7:
        d += 0.03
    if si == 4:
        d -= 0.08  # longer prompt slowed transfers
    if pi == 3:
        d -= 0.05  # overseas time-zone handling regressed
    return d


WEAK: dict[str, list[str]] = {
    'P2': ['discovery', 'reask'], 'P3': ['scope', 'pitch'], 'P4': ['intro', 'timezone', 'close'], 'P5': ['pitch'], 'P6': ['push', 'close'],
    'P7': ['broker', 'tools', 'intro', 'close'], 'P8': ['tools', 'broker', 'intro', 'close'],
    'S1': ['pitch'], 'S2': ['pitch', 'tools', 'discovery'], 'S3': ['tools', 'readback'], 'S5': ['transfer', 'tools'], 'S6': ['tools'], 'S7': ['broker', 'intro'],
    'S8': ['objection', 'push'], 'S10': ['push'], 'S11': ['scope'],
}
# v3 added the two-option fork and broker-path rules (fixing pitch and broker faults) but its longer
# prompt slowed transfers, lost the time zone on overseas bookings and loosened tool discipline.
VER_WEAK: dict[str, list[str]] = {'v2': ['pitch', 'broker', 'discovery'], 'v3': ['transfer', 'timezone', 'tools']}

NAMES = ['Rahul', 'Priya', 'Daniel', 'Aisha', 'Omar', 'Sara', 'James', 'Fatima', 'Arjun', 'Layla', 'Michael', 'Noura', 'Chen', 'Elena', 'Yousef', 'Hannah', 'Ravi', 'Mariam', 'Tom', 'Zainab']
COMPETITORS = ['Dubai Marina', 'Business Bay', 'Downtown']

Rng = Callable[[], float]


def _pick(r: Rng, xs: list) -> Any:
    return xs[math.floor(r() * len(xs))]


def _chance(r: Rng, p: float) -> bool:
    return r() < p


def _clamp(v: float, a: float, b: float) -> float:
    return max(a, min(b, v))


def _nwords(text: str) -> int:
    return len(js_split(text, _WS))


class _Builder:
    def __init__(self, r: Rng, q: float, slow: bool):
        self.r, self.q, self.slow = r, q, slow
        self.turns: list[dict] = []
        self.tools: list[dict] = []
        self.t: float = 0
        self.ended = False

    def _lat(self) -> float:
        base = 0.75 + self.r() * 0.6
        return base + 1.6 + self.r() * 2.2 if self.slow and _chance(self.r, 0.35) else base

    def agent(self, text: str, tag: str | None = None, latency: float | None = None, interrupted: bool | None = None) -> int:
        if self.ended:
            return -1
        prev = self.turns[-1] if self.turns else None
        if prev is not None and prev['speaker'] == 'caller':
            gap = latency if latency is not None else self._lat()
        else:
            gap = 0.25 if prev is not None else 0
        start = self.t + gap
        body = f'[{tag}] {text}' if tag else text
        words = _nwords(text)
        rate = 2.45 + self.r() * 0.35 + (0.6 if self.q < 0.45 and _chance(self.r, 0.3) else 0)
        end = start + words / rate
        turn: dict[str, Any] = {'idx': len(self.turns), 'speaker': 'agent', 'text': body, 'startS': fixed(start, 2), 'endS': fixed(end, 2)}
        if tag:
            turn['tags'] = [tag]
        if interrupted is not None:
            turn['interrupted'] = interrupted
        if prev is not None and prev['speaker'] == 'caller':
            turn['latencyS'] = fixed(gap, 2)
        self.turns.append(turn)
        self.t = end
        return len(self.turns) - 1

    def caller(self, text: str, barge: bool = False) -> int:
        if self.ended:
            return -1
        prev = self.turns[-1] if self.turns else None
        start = self.t + 0.4 + self.r() * 0.5
        if barge and prev is not None and prev['speaker'] == 'agent':
            start = max(prev['startS'] + 1, (prev['endS'] if prev.get('endS') is not None else self.t) - 1.5)
            prev['interrupted'] = True
        end = start + 0.4 + _nwords(text) / (1.9 + self.r() * 0.5)
        self.turns.append({'idx': len(self.turns), 'speaker': 'caller', 'text': text, 'startS': fixed(start, 2), 'endS': fixed(end, 2)})
        self.t = end
        return len(self.turns) - 1

    def tool(self, turn_idx: int, name: str, args: dict, result: Any, ok: bool = True, dur: float | None = None) -> float | None:
        """A tool called from agent turn `turn_idx`. The default duration is drawn even when the call is
        ignored after the end, as the TypeScript default parameter was."""
        if dur is None:
            dur = 0.3 + self.r() * 0.9
        if self.ended:
            return None
        start_s = self.t
        self.tools.append({'id': f'tc_{len(self.tools)}_{math.floor(self.r() * 1e6)}', 'turnIdx': turn_idx, 'name': name, 'args': args, 'result': result,
                           'resultText': result if isinstance(result, str) else js_json(result), 'ok': ok, 'startS': fixed(start_s, 2), 'durationS': fixed(dur, 2)})
        return dur

    def blocking_tool(self, name: str, args: dict, result: Any, filler: str | None, dur: float) -> int:
        """Blocking tool before the agent's next turn: the caller hears silence for the tool's duration."""
        if filler:
            i = self.agent(filler)
            self.tool(i, name, args, result, True, dur)
            self.t += dur
            return i
        # No filler: the tool runs in the gap before the next agent turn.
        self.tool(len(self.turns), name, args, result, True, dur)
        self.t += dur
        return -1


def _projects_for(r: Rng, beds: int, community: str | None, n: int) -> list[dict]:
    pool = [p for p in DEMO_PROJECTS if not community or p['community'] == community]
    rest = [p for p in DEMO_PROJECTS if p not in pool]
    return [{'id': p['id'], 'name': p['name'], 'community': p['community'], 'from_aed': p['beds'][beds][0], 'size_sqft': p['beds'][beds][1], 'handover': p['handover']}
            for p in (pool + rest)[:n]]


_DEFAULT = object()


def generate_call(seed_no: int, *, at: datetime, version: str, pi: int | None = None, si: int | None = None, rng: Rng | None = None) -> dict:
    r = rng if rng is not None else mulberry32(seed_no * 7919 + 13)
    # Persona and scenario from the weekly mix.
    if pi is None or si is None:
        total = sum(sum(row) for row in VOL)
        x = r() * total
        pi = si = None
        done = False
        for i in range(len(VOL)):
            for j in range(12):
                x -= VOL[i][j]
                if x <= 0:
                    pi, si = i, j
                    done = True
                    break
            if done:
                break
        pi = 0 if pi is None else pi
        si = 0 if si is None else si
    persona, scen = PERSONAS[pi], SCENARIOS[si]
    q = _clamp(PQ[pi] + SQ[si] + _version_delta(version, pi, si) + (r() - 0.5) * 0.35, 0.05, 0.98)
    # Each persona and scenario has weak spots (like the framework's sample data), and each prompt
    # version fixed some and broke others; faults in a weak family are much more likely.
    weak_fams = set(WEAK.get(persona['id'], []) + WEAK.get(scen['id'], []))
    ver_fams = set(VER_WEAK.get(version, []))

    def fault(base: float, fam: str | None = None) -> bool:
        return _chance(r, _clamp(base * (1.3 - q) * 1.9 * (2.6 if fam and fam in weak_fams else 1) * (1.9 if fam and fam in ver_fams else 1), 0, 0.92))

    slow = fault(0.35)
    b = _Builder(r, q, slow)

    returning = si == 8 or _chance(r, 0.15)
    inbound = _chance(r, 0.3) if si == 8 else _chance(r, 0.4) if si == 11 else _chance(r, 0.55)
    direction = 'inbound' if inbound else 'outbound'
    name = _pick(r, NAMES)
    name_known = returning or (not inbound and _chance(r, 0.6))
    objective = _pick(r, ['Send the floor plans for Island Park Residences', 'Confirm the site visit time']) if si == 8 else 'requested callback' if not inbound and si == 3 else None
    known_facts = {'persona': 'broker' if persona['path'] == 'Broker' else 'investor', 'bedrooms': 2, 'interest': 'Island Park Residences'} if returning else None
    beds = 1 if pi in (2, 3) else (2 if _chance(r, 0.6) else 3) if pi in (0, 4) else 2
    community = _pick(r, ['Dubai Islands', 'Dubai Islands', 'JVC', 'Dubai Creek Harbour'])
    fields: dict[str, str] = {}
    state: dict[str, Any] = {'endReason': 'natural_close', 'nextStep': None}
    is_broker = persona['path'] == 'Broker'
    non_target = persona['path'] == 'Non-target'

    def finish() -> dict:
        dur = max(b.t + 0.5, 4)
        id = f'demo_{base36(seed_no)}_{base36(math.floor(r() * 1e9))}'
        dyn = {'customer_name': name if name_known else '', 'known_facts': js_json(known_facts) if known_facts else '',
               'recent_history': 'Brochure sent for Island Park Residences two weeks ago' if returning else '', 'objective': objective if objective is not None else '',
               'lead_id': f'lead_{seed_no}', 'direction': direction, 'demo_persona': persona['id'], 'demo_scenario': scen['id']}
        return {
            'provider': 'demo',
            'externalId': id,
            'agentExternalId': 'demo_sales_agent',
            'agentName': 'Sales voice agent (demo)',
            'agentVersion': version,
            'startedAt': iso(at),
            'durationS': fixed(dur, 1),
            'direction': direction,
            'endReason': state['endReason'],
            'endReasonRaw': state['endReason'],
            'language': 'en',
            'dynamicVariables': dyn,
            'turns': b.turns,
            'toolCalls': b.tools,
            # Demo calls stand in for dual-channel recordings with no audio model attached, so the
            # transcript-side emotion metrics apply and the audio-only ones drop out.
            'recording': {'available': True, 'channels': 2, 'url': None},
            'providerAnalysis': {'summary': f"{persona['name']} · {scen['name']}", 'successful': state['nextStep'] is not None},
            'latency': None,
            'cost': {'amount': fixed(dur / 60 * 0.6, 2), 'currency': 'AED'},
            'leadId': f'lead_{seed_no}',
            'promptVersionHint': version,
        }

    # ---------- Introduction ----------
    if si == 11:
        # Voicemail, silence or wrong number.
        b.agent('Thanks for calling the sales line. Are you looking for a property today?' if inbound else f'Hi, this is the sales assistant calling about your enquiry on {community}. Is now a good time?')
        if _chance(r, 0.5):
            b.caller('Sorry, wrong number.')
            i = b.agent('No problem at all — sorry to bother you. Goodbye.')
            b.tool(i, 'end_call', {}, 'ended')
        else:
            state['endReason'] = 'voicemail' if _chance(r, 0.5) else 'caller_hangup'
            if state['endReason'] == 'voicemail':
                i = b.agent('Hi, this is the sales assistant returning your enquiry — we will try you again later. Goodbye.')
                b.tool(i, 'end_call', {}, 'ended')
        return finish()

    if objective == 'requested callback':
        first_agent = f'Hi {name}, you asked us to call you back about {community} — is now still a good time?'
    elif returning:
        first_agent = (f"Hi {name}, last time we spoke you were a {known_facts['persona']}, looking at {known_facts['bedrooms']}-bedroom homes in Island Park Residences, and we sent you the brochure. What can I help with today?"
                       if fault(0.25, 'intro') else f'Hi {name}, good to hear from you again — last time we talked about two-bedrooms in Island Park Residences. What can I help with today?')
    elif inbound:
        first_agent = f'Thanks for calling, {name}. Are you looking for a property today?' if name_known else 'Thanks for calling the sales line. Are you looking for a property today?'
    else:
        hi = ' ' + name if name_known else ' there'
        first_agent = (f'Hi{hi}, this is the sales assistant calling about your enquiry on {community}. How can I help you?' if fault(0.3, 'intro')
                       else f'Hi{hi}, this is the sales assistant calling about your enquiry on {community}. Is now a good time for a couple of minutes?')
    b.agent(first_agent)

    openers = {
        0: 'Yes. We need more space — we have two kids and the lease ends next year.',
        1: "Yes, I'm thinking of buying my first place, but I don't really know how off-plan works.",
        2: "I'm looking at investments. What kind of rental return would I get?",
        3: "Yes, I'm calling from London — I want to invest in Dubai.",
        4: 'Yes, we live in Dubai Marina now and want to upgrade before our lease ends.',
        5: 'Just looking for now, really.',
        6: "Yes, go ahead. I'm a broker, actually — I have clients in London asking about Dubai.",
        7: "I'm an independent broker here in Dubai. I have a couple of buyers.",
        8: 'I already own a unit in Island Park Residences — I have a question about the service charge.',
        9: "I'm actually looking to rent, not buy.",
        10: "Hi, I'm calling about a job opening I saw.",
    }
    reveals = {0: ' It’s about a bigger place for my family.', 1: ' It would be my first home.', 2: ' I’m looking at it as an investment.', 3: ' I’m calling from London about investing.',
               4: ' We want to upgrade before our lease ends.', 5: ' I’m just looking really.', 6: ' I’m a broker with clients in London.', 7: ' I’m an independent broker here in Dubai.'}
    reveal = reveals.get(pi, '') if _chance(r, 0.85) else ''
    if si == 3:
        b.caller(f"I'm driving right now — can you call me back later?{reveal}")
    elif si == 5:
        b.caller(f'I have a site visit booked for Saturday and I need to move it.{reveal}')
    elif si == 4:
        b.caller(f'Can I just speak to a person, please?{reveal}')
    elif si == 9 and pi != 10:
        b.caller("Please don't call me again — take my number off your list." if _chance(r, 0.4) else f"I'm not interested, thanks.{reveal}")
    else:
        b.caller(openers[pi])

    persona_known = returning and known_facts is not None and known_facts['persona']
    fork_needed = not persona_known and not is_broker and not non_target and si not in (3, 4, 5, 9)
    if fork_needed:
        if fault(0.25, 'intro'):
            b.agent('Lovely. Are you buying for yourself, or are you a broker — and what budget do you have in mind?')
        elif fault(0.12, 'intro') and not is_broker:
            b.agent('Great. And what kind of brokerage do you work with?')  # wrong path
        else:
            b.agent('Lovely. Are you buying for yourself, or are you a broker?')
        b.caller('For myself — for my family.' if pi == 0 else 'For myself, as an investment.' if pi in (2, 3) else 'For myself.')
    elif persona_known and fault(0.2, 'reask'):
        b.agent('Before we start — are you buying for yourself, or are you a broker?')
        b.caller("I told you last time, I'm buying for myself.")
    fields['persona'] = 'Broker' if is_broker else 'Non-target' if non_target else 'Investor'

    if not name_known and si not in (3, 9) and pi != 10:
        b.agent('May I take your name, and the best email to reach you on?' if fault(0.2, 'intro') else 'May I take your name?')
        b.caller(f"It's {name}.")
        late = fault(0.25, 'tools')
        j = b.agent(f'Thanks, {name}.')
        if not late:
            b.tool(j, 'update_caller_details', {'name': name}, 'ok')
    elif name_known and fault(0.12, 'reask') and si not in (3, 9):
        b.agent('Sorry — may I take your name again?')
        b.caller(f"It's {name}, you used it a minute ago.")
    if name_known or si not in (3, 9):
        fields['name'] = name

    # ---------- Body ----------
    def project_tool(n: int, filler: bool, comm: Any = _DEFAULT) -> list[dict]:
        comm = community if comm is _DEFAULT else comm
        res = {'projects': _projects_for(r, beds, comm, n)}
        dur = 3.5 + r() * 3.5 if slow and _chance(r, 0.6) else 0.5 + r() * 1.2
        b.blocking_tool('get_project_details', {'bedrooms': beds, 'communities': [comm] if comm else []}, res,
                        _pick(r, ['Let me check which ones are open right now.', 'One moment while I pull that up.', 'Let me look that up for you.']) if filler else None, dur)
        return res['projects']

    def discovery(deep: bool) -> None:
        investor_caller = pi in (2, 3)
        timeline_a = ('Within the year, our lease ends next summer.' if pi in (0, 4) else 'In the next year or so — there is no rush.' if investor_caller
                      else 'Maybe within the year, once I understand the process.' if pi == 1 else 'Not sure yet, honestly.')
        must_a = ('A park for the kids, and the metro for work.' if pi == 0 else 'Strong rental demand near the metro, and a firm handover date.' if investor_caller
                  else 'More space than our current flat, and close to the marina.' if pi == 4 else 'Something simple near the metro.' if pi == 1 else 'I do not really know yet.')
        who_a = ('The four of us — me, my wife and the two kids.' if pi == 0 else 'It would be rented out, as an investment.' if investor_caller
                 else 'My wife and me.' if pi == 4 else 'Just me for now.')
        qs = [
            ['When are you looking to buy?' if investor_caller else 'When would you want to move in — is there a date your lease ends?', timeline_a, 'timeline', 'Not captured' if pi == 5 else '3–12 months'],
            ['How many bedrooms are you after?', f'{beds} bedrooms ideally.', 'bedrooms', str(beds)],
            ['Which areas are you considering?', f'{community} mainly.', 'location', community],
            ['Besides that, what matters most — a park, the beach, being near the metro?', must_a, 'must_haves', 'Park, metro access'],
            ['Is it for you to live in, or to rent out?' if investor_caller else 'Will it be just you living there, or family too?', who_a, 'who_for',
             'Family of four' if pi == 0 else 'Investment' if investor_caller else 'Self'],
        ]
        n = 4 + math.floor(r() * 2) if deep else 2 + math.floor(r() * 2)
        reacts = ['Got it.', 'That helps.', 'Makes sense.', 'Noted.', 'Good to know.']
        last_answer = ''
        for aq, ca, k, v in qs[:n]:
            doubled = fault(0.22, 'discovery')
            if last_answer and not fault(0.45, 'discovery'):
                react = _pick(r, reacts)
                tail = ('With the kids in mind, space matters.' if k == 'who_for' and _KIDS.search(last_answer)
                        else 'Then the community matters as much as the home.' if k == 'must_haves' else 'That narrows it down.')
                react = f'{react} {tail} '
            else:
                react = ''
            b.agent(f'{react}{aq} And have you set a budget yet?' if doubled else f'{react}{aq}')
            last_answer = ca
            b.caller(ca)
            fields[k] = v
            if doubled:
                fields['budget'] = 'Up to 2 million AED' if _chance(r, 0.5) else 'Not captured'
        fields['buy_intent'] = 'Investment' if pi in (2, 3) else 'Live in'
        fields['property_type'] = 'Apartment'
        if not fields.get('budget') and _chance(r, 0.5):
            if returning and fault(0.3, 'reask'):
                b.agent('Which project were you interested in again?')
                b.caller('Island Park — the one we talked about last time.', barge=True)
            b.agent('Have you set a budget yet?')
            b.caller('Around two million dirhams.' if _chance(r, 0.6) else "Let's see what's there first.")
            fields['budget'] = 'Up to 2 million AED'

    def pitch() -> dict:
        filler = not fault(0.35, 'tools')
        lst = fault(0.4, 'pitch')
        if fault(0.025):
            # Ungrounded: states a fact without calling the tool, sometimes inventing the number.
            fake = 1_400_000 + math.floor(r() * 6) * 50_000
            b.agent(f"There's a great option on {community} — two-bedrooms start at around {_fmt_aed(fake)} and hand over in 2027.", tag='confidently')
            b.caller('Okay, and what else is there?')
        projs = project_tool(3 if lst else 2, filler)
        if lst:
            b.agent(f"There are three that could work: {', '.join(f'{p['name']} in {p['community']}' for p in projs)}.", tag='confidently')
        else:
            a, c = projs[0], projs[1]
            pa = next(p for p in DEMO_PROJECTS if p['id'] == a['id'])
            pc = next(p for p in DEMO_PROJECTS if p['id'] == c['id'])
            kids = ', with the kids in mind' if pi == 0 and not fault(0.4, 'pitch') else ''
            b.agent(f"Two fit what you described{kids}: {a['name']} is {pa['vibe']}, and {c['name']} is {pc['vibe']}. Which sounds closer?")
        if fault(0.15, 'pitch'):
            b.caller(f"Not {projs[-1]['community']} — we said {community}. Which is better for a family?", barge=True)
            if not fault(0.5, 'objection'):
                b.agent(f"Sorry — you're right, {community} it is.")
        else:
            b.caller(f'The first one sounds right. How much are the {beds}-bedrooms there?')
        p = projs[0]
        if fault(0.02):
            b.agent(f"In {p['name']}, {beds}-bedrooms start from about {_fmt_aed(p['from_aed'] - 150_000)}, and there's a 60/40 payment plan with a guaranteed 8% return.", tag='enthusiastically')
        else:
            b.agent(f"In {p['name']}, {beds}-bedrooms start from about {_fmt_aed(p['from_aed'])} on the current price list, at around {en_us(p['size_sqft'])} square feet. Does that sit in your range?")
        if fault(0.18, 'pitch'):
            b.agent(f"{p['name']} also has a residents' pool deck, a gym, a children's play area, landscaped parks, retail on the ground floor, covered parking, a concierge, smart-home features in every unit, and the payment plan spreads over construction with a portion on handover, so you would not pay everything up front, and there are several layouts to choose from depending on the view you prefer.")
            b.caller('Okay, okay — that is a lot. What about the price for a family?', barge=True)
        fields['project_interest'] = p['name']
        return p

    def objection(kind: str) -> bool:
        lines = {'budget': "It's a bit above what we wanted to spend.", 'location': "I'm not sure about the location — it's far from my office.",
                 'timing': 'The handover is too late for us.', 'family': 'I need to talk to my wife before deciding anything.'}
        b.caller(lines[kind])
        if fault(0.3, 'objection'):
            b.agent("Great question! Honestly it's one of the most exciting launches this year — you really shouldn't miss it.", tag='enthusiastically')
            b.caller('I said it is too expensive.')
            b.agent('I understand, but prices are only going up — shall I book you a viewing anyway?')
            b.caller('No. Not now.')
            return False
        b.agent('That makes sense — it is a family decision. Would it help if I sent the floor plans so you can look together?' if kind == 'family'
                else 'Fair enough — that matters. The layouts without the study come in a little lower; would a brochure with both help you compare?', tag='empathetically')
        b.caller('Yes, send it over.' if _chance(r, q) else 'No, I think I will leave it for now.')
        return b.turns[-1]['text'].startswith('Yes')

    def send_docs(p: dict) -> str:
        read_back = not fault(0.02, 'readback')
        if read_back:
            b.agent('Should it go to your WhatsApp, on the number ending 47?')
            b.caller('Yes, that one.')
        claim_first = fault(0.04, 'readback')
        if claim_first:
            i = b.agent("Done — it's on your WhatsApp now.")
            b.tool(i, 'send_documents', {'project_ids': [p['id']], 'doc_type': 'brochure', 'channel': 'whatsapp'}, {'status': 'failed' if _chance(r, 0.15) else 'sent'})
        else:
            ok = not _chance(r, 0.05)
            i = b.agent('Sending it now.')
            b.tool(i, 'send_documents', {'project_ids': [p['id']], 'doc_type': 'brochure', 'channel': 'whatsapp' if read_back else ''},
                   {'status': 'sent', 'channel': 'whatsapp'} if ok else {'status': 'sent', 'channel': 'email', 'note': 'WhatsApp undeliverable; sent by email instead'}, True)
            b.agent(f"Sent — the {p['name']} brochure is on your WhatsApp." if ok else "WhatsApp didn't go through, so I've sent it to your email instead.")
        if not fault(0.3, 'tools'):
            b.agent('While you look through it — is it the two-bedroom layout you want to compare, or the three?')
            b.caller('The two-bedroom.')
        return 'document'

    def book_meeting(p: dict, kind: str) -> str:
        fork_asked = kind == 'bdm_call' or not fault(0.25, 'tools')
        if fork_asked and kind != 'bdm_call':
            b.agent('Would you like to see it in person, or start with an online walkthrough?')
            b.caller('In person — Saturday morning works.' if kind == 'site_visit' else 'Online is easier, maybe Tuesday evening.')
        elif kind != 'bdm_call':
            b.caller('Can I come and see it?')
        tz = ' UAE time' if pi == 3 and not fault(0.3, 'timezone') else ''
        date = f'Saturday the 17th at 10 a.m.{tz}' if kind == 'site_visit' else f'Tuesday the 20th at 7 p.m.{tz}' if kind == 'online' else 'Tuesday the 27th at 11 a.m. UAE time'
        i = b.agent('One moment while I book it.')
        tool_kind = kind if fork_asked else 'site_visit'
        ok = not _chance(r, 0.04)
        b.tool(i, 'schedule_meeting', {'meeting_kind': tool_kind, 'project_ids': [] if kind == 'bdm_call' else [p['id']], 'date': '2026-10-17', 'time': '19:00' if kind == 'online' else '10:00'},
               {'status': 'confirmed', 'slot': date} if ok else {'status': 'unavailable'}, ok, 0.8 + r() * 0.8)
        if not ok:
            b.agent('That slot has just gone — could Sunday morning work instead?')
            b.caller('Sunday is fine.')
            j = b.agent('Booking Sunday.')
            b.tool(j, 'schedule_meeting', {'meeting_kind': tool_kind, 'project_ids': [p['id']], 'date': '2026-10-18', 'time': '10:00'}, {'status': 'confirmed', 'slot': 'Sunday the 18th at 10 a.m.'})
        misread = fault(0.15, 'close')
        gallery = f" at the {p['name']} sales gallery" if kind == 'site_visit' else ''
        b.agent("You're booked for Saturday at 11 — see you then." if misread
                else f"You're booked for {date if ok else 'Sunday the 18th at 10 a.m.'}{gallery}. The confirmation will come on WhatsApp.", tag='confidently')
        b.caller('Perfect, thank you.')
        return 'meeting'

    def callback() -> str:
        repeat = not fault(0.25, 'tools')
        b.agent('Of course — what time suits you?')
        b.caller('After six this evening.')
        if repeat:
            b.agent('So, today at 6 p.m. — is that right?')
            b.caller('Yes.')
        i = b.agent("I'll call you at 6 p.m.")
        b.tool(i, 'schedule_callback', {'time': '18:00', 'date': 'today'}, {'status': 'scheduled'})
        return 'callback'

    def transfer() -> str:
        filler = not fault(0.3, 'transfer')
        idx = b.agent('Of course — let me see who is free right now.') if filler else -1
        free = _chance(r, 0.55 + q * 0.3)
        dur = 1.5 + r() * 4 + (2 if slow else 0)
        result = {'status': 'transfer_to', 'number': '+97140000000'} if free else {'status': 'unavailable'}
        if idx >= 0:
            b.tool(idx, 'request_live_transfer', {'reason': 'caller asked for a person'}, result, True, dur)
        else:
            b.tool(len(b.turns), 'request_live_transfer', {'reason': 'caller asked for a person'}, result, True, dur)
        b.t += dur
        if free:
            if fault(0.06, 'transfer'):
                j = b.agent('Connecting you now — thanks for calling, goodbye.')
                b.tool(j, 'end_call', {}, 'ended')
                state['endReason'] = 'natural_close'
                b.ended = True
                return 'transfer_failed'
            j = b.agent('Putting you through to an advisor now.')
            b.tool(j, 'transfer_to_number', {'number': '+97140000000'}, 'transferred')
            state['endReason'] = 'transfer'
            b.ended = True
            return 'transfer'
        b.agent('Nobody is free right this minute. I can have an advisor call you back — would 4 p.m. work?')
        b.caller('Yes, 4 is fine.')
        k = b.agent('Done — an advisor will call you at 4 p.m.')
        b.tool(k, 'schedule_callback', {'time': '16:00', 'reason': 'transfer fallback'}, {'status': 'scheduled'})
        return 'callback'

    meet_prop = _clamp([0.42, 0.32, 0.3, 0.28, 0.4, 0.12, 0.3, 0.26, 0.01, 0, 0][pi] * [1.5, 1.1, 0.6, 0.5, 0.7, 0.9, 1.3, 0.95, 1.3, 0.1, 0.15, 0][si] * (0.6 + q * 0.8), 0, 0.92)

    if non_target:
        if pi == 8 and _chance(r, 0.35):
            b.caller('Actually, can I resell my unit before handover? I want to know if that is allowed.' if _chance(r, 0.5) else 'I want to change my payment plan — can I move the next instalment?')
            b.agent('That one is for the customer relations team — I can pass your details to them so they call you today.')
            b.caller('Okay, thank you.')
            i = b.agent('Done — I have noted it for the customer relations team.')
            b.tool(i, 'save_note', {'note': 'Existing buyer: resale or payment plan question'}, 'saved')
            state['nextStep'] = 'note'
        elif pi == 8:
            if fault(0.25, 'push'):
                b.agent("I can help with that — and while you're here, Seafront One has some great new launches you might like.")
                b.caller('I just need the service charge team.')
            b.agent('That one is for the community team rather than sales — I can pass your number to them so they call you today. Is that okay?')
            b.caller('Yes, please.')
            i = b.agent('Done — I have noted it for the community team.')
            b.tool(i, 'save_note', {'note': 'Owner query: service charge, route to community team'}, 'saved')
            state['nextStep'] = 'note'
        elif pi == 9:
            if fault(0.25, 'push'):
                b.agent('We do have some lovely units for sale that could work better than renting — have you thought about buying?')
                b.caller('No, I only want to rent.')
            b.agent("We only sell new homes on this line, so I can't help with rentals — a brokerage or a rental portal is the best place to look. Sorry I can't do more.")
            b.caller('Okay, thanks.')
        else:
            b.agent("This line is for property sales, so I can't help with jobs — the careers page on the website has the openings. Thanks for calling.")
            b.caller('Alright.')
    elif si == 3:
        state['nextStep'] = callback()
    elif si == 4:
        state['nextStep'] = transfer()
    elif si == 5:
        if _chance(r, 0.6):
            b.agent('No problem — which day would suit better?')
            b.caller('Sunday morning instead.')
            i = b.agent('Moving it to Sunday at 10 a.m.')
            b.tool(i, 'schedule_meeting', {'meeting_kind': 'site_visit', 'date': '2026-10-18', 'time': '10:00', 'reschedule': True}, {'status': 'confirmed', 'slot': 'Sunday the 18th at 10 a.m.'})
            b.agent('Done — your visit is now Sunday the 18th at 10 a.m.')
            b.caller('Great.')
            state['nextStep'] = 'meeting'
        else:
            b.agent('Do you want to move it to another day, or cancel it?')
            b.caller('Cancel it for now, please.')
            i = b.agent('Cancelling it.')
            b.tool(i, 'cancel_meeting', {'meeting_id': 'mtg_1'}, {'status': 'cancelled'})
            b.agent('That visit is cancelled. If you want to rebook, just call this line.')
            b.caller('Thanks.')
    elif si == 9:
        dnc = "don't call" in b.turns[-1]['text']
        if fault(0.03, 'push'):
            b.agent('I understand — but before you go, Island Park has a special payment plan this month. Can I send you the details?')
            b.caller('No. I said no.')
        b.agent("Of course — I've removed your number, and you won't hear from us again. Sorry for the bother." if dnc else 'No problem at all — thanks for your time.')
        if dnc:
            i = len(b.turns) - 1
            b.tool(i, 'save_note', {'note': 'do-not-contact'}, 'saved')
    elif is_broker:
        if fault(0.22, 'tools'):
            # v3's longer prompt sometimes lost the fork: a broker is treated as a buyer.
            b.agent('Lovely. Will it be just you living there, or family too?')
            b.caller("No — I said I'm a broker. I'm asking for my clients.", barge=True)
            if fault(0.4, 'tools'):
                b.agent('Sorry — are you buying for yourself, or are you a broker?')
                b.caller('A broker. As I said.')
        b.agent('Are you an independent agent, or with an agency?')
        b.caller('With an agency in London. We sell off-plan to UK buyers.' if pi == 6 else 'Independent, here in Dubai.')
        fields['broker_type'] = 'Agency, London' if pi == 6 else 'Independent, Dubai'
        if fault(0.3, 'broker'):
            b.agent('What budget are your clients working with, and how many bedrooms are they after?')
            b.caller('It varies.')
        b.agent('Is your agency already registered with us as a broker partner?')
        registered = _chance(r, 0.3)
        b.caller('Yes, we registered last year.' if registered else 'No, not yet.')
        fields['registration'] = 'Registered' if registered else 'Unregistered'
        hold = fault(0.2, 'broker')
        if not registered and not hold:
            b.agent('I can send the registration link now. Should it go to this number on WhatsApp?')
            b.caller('Yes, this number is fine.')
            i = b.agent('Sending the registration link now.')
            b.tool(i, 'send_broker_registration_link', {'registered': False, 'broker_type': 'agency' if pi == 6 else 'independent', 'channel': 'whatsapp'}, {'status': 'sent'})
        b.caller("Thanks. What's the handover on the Dubai Islands projects?")
        if fault(0.03):
            b.agent('Handover is planned for the second quarter of 2027, and two-bedrooms start at around 1.5 million dirhams.', tag='confidently')
        else:
            projs = project_tool(2, True, 'Dubai Islands')
            b.agent(f"{projs[0]['name']} hands over in {projs[0]['handover']}, and {projs[1]['name']} in {projs[1]['handover']}; two-bedrooms start from {_fmt_aed(projs[0]['from_aed'])} and {_fmt_aed(projs[1]['from_aed'])}.")
        fields['project_interest'] = 'Dubai Islands'
        if _chance(r, meet_prop * 1.4):
            b.agent('Would a call with our broker team help — they can take you through commissions and allocations?')
            b.caller("Yes — make it 11 a.m. UAE time, that's morning for me.")
            state['nextStep'] = book_meeting({'id': '', 'name': 'broker team'}, 'bdm_call')
        if not registered and hold:
            i = b.agent("And I'll send you the registration link.")
            b.tool(i, 'send_broker_registration_link', {'registered': False, 'channel': 'whatsapp'}, {'status': 'sent'})
    elif si == 10:
        topic = _pick(r, ['visa', 'visa', 'mortgage', 'yield'])
        if topic == 'visa':
            ask = _pick(r, ['Would buying here get me a golden visa?', 'Does a purchase here qualify me for the golden visa?', 'How does the golden visa work if I buy off-plan?'])
        elif topic == 'mortgage':
            ask = 'Can you tell me if I would get a mortgage as a non-resident?'
        else:
            ask = 'What rental yield can I expect on a one-bed?'
        b.caller(ask)
        if fault(0.04, 'scope'):
            b.agent('You can expect around 7 to 8 percent net on a one-bed there, which is very strong.' if topic == 'yield'
                    else 'Yes, any purchase above 2 million qualifies you for the golden visa, so you would be fine.' if topic == 'visa'
                    else 'As a non-resident you can usually borrow up to 50 percent, so that should be fine.', tag='confidently')
        else:
            b.agent(f"That's one for an advisor — I can't advise on {'returns' if topic == 'yield' else topic + 's'}, but they can take you through it. In the meantime, can I tell you what's available?")
        b.caller('Sure.')
        p = pitch()
        if _chance(r, meet_prop + 0.2):
            state['nextStep'] = send_docs(p)
    else:
        # Investor journeys S1, S2, S3, S8, S9 and related.
        if si == 1 or (si == 2 and _chance(r, 0.5)):
            b.caller(f"Can you tell me about {_pick(r, DEMO_PROJECTS)['name']}? How much are the {beds}-bedrooms?")
            if fault(0.03):
                b.agent(f'Two-bedrooms there start from about {_fmt_aed(1_450_000)}, and it hands over at the end of 2027.', tag='confidently')
                b.caller('And how big are they?')
            projs = project_tool(1, not fault(0.35, 'tools'), None)
            b.agent(f"{projs[0]['name']} {beds}-bedrooms start from about {_fmt_aed(projs[0]['from_aed'])}, around {en_us(projs[0]['size_sqft'])} square feet, handing over in {projs[0]['handover']}.")
            if not fault(0.35, 'discovery'):
                b.agent('Is it for you to live in, or as an investment?')
                b.caller('As an investment.' if pi == 2 else 'To live in.')
                fields['buy_intent'] = 'Investment' if pi == 2 else 'Live in'
            fields['project_interest'] = projs[0]['name']
            if pi == 2 and _chance(r, 0.6):
                b.caller(f"And how does that compare with the {_pick(r, COMPETITORS)} places I've seen?")
                if fault(0.3, 'scope'):
                    b.agent('Honestly this is far better than anything in that area — the returns will be much higher.', tag='enthusiastically')
                else:
                    b.agent("I can't compare other developers' projects, but I can tell you what's included here. Shall I send the brochure?")
            if _chance(r, meet_prop):
                p0 = {'id': projs[0]['id'], 'name': projs[0]['name']}
                state['nextStep'] = book_meeting(p0, 'site_visit' if _chance(r, 0.6) else 'online')
            elif _chance(r, 0.6):
                b.caller('Can you just send me the brochure?')
                state['nextStep'] = send_docs({'id': projs[0]['id'], 'name': projs[0]['name']})
        elif si == 2:
            b.caller('Can you send me the brochure?')
            if not fault(0.25, 'readback'):
                b.agent('Of course — which project should I send it for?')
                b.caller('Island Park Residences.')
            state['nextStep'] = send_docs({'id': 'island_park', 'name': 'Island Park Residences'})
        elif si == 8 and objective:
            b.caller('You were going to send me the floor plans.' if objective.startswith('Send') else 'I wanted to check the visit time.')
            if objective.startswith('Send'):
                state['nextStep'] = send_docs({'id': 'island_park', 'name': 'Island Park Residences'})
            else:
                b.agent('Your visit is on Saturday the 17th at 10 a.m. at the Island Park sales gallery.')
                b.caller('Great, thanks.')
                state['nextStep'] = 'meeting'
        else:
            # S1 discovery to meeting, S8 objection-led, P6 browsers, S9 without objective.
            discovery(si == 0 or pi == 0 or pi == 4)
            p = pitch()
            if si == 7 or (pi == 5 and _chance(r, 0.6)):
                ok = objection(_pick(r, ['budget', 'location', 'timing', 'family']))
                if ok:
                    state['nextStep'] = send_docs(p)
                elif _chance(r, 0.4):
                    state['nextStep'] = callback()
            elif _chance(r, meet_prop):
                state['nextStep'] = book_meeting(p, 'site_visit' if _chance(r, 0.7) else 'online')
            elif _chance(r, 0.4):
                b.caller('Let me think about it. Can you send me something to read?')
                state['nextStep'] = send_docs(p)
            elif _chance(r, 0.35):
                b.caller('Let me think about it and talk it over at home.')
                b.agent('Of course — take your time. If anything comes up, just call this line.')
            elif _chance(r, 0.5):
                b.caller("I'll think about it.")
                i = b.agent('Of course. I will note that you are interested so an advisor can follow up next week.')
                b.tool(i, 'save_note', {'note': f"Interested in {p['name']}, follow up next week"}, 'saved')
                state['nextStep'] = 'note'

    # ---------- Conclusion ----------
    if not b.ended and si == 9:
        last = b.turns[-1] if b.turns else None
        if last is not None and last['speaker'] == 'agent' and not any(t['name'] == 'end_call' for t in b.tools):
            j = b.agent('Goodbye.')
            b.tool(j, 'end_call', {}, 'ended')
        b.ended = True
    if not b.ended:
        abandon = fault(0.1, 'close')
        if abandon:
            b.agent("Would you like a call with an advisor to talk through the numbers? They can cover payment stages, the community and anything you're comparing against, and I can book it for—", interrupted=True)
            state['endReason'] = 'caller_hangup'
        else:
            if _chance(r, 0.6):
                b.agent('Is there anything else I can help with?')
                b.caller("No, that's all. Thanks.")
            close_name = not fault(0.3, 'close') and fields.get('name')
            i = b.agent(f"Thank you, {fields['name']}. Have a good day — goodbye." if close_name else 'Thanks for calling. Goodbye.')
            if not fault(0.1, 'tools'):
                b.tool(i, 'end_call', {}, 'ended')
    return finish()


def _dt(ms: int) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=ms)


def generate_demo_calls(*, count: int, days: float, seed: int | None = 42, now: datetime | None = None, versions: list[dict] | None = None) -> list[dict]:
    """A batch of demo calls spread over the last `days`, with prompt versions by date."""
    seed = 42 if seed is None else seed
    now_t = to_ms(now) if now is not None else now_ms()
    vs = versions if versions is not None else [
        {'label': 'v2', 'fromDaysAgo': days, 'toDaysAgo': math.floor(days / 3) + 1},
        {'label': 'v3', 'fromDaysAgo': math.floor(days / 3), 'toDaysAgo': 0},
    ]
    r = mulberry32(seed)
    out = []
    for i in range(count):
        days_ago = r() * days
        t = math.trunc(now_t - days_ago * 86_400_000)
        # Business hours in Dubai (UTC+4): 9:00–21:00. setUTCHours keeps the milliseconds.
        h = 5 + math.floor(r() * 12)
        m = math.floor(r() * 60)
        s = math.floor(r() * 60)
        day, rem = divmod(t, 86_400_000)
        t = day * 86_400_000 + h * 3_600_000 + m * 60_000 + s * 1000 + rem % 1000
        if t > now_t:
            t = now_t - 60_000 * (1 + math.floor(r() * 600))
        v = next((x for x in vs if x['toDaysAgo'] <= days_ago <= x['fromDaysAgo']), vs[-1])
        out.append(generate_call(i + 1 + seed * 100_000, at=_dt(t), version=v['label']))
    return sorted(out, key=lambda c: c['startedAt'])


def demo_outcomes(calls: list[dict], seed: int = 9) -> list[dict]:
    """CRM outcomes for demo leads: meetings attended, site visits, reservations with AED values."""
    r = mulberry32(seed)
    out: list[dict] = []
    deal = {'P1': 2.1, 'P2': 1.3, 'P3': 1.6, 'P4': 2.4, 'P5': 2.6, 'P6': 1.2}
    for c in calls:
        if not c.get('leadId'):
            continue
        t0 = to_ms(datetime.fromisoformat(c['startedAt'].replace('Z', '+00:00')))
        q = (c['cqs'] if c.get('cqs') is not None else 70) / 100
        cap = now_ms() - 3_600_000

        def at(d: float) -> str:
            return iso(math.trunc(min(cap, t0 + d * 86_400_000)))

        lead = c['leadId']
        if c.get('nextStep') == 'meeting' and c.get('meetingKind') == 'bdm_call':
            if _chance(r, 0.6):
                out.append({'lead_id': lead, 'stage': 'broker_registered', 'occurred_at': at(2 + r() * 5), 'project': None, 'value_aed': None, 'external_id': f'{lead}_reg'})
            if _chance(r, 0.5):
                out.append({'lead_id': lead, 'stage': 'bdm_call_held', 'occurred_at': at(4 + r() * 6), 'project': None, 'value_aed': None, 'external_id': f'{lead}_bdm'})
            if _chance(r, 0.2):
                out.append({'lead_id': lead, 'stage': 'broker_deal', 'occurred_at': at(20 + r() * 60), 'project': 'Island Park Residences', 'value_aed': 1_600_000, 'external_id': f'{lead}_bdeal'})
            continue
        if c.get('nextStep') != 'meeting' and not (c.get('nextStep') == 'document' and _chance(r, 0.12)):
            continue
        if not _chance(r, 0.45 + q * 0.35):
            continue
        out.append({'lead_id': lead, 'stage': 'meeting_attended', 'occurred_at': at(2 + r() * 6), 'project': 'Island Park Residences', 'value_aed': None, 'external_id': f'{lead}_att'})
        if _chance(r, 0.55):
            out.append({'lead_id': lead, 'stage': 'site_visit', 'occurred_at': at(3 + r() * 10), 'project': 'Island Park Residences', 'value_aed': None, 'external_id': f'{lead}_sv'})
        if _chance(r, 0.05 + q * 0.06):
            v = deal.get(c.get('persona') if c.get('persona') is not None else '', 1.5) * (0.8 + r() * 0.5) * 1_000_000
            out.append({'lead_id': lead, 'stage': 'reservation', 'occurred_at': at(8 + r() * 20), 'project': 'Island Park Residences', 'value_aed': js_round(v / 1000) * 1000, 'external_id': f'{lead}_res'})
    return out
