# Which permission each API route needs, in one table, checked by one dependency on every route. A route
# missing from the table is refused (and a test fails), so a new route can't ship without a decision.
# Several permissions in a tuple are all required (a co-pilot draft for funnels needs crm:write and copilot:use).

from __future__ import annotations

from fastapi import Request

from ..lib.errors import http_error
from ..lib.log import log
from .roles import ROLES, label_of

PUBLIC = 'public'
SIGNED_IN = 'signed-in'

_DASH = 'analytics:read'
POLICY: dict[str, str | tuple[str, ...]] = {
    # Signing in and your own account
    'GET /api/auth/status': PUBLIC,
    'POST /api/auth/setup': PUBLIC,
    'POST /api/auth/login': PUBLIC,
    'GET /api/auth/invites/{token}': PUBLIC,
    'POST /api/auth/invites/{token}/accept': PUBLIC,
    'POST /api/auth/logout': SIGNED_IN,
    'GET /api/auth/me': SIGNED_IN,
    'PUT /api/auth/me': SIGNED_IN,
    'GET /api/auth/roles': SIGNED_IN,
    'GET /api/auth/tokens': SIGNED_IN,
    'POST /api/auth/tokens': SIGNED_IN,
    'DELETE /api/auth/tokens/{id}': SIGNED_IN,
    'POST /api/auth/signup': PUBLIC,
    'POST /api/auth/verify': PUBLIC,
    'POST /api/auth/resend': PUBLIC,
    'POST /api/auth/forgot': PUBLIC,
    # Workspace and the setup checklist
    'GET /api/workspace': SIGNED_IN,
    'PATCH /api/workspace': 'users:manage',
    'GET /api/setup': SIGNED_IN,
    'POST /api/setup/dismiss': SIGNED_IN,
    # Billing
    'GET /api/billing/plans': SIGNED_IN,
    'GET /api/billing': 'settings:manage',
    'POST /api/billing/checkout': 'settings:manage',
    'POST /api/billing/topup': 'settings:manage',
    'POST /api/billing/portal': 'settings:manage',
    'PUT /api/billing/settings': 'settings:manage',
    # Calling compliance
    'GET /api/compliance': 'crm:read',
    'POST /api/compliance/dnc': 'crm:write',
    'DELETE /api/compliance/dnc': 'crm:write',
    'GET /api/compliance/dnc/check': 'crm:read',
    # Users and access
    'GET /api/access': 'users:manage',
    'POST /api/access/invites': 'users:manage',
    'DELETE /api/access/invites/{id}': 'users:manage',
    'PATCH /api/access/users/{id}': 'users:manage',
    'POST /api/access/users/{id}/reset': 'users:manage',
    'DELETE /api/access/users/{id}/sessions': 'users:manage',
    'GET /api/access/audit': 'audit:read',
    # Reference data and dashboards
    'GET /api/meta': _DASH,
    'GET /api/settings': _DASH,
    'PUT /api/settings': 'settings:manage',
    'GET /api/matrix': _DASH,
    'GET /api/cells/{pid}/{sid}': _DASH,  # sample calls are left out without calls:read
    'GET /api/fix': _DASH,
    'GET /api/funnel': _DASH,
    'GET /api/version-report': _DASH,
    'GET /api/traces': _DASH,
    'GET /api/alerts': _DASH,
    'POST /api/alerts/{id}/ack': 'quality:manage',
    'GET /api/attention-items': _DASH,
    'PUT /api/attention-items/{key}': 'quality:manage',
    'GET /api/jobs': _DASH,
    # Calls and quality work
    'GET /api/calls': 'calls:read',
    'GET /api/calls/{id}': 'calls:read',
    'GET /api/calls/{id}/audio': 'calls:read',
    'POST /api/calls/{id}/reevaluate': 'quality:manage',
    'POST /api/calls/{id}/labels': 'calls:review',
    'GET /api/recordings': 'calls:read',
    'POST /api/uploads': 'calls:upload',
    'GET /api/review': 'calls:read',
    'POST /api/review/{id}': 'calls:review',
    'GET /api/recommendations': 'calls:read',
    'POST /api/recommendations/generate': 'quality:manage',
    'PATCH /api/recommendations/{id}': 'quality:manage',
    # Taxonomy
    'GET /api/taxonomy': _DASH,
    'GET /api/taxonomy/health': _DASH,
    'POST /api/taxonomy/clusters/run': 'quality:manage',
    'POST /api/taxonomy/clusters/{id}/propose': 'quality:manage',
    'POST /api/taxonomy/draft': 'taxonomy:edit',
    'PUT /api/taxonomy/draft': 'taxonomy:edit',
    'POST /api/taxonomy/draft/apply': 'taxonomy:edit',
    'DELETE /api/taxonomy/draft': 'taxonomy:edit',
    'POST /api/taxonomy/draft/activate': 'taxonomy:activate',
    'POST /api/taxonomy/copilot': ('taxonomy:edit', 'copilot:use'),
    # Data in
    'GET /api/integrations': 'integrations:manage',
    'POST /api/integrations': 'integrations:manage',
    'PATCH /api/integrations/{id}': 'integrations:manage',
    'DELETE /api/integrations/{id}': 'integrations:manage',
    'POST /api/integrations/{id}/test': 'integrations:manage',
    'POST /api/integrations/{id}/sync': 'integrations:manage',
    'POST /api/crm/outcomes': 'crm:write',
    'POST /api/crm/outcomes/csv': 'crm:write',
    'POST /api/demo/seed': 'settings:manage',
    # Business setup, CRM and funnels
    'GET /api/business': _DASH,
    'PUT /api/business': 'business:manage',
    'POST /api/business/copilot': ('business:manage', 'copilot:use'),
    'GET /api/crm/leads': 'crm:read',
    'POST /api/crm/leads': 'crm:write',
    'POST /api/crm/leads/import': 'crm:write',
    'GET /api/crm/leads/{id}': 'crm:read',
    'PATCH /api/crm/leads/{id}': 'crm:write',
    'POST /api/crm/leads/{id}/stage': 'crm:write',
    'DELETE /api/crm/leads/{id}': 'crm:write',
    'GET /api/crm/funnels': 'crm:read',
    'POST /api/crm/funnels': 'crm:write',
    'POST /api/crm/funnels/copilot': ('crm:write', 'copilot:use'),
    'GET /api/crm/funnels/{id}': 'crm:read',
    'PUT /api/crm/funnels/{id}': 'crm:write',
    'DELETE /api/crm/funnels/{id}': 'crm:write',
    'POST /api/crm/funnels/{id}/default': 'crm:write',
    'GET /api/crm/funnels/{id}/report': 'crm:read',
    'POST /api/leadfinder/search': 'leadfinder:spend',
    'POST /api/leadfinder/enrich': 'leadfinder:spend',
    # Campaigns and self-improvement
    'GET /api/campaigns': 'campaigns:read',
    'POST /api/campaigns': 'campaigns:manage',
    'GET /api/campaigns/{id}': 'campaigns:read',
    'PATCH /api/campaigns/{id}': 'campaigns:manage',
    'POST /api/campaigns/{id}/start': 'campaigns:start',
    'POST /api/campaigns/{id}/pause': 'campaigns:manage',
    'POST /api/campaigns/{id}/cancel': 'campaigns:manage',
    'POST /api/campaigns/{id}/improve': 'improvement:approve',
    'GET /api/improvement/cycles': 'campaigns:read',
    'GET /api/improvement/cycles/{id}': 'campaigns:read',
    'POST /api/improvement/cycles/{id}/approve': 'improvement:approve',
    'POST /api/improvement/cycles/{id}/reject': 'improvement:approve',
    'POST /api/improvement/cycles/{id}/verify': 'improvement:approve',
    'POST /api/improvement/cycles/{id}/promote': 'improvement:promote',
    'POST /api/improvement/cycles/{id}/rollback': 'improvement:promote',
    'GET /api/improvement/lessons': 'campaigns:read',
}

_ROLE_NAMES = {r['id']: r['name'] for r in ROLES}


def route_key(request: Request) -> str | None:
    route = request.scope.get('route')
    path = getattr(route, 'path', None)
    if path is None:
        return None
    method = 'GET' if request.method == 'HEAD' else request.method
    return f'{method} {path}'


async def authorize(request: Request) -> None:
    """Runs on every route after routing: an /api route needs its permission from POLICY."""
    if not request.url.path.startswith('/api'):
        return
    key = route_key(request)
    need = POLICY.get(key or '')
    if need is None:
        log.error('API route without a permission in auth/policy.py', {'route': key})
        raise http_error(403, 'This route has no permission set')
    request.state.action = key
    if need == PUBLIC:
        return
    p = getattr(request.state, 'principal', None)
    if p is None:
        raise http_error(401, 'Sign in first')
    if need == SIGNED_IN:
        return
    missing = [n for n in ((need,) if isinstance(need, str) else need) if not p.can(n)]
    if missing:
        raise http_error(403, f"Your role ({_ROLE_NAMES.get(p.role, p.role)}) can’t do this: it needs “{label_of(missing[0])}”.")
