# Roles and what they may do. Roles are fixed; each is a set of permissions, and every API route names the
# permission it needs (auth/policy.py). Risky permissions are the ones that place calls, change the live
# agent, spend money or change how every call is scored.

from __future__ import annotations

PERMISSIONS: list[dict] = [
    {'id': 'analytics:read', 'label': 'Read dashboards', 'description': 'Quality matrix, funnels, versions, traces, alerts, taxonomy health and business goals, in aggregate.', 'risky': False},
    {'id': 'calls:read', 'label': 'Read calls', 'description': 'Transcripts, recordings, call summaries, recommendations with quoted evidence, the review queue.', 'risky': False},
    {'id': 'calls:review', 'label': 'Review calls', 'description': 'Resolve review items and label calls.', 'risky': False},
    {'id': 'calls:upload', 'label': 'Upload recordings', 'description': 'Upload call recordings for scoring.', 'risky': False},
    {'id': 'quality:manage', 'label': 'Manage quality work', 'description': 'Recommendations, attention items, alerts, clusters and re-scoring calls.', 'risky': False},
    {'id': 'taxonomy:edit', 'label': 'Edit taxonomy drafts', 'description': 'Change personas, scenarios and events in a draft.', 'risky': False},
    {'id': 'taxonomy:activate', 'label': 'Activate a taxonomy', 'description': 'Make a draft the version every call is scored with, and re-score history.', 'risky': True},
    {'id': 'settings:manage', 'label': 'Change settings', 'description': 'The scoring model, thresholds, retention, modules and demo data.', 'risky': True},
    {'id': 'integrations:manage', 'label': 'Manage integrations', 'description': 'Voice platforms, CRM feeds and lead finders, including their keys.', 'risky': True},
    {'id': 'business:manage', 'label': 'Edit business setup', 'description': 'Company, ideal customer profile, goals and calling rules.', 'risky': False},
    {'id': 'crm:read', 'label': 'Read leads', 'description': 'Leads with their contact details, and funnels.', 'risky': False},
    {'id': 'crm:write', 'label': 'Change leads and funnels', 'description': 'Add, import, edit and delete leads; design funnels; record outcomes.', 'risky': False},
    {'id': 'leadfinder:spend', 'label': 'Use lead finders', 'description': 'Search and enrich leads in Apollo.io, which spends credits.', 'risky': True},
    {'id': 'campaigns:read', 'label': 'Read campaigns', 'description': 'Campaigns, improvement cycles and lessons.', 'risky': False},
    {'id': 'campaigns:manage', 'label': 'Manage campaigns', 'description': 'Create, edit, pause and cancel campaigns.', 'risky': False},
    {'id': 'campaigns:start', 'label': 'Start campaigns', 'description': 'Start a campaign, which places real phone calls.', 'risky': True},
    {'id': 'improvement:approve', 'label': 'Approve improvement cycles', 'description': 'Start cycles, and approve, reject or verify challengers.', 'risky': False},
    {'id': 'improvement:promote', 'label': 'Promote prompts', 'description': 'Promote or roll back a prompt, which changes the live agent.', 'risky': True},
    {'id': 'copilot:use', 'label': 'Use the co-pilot', 'description': 'Ask the co-pilot for drafts, which spends Claude credits.', 'risky': True},
    {'id': 'users:manage', 'label': 'Manage users', 'description': 'Invite users, change roles, reset passwords, revoke API tokens.', 'risky': True},
    {'id': 'audit:read', 'label': 'Read the audit log', 'description': 'Who changed what, and when.', 'risky': False},
]
ALL = tuple(p['id'] for p in PERMISSIONS)

ROLES: list[dict] = [
    {'id': 'owner', 'name': 'Owner', 'description': 'Everything, including other owners.', 'permissions': ALL},
    {'id': 'admin', 'name': 'Admin', 'description': 'Everything except changing owners.', 'permissions': ALL},
    {'id': 'qa_lead', 'name': 'QA lead', 'description': 'Call quality: reviews, recommendations, taxonomy drafts, improvement approvals.',
     'permissions': ('analytics:read', 'calls:read', 'calls:review', 'calls:upload', 'quality:manage', 'taxonomy:edit', 'campaigns:read', 'improvement:approve',
                     'copilot:use')},
    {'id': 'sales_manager', 'name': 'Sales manager', 'description': 'Business setup, leads, funnels, lead finders and campaigns.',
     'permissions': ('analytics:read', 'calls:read', 'business:manage', 'crm:read', 'crm:write', 'leadfinder:spend', 'campaigns:read', 'campaigns:manage',
                     'campaigns:start', 'copilot:use')},
    {'id': 'reviewer', 'name': 'Reviewer', 'description': 'Reads calls and works the review queue.', 'permissions': ('analytics:read', 'calls:read', 'calls:review')},
    {'id': 'viewer', 'name': 'Viewer', 'description': 'Dashboards only: no transcripts, recordings or contact details.', 'permissions': ('analytics:read',)},
]
ROLE_IDS = tuple(r['id'] for r in ROLES)
_BY_ID = {r['id']: frozenset(r['permissions']) for r in ROLES}


def permissions_of(role: str) -> frozenset[str]:
    return _BY_ID.get(role, frozenset())


def within(role: str, perms: frozenset[str]) -> bool:
    """Whether everything the role allows is also in `perms` (nobody grants more than they have)."""
    return role in _BY_ID and _BY_ID[role] <= perms


def roles_dto() -> list[dict]:
    return [{**r, 'permissions': list(r['permissions'])} for r in ROLES]


def label_of(permission: str) -> str:
    return next((p['label'] for p in PERMISSIONS if p['id'] == permission), permission)
