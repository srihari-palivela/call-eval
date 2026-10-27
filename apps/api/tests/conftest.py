# Tests never call Claude or a real provider: the heuristic judge runs and provider HTTP is stubbed.
# Each test module gets its own throwaway database on an embedded PostgreSQL.

import os

os.environ.update({
    'LLM_JUDGE': 'off', 'DEMO_MODE': 'on', 'API_TOKEN': '', 'DATABASE_URL': '', 'PUBLIC_URL': 'https://evals.example.com',
    'APP_SECRET': 'test-secret-for-pytest', 'LOG_LEVEL': 'error', 'AUDIO_MODEL_URL': '',
})

from calleval.config import reload_config  # noqa: E402

reload_config()

import pytest  # noqa: E402

from calleval.auth.store import forget_users_cache  # noqa: E402
from calleval.db import open_db, set_db  # noqa: E402
from calleval.lib.settings import clear_settings_cache  # noqa: E402


@pytest.fixture(scope='module')
async def db():
    d = await open_db(url=None, dir='memory')
    set_db(d)
    clear_settings_cache()
    forget_users_cache()  # each module's database starts with no users (open, as before accounts)
    yield d
    set_db(None)
    clear_settings_cache()
    forget_users_cache()
    await d.close()
