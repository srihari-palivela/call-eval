from __future__ import annotations

import base64
import hashlib
import os


def new_id(prefix: str) -> str:
    return f"{prefix}_{base64.urlsafe_b64encode(os.urandom(9)).decode().rstrip('=')}"


def sha(s: str, n: int = 16) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:n]


def call_id_of(provider: str, external_id: str) -> str:
    """Stable internal call id: provider plus the provider's conversation id (and the workspace, outside the default)."""
    from ..tenancy import namespaced
    prefix = {'elevenlabs': 'el', 'retell': 'rt', 'upload': 'up'}.get(provider, 'dm')
    return namespaced(f'{prefix}_{external_id}')
