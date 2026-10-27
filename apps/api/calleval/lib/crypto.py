# Secrets stored from the console (provider API keys, webhook secrets) are encrypted at rest with
# AES-256-GCM under a key derived from APP_SECRET. The format (v1:iv:tag:data, base64) is the one
# the TypeScript service wrote, so existing databases keep working.

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import config
from .log import log

_warned = False


def _key() -> bytes:
    global _warned
    secret = config.app_secret
    if not secret:
        if not _warned:
            log.warn('APP_SECRET is not set; using a development key to encrypt stored secrets. Set APP_SECRET in production.')
            _warned = True
        secret = 'calleval-dev-secret-change-me'
    return hashlib.sha256(secret.encode()).digest()


def encrypt(plain: str) -> str:
    iv = os.urandom(12)
    out = AESGCM(_key()).encrypt(iv, plain.encode(), None)
    data, tag = out[:-16], out[-16:]
    return ':'.join(['v1', base64.b64encode(iv).decode(), base64.b64encode(tag).decode(), base64.b64encode(data).decode()])


def decrypt(blob: str) -> str:
    v, iv, tag, data = blob.split(':')
    if v != 'v1':
        raise ValueError('Unknown secret format')
    return AESGCM(_key()).decrypt(base64.b64decode(iv), base64.b64decode(data) + base64.b64decode(tag), None).decode()


def hint(s: str | None) -> str | None:
    return f'…{s[-4:]}' if s else None
