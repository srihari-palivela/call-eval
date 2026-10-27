# Password hashing with Argon2id (OWASP's recommended settings: 19 MiB, 2 passes, 1 lane), stored in the
# PHC string format so the settings can be raised later without breaking existing hashes. Hashing runs in a
# thread so a sign-in never stalls the event loop.

from __future__ import annotations

import asyncio
import base64
import hmac
import os
import re

from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

from ..lib.errors import http_error

MEMORY_KIB, ITERATIONS, LANES = 19 * 1024, 2, 1
MIN_LENGTH, MAX_LENGTH = 12, 256
_PHC = re.compile(r'^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$')


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode().rstrip('=')


def _unb64(s: str) -> bytes:
    return base64.b64decode(s + '=' * (-len(s) % 4))


def _derive(password: str, salt: bytes, m: int, t: int, p: int) -> bytes:
    return Argon2id(salt=salt, length=32, iterations=t, lanes=p, memory_cost=m).derive(password.encode())


def check_policy(password: object, email: str | None = None) -> str:
    if not isinstance(password, str) or not MIN_LENGTH <= len(password) <= MAX_LENGTH:
        raise http_error(400, f'A password has {MIN_LENGTH} to {MAX_LENGTH} characters')
    if email and password.strip().lower() == email.strip().lower():
        raise http_error(400, 'A password can’t be your email address')
    return password


def _hash_sync(password: str) -> str:
    salt = os.urandom(16)
    return f'$argon2id$v=19$m={MEMORY_KIB},t={ITERATIONS},p={LANES}${_b64(salt)}${_b64(_derive(password, salt, MEMORY_KIB, ITERATIONS, LANES))}'


def _verify_sync(password: str, stored: str | None) -> bool:
    m = _PHC.match(stored or '')
    if not m:
        return False
    mem, t, p, salt, digest = int(m[1]), int(m[2]), int(m[3]), _unb64(m[4]), _unb64(m[5])
    return hmac.compare_digest(_derive(password, salt, mem, t, p), digest)


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(_hash_sync, password)


# Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
_DUMMY = _hash_sync(os.urandom(16).hex())


async def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        await asyncio.to_thread(_verify_sync, password, _DUMMY)
        return False
    return await asyncio.to_thread(_verify_sync, password, stored)
