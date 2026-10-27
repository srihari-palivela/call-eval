# Transcript helpers and the phrase patterns the code checks rely on. They cover English, which is
# the language in scope for v1; other languages fall through to the LLM judge.

from __future__ import annotations

import math
import re
from typing import Any

from ..js import at, fixed, is_nan, js_round, js_split, js_str, jsre, match_all

_WORDS = re.compile(r"(?:[^\W_]|['’])+")


def words(s: str) -> list[str]:
    return _WORDS.findall(s)


def word_count(s: str) -> int:
    return len(words(s))


_TAGS = jsre(r'\[[a-z][a-z _-]{1,30}\]\s*', 'gi')


def strip_tags(s: str) -> str:
    return _TAGS.sub('', s).strip()


def lc(s: str) -> str:
    return strip_tags(s).lower()


def question_count(s: str) -> int:
    return strip_tags(s).count('?')


_SENT = jsre(r'(?<=[.!?])\s+')


def sentences(s: str) -> list[str]:
    return [x for x in js_split(strip_tags(s), _SENT) if x]


def js_string(v: Any) -> str:
    """String(v) for values read from JSON."""
    if v is None:
        return 'null'
    if isinstance(v, str):
        return v
    if isinstance(v, (bool, int, float)):
        return js_str(v)
    if isinstance(v, list):
        return ','.join('' if x is None else js_string(x) for x in v)
    return '[object Object]'


def truthy(v: Any) -> bool:
    """JavaScript truthiness: empty containers are truthy, NaN is falsy."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0 and not is_nan(v)
    if isinstance(v, str):
        return v != ''
    return True


RX: dict[str, Any] = {
    'backchannel': jsre(r'^(yeah|yes|yep|mm+|mhm|uh-huh|okay|ok|right|sure|got it|i see)[.!]?$', 'i'),
    'goodbye': jsre(r"\b(bye|goodbye|that'?s all|that is all|nothing else|that'?s it|have a (good|nice) (day|one))\b", 'i'),
    'dnc': jsre(r"\b(don'?t call|do not call|stop calling|take my number off|remove my number|never call)\b", 'i'),
    'refusal': jsre(r"^(no\b|no,|not (interested|now|really)|i'?m not interested|i said no|no thanks|i'?ll leave it|i think i will leave it)", 'i'),
    'reopen': jsre(r'\b(one more thing|actually|also|another question|wait)\b|\?', 'i'),
    'objection': {
        'objection_budget': jsre(r"\b(too expensive|above (what|our)|over (my|our) budget|can'?t afford|a bit (much|high)|pricey|cheaper)\b", 'i'),
        'objection_location': jsre(r'\b(location|too far|far from|not sure about the (area|community))\b', 'i'),
        'objection_timing': jsre(r'\b(handover is too late|too late for us|not (ready|in a rush)|timing)\b', 'i'),
        'objection_family': jsre(r'\b(talk to my (wife|husband|partner|family)|consult (my )?(family|wife|husband)|family decision)\b', 'i'),
        'objection_just_looking': jsre(r'\b(just looking|only looking|browsing)\b', 'i'),
        'competitor_mentioned': jsre(r"\b(compare[sd]? with|other developer|dubai marina places|business bay places|downtown places|i'?ve seen elsewhere)\b", 'i'),
    },
    'askedIfAi': jsre(r'\b(are you (a )?(bot|robot|ai|real person|human|computer)|is this (a )?(bot|recording|ai))\b', 'i'),
    'offTopic': jsre(r'\b(visa|golden visa|mortgage|rental (return|yield)|yield|rent(ing)?\b|service charge|snagging|job|vacancy|wrong number|complaint)\b', 'i'),
    'frustration': jsre(r"\b(i said|i told you|already told|okay,? okay|just send|you used it|we said|for the (second|third) time|that'?s not what i)\b", 'i'),
    'correction': jsre(r"\b(no,? i said|not .{1,40}(—|-|,) ?(we|i) said|that'?s not what i|i told you|you used it|we said|i said)\b", 'i'),
    'timeCheck': jsre(r'\b(good time|is now (still )?(a )?(good|ok|okay|convenient)|have a (minute|moment|couple of minutes)|couple of minutes)\b', 'i'),
    'howCanIHelp': jsre(r'\bhow can i help( you)?\b', 'i'),
    'callbackMention': jsre(r'\b(call(ing)? you back|asked us to call|requested a call|you asked (us|me) to call)\b', 'i'),
    'personaFork': jsre(r'\b(buying for yourself|for yourself,? or|are you a broker|or (are you )?a broker|investor or (a )?broker|buyer or (a )?broker)\b', 'i'),
    'liveOrInvest': jsre(r'\b(live in|to live|or (is it|as an?) investment|invest(ment)?)\b', 'i'),
    'nameAsk': jsre(r"\b(your name|who am i speaking|may i (take|have|get) your name|what'?s your name|name again)\b", 'i'),
    'readBack': jsre(r'\b(ending (in )?\d{2,4}|is that (right|correct)|this number|that number|confirm (the|your)|@[a-z0-9.-]+|on whatsapp,? on|should it go to)\b', 'i'),
    'greeting': jsre(r'\b(thanks for calling|thank you for calling|hi|hello|good (morning|afternoon|evening))\b', 'i'),
    'thanksName': jsre(r'\b(thank you|thanks)\b', 'i'),
    'empathy': jsre(r"\b(sorry|i understand|understood|fair|that makes sense|you'?re right|apolog|of course|no problem)\b", 'i'),
    'enthusiasm': jsre(r'(!|\b(amazing|exciting|incredible|fantastic|so much going for it|one of the most)\b)', 'i'),
    'positive': jsre(r'\b(great|perfect|lovely|thanks|thank you|sounds (good|right|great)|yes|sure|good|wonderful|excellent)\b', 'i'),
    'negative': jsre(r"\b(no\b|not\b|too expensive|frustrat|annoy|i said|already|don'?t|can'?t|won'?t|leave it|just send|okay,? okay)\b", 'i'),
    'projectFact': jsre(r'(\b\d[\d,.]*\s*(million|thousand|k)?\s*(dirhams|aed)\b|\baed\s*\d|\b\d[\d,]*\s*(square feet|sq ?ft|sqft)\b|\bhand(s|ing)? ?over\b.*\b(20\d\d|q[1-4])\b|\b(q[1-4])\s*20\d\d\b)', 'i'),
    'yieldAdvice': jsre(r'\b\d+(\.\d+)?\s*(to \d+(\.\d+)?\s*)?(%|percent)\b.{0,40}\b(net|yield|return|returns)\b|\b(net|yield|return)s?\b.{0,30}\b\d+(\.\d+)?\s*(%|percent)', 'i'),
    'visaAdvice': jsre(r'\b(qualif(y|ies) (you )?for (the|a) golden visa|you would (be fine|qualify)|any purchase above .{0,30} qualif)', 'i'),
    'mortgageAdvice': jsre(r"\b(you can (usually )?borrow up to|you('?ll| will) (easily )?get a mortgage|ltv of)\b", 'i'),
    'promise': jsre(r'\b(guarantee(d)?|discount|special (price|offer|payment plan)|\d+% return|free (dld|registration))\b', 'i'),
    'negated': jsre(r"\b(can'?t|cannot|not able to|no way to|don'?t|unable to)\b"),
    'denyAi': jsre(r"\b(i'?m (a )?(real|human) (person|being)|i'?m not a (bot|robot|machine|ai)|no,? i'?m (a )?(human|person))\b", 'i'),
    'otherCustomer': jsre(r'\b(another (client|customer|buyer) (of ours )?(named|called|bought|just)|(mr|mrs|ms)\.? [a-z]+ (bought|purchased|reserved))\b', 'i'),
    'bareQuestion': jsre(r'^[^.!]{0,90}\?$'),
}

BUYER_DISCOVERY_RX = jsre(r'\b(budget|how many bedrooms|bedrooms are they|when would you (want to )?move|timeline|live in (it )?yourself|which areas|must-haves?)\b', 'i')

FIELD_ASK_RX: dict[str, Any] = {
    'name': RX['nameAsk'],
    'budget': jsre(r'\b(budget|price range|how much (are you|were you) (looking|planning) to spend)\b', 'i'),
    'bedrooms': jsre(r'\bhow many bedrooms\b', 'i'),
    'location': jsre(r'\b(which areas|where (are you|would you like) (looking|to live))\b', 'i'),
    'timeline': jsre(r'\b(when would you (want to )?move|timeline|lease ends)\b', 'i'),
    'project_interest': jsre(r'\bwhich project\b', 'i'),
    'persona': RX['personaFork'],
}


def fmt_time(t: float) -> str:
    m, s = math.floor(t / 60), math.floor(math.fmod(t, 60))
    return f'{m}:{str(s).zfill(2) if s >= 0 else str(s)}'


def agent_turns(call: dict) -> list[dict]:
    return [t for t in call['turns'] if t['speaker'] == 'agent']


def caller_turns(call: dict) -> list[dict]:
    return [t for t in call['turns'] if t['speaker'] == 'caller']


def prev_turn(call: dict, t: dict) -> dict | None:
    return at(call['turns'], t['idx'] - 1)


def next_agent_turn(call: dict, idx: int) -> dict | None:
    return next((t for t in call['turns'] if t['idx'] > idx and t['speaker'] == 'agent'), None)


def turn_end(t: dict) -> float:
    e = t.get('endS')
    return e if e is not None else t['startS'] + max(0.6, word_count(t['text']) / 2.5)


_POS_G = jsre(RX['positive'].pattern, 'gi')
_NEG_G = jsre(RX['negative'].pattern, 'gi')


def sentiment(text: str) -> float:
    """Caller sentiment per turn in [-1, 1] from a small lexicon (transcript side of the emotion metrics)."""
    s = lc(text)
    pos = len(match_all(_POS_G, s))
    neg = len(match_all(_NEG_G, s)) + (2 if RX['frustration'].search(s) else 0)
    if not pos and not neg:
        return 0
    return max(-1, min(1, (pos - neg) / max(2, pos + neg)))


def quote_of(call: dict, idx: int | None) -> str | None:
    if idx is None:
        return None
    t = at(call['turns'], idx)
    return t['text'] if t is not None and t.get('text') is not None else None


# Voice agents usually write numbers out as words so the TTS reads them naturally ("one point two
# five million dirhams"). Number checks normalise them to digits first.
UNITS = {'zero': 0, 'oh': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19}
TENS = {'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90}
_NON_ALPHA = re.compile(r'[^a-z]')
_END_PUNCT = re.compile(r'[,;.!?]$')


def _bare(w: str | None) -> str:
    return _NON_ALPHA.sub('', (w or '').lower())


def _read_number(ws: list[str], i: int) -> tuple[float, int] | None:
    total = cur = 0
    seen = after_hundred = False
    j = i
    while j < len(ws):
        w = _bare(ws[j])
        if w in UNITS or w in TENS:
            cur += UNITS[w] if w in UNITS else TENS[w]
            seen = True
            after_hundred = False
            j += 1
        elif w == 'hundred' and seen:
            cur = (cur or 1) * 100
            after_hundred = True
            j += 1
        elif w == 'thousand' and seen:
            total += cur * 1000
            cur = 0
            j += 1
        elif w == 'and' and seen and _bare(at(ws, j + 1)) == 'a' and _bare(at(ws, j + 2)) == 'half':
            cur += 0.5
            j += 3
            break
        elif w == 'and' and after_hundred and (_bare(at(ws, j + 1)) in UNITS or _bare(at(ws, j + 1)) in TENS):
            j += 1
        elif w == 'point' and seen:
            k, dec = j + 1, ''
            while k < len(ws) and _bare(ws[k]) in UNITS and UNITS[_bare(ws[k])] < 10:
                dec += str(UNITS[_bare(ws[k])])
                k += 1
            if dec:
                cur += float(f'0.{dec}')
                j = k
            break
        else:
            break
        if _END_PUNCT.search(at(ws, j - 1) or ''):
            break
    return (total + cur, j) if seen else None


_WS = jsre(r'\s+')
_TAIL = re.compile(r'[,;.!?]+$')


def words_to_digits(text: str) -> str:
    """Replace spelled-out numbers with digits: "one and a half million" → "1.5 million"."""
    ws = [w for w in js_split(text, _WS) if w]
    out: list[str] = []
    i = 0
    while i < len(ws):
        r = _read_number(ws, i)
        if r:
            value, nxt = r
            m = _TAIL.search(ws[nxt - 1])
            out.append(f'{js_str(fixed(value, 4))}{m.group(0) if m else ""}')
            i = nxt
        else:
            out.append(ws[i])
            i += 1
    return ' '.join(out)


_MONEY = jsre(r'(?:\b(?:aed|dhs?)\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(million|mn|m|thousand|k)\b)?(?:\s*(aed|dirhams?|dhs?)\b)?', 'gi')
_CUR_PREFIX = jsre(r'^(aed|dh)', 'i')


def money_amounts(text: str) -> list[int]:
    """Money amounts in AED stated in a sentence, written or spoken."""
    s = words_to_digits(strip_tags(text))
    out: list[int] = []
    for m in _MONEY.finditer(s):
        n = float(m.group(1).replace(',', ''))
        if not math.isfinite(n):
            continue
        scale = (m.group(2) or '').lower()
        currency = bool(m.group(3)) or bool(_CUR_PREFIX.search(m.group(0)))
        v = n * 1_000_000 if scale in ('million', 'mn', 'm') else n * 1000 if scale in ('thousand', 'k') else n
        # A bare number counts only when it carries a currency or a scale (bedrooms and years do not).
        if (scale or currency) and v >= 10_000:
            out.append(js_round(v))
    return out


_NUMS = jsre(r'(\d[\d,]*(?:\.\d+)?)\s*(million|m|k)?\b', 'gi')


def numbers_in(text: str) -> list[float]:
    """Numbers in a tool result, with "1.25M"-style scales applied."""
    out: list[float] = []
    for m in _NUMS.finditer(text):
        n = float(m.group(1).replace(',', ''))
        sc = (m.group(2) or '').lower()
        v = n * 1_000_000 if sc in ('million', 'm') else n * 1000 if sc == 'k' else n
        if math.isfinite(v):
            out.append(v)
    return out


# True when the caller gives a contact the agent does not already hold (a new number or email).
NEW_CONTACT = jsre(r"@|\b(gmail|hotmail|outlook|yahoo|icloud)\b|\bdot com\b|\b(different|another|other|new|my work|my personal) (number|email|e-mail|whatsapp)\b|\bmy e-?mail (is|address)\b|\bsend it to my e-?mail\b|\d{7,}", 'i')
_DIGIT_GAPS = jsre(r'(\d)[\s-]+(?=\d)', 'g')


def has_new_contact(text: str) -> bool:
    return NEW_CONTACT.search(_DIGIT_GAPS.sub(r'\1', words_to_digits(text))) is not None
