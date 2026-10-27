# Runtime configuration from the environment. `.env` in the working directory (or the repository
# root) is loaded if present. An empty value counts as unset, so a copied .env.example with blank
# lines keeps every default and fallback.

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_env_file() -> None:
    for f in ('.env', '../../.env'):
        p = Path.cwd() / f
        if not p.is_file():
            continue
        try:
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k, v = k.strip().removeprefix('export ').strip(), v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                    v = v[1:-1]
                os.environ.setdefault(k, v)
        except OSError:
            pass  # an unreadable .env is ignored; the real environment still applies
        return


_load_env_file()


def env(k: str) -> str | None:
    v = os.environ.get(k)
    return v if v else None


def _num(k: str, d: float) -> float:
    v = env(k)
    try:
        return float(v) if v is not None else d
    except ValueError:
        return d


def _int(k: str, d: int) -> int:
    return int(_num(k, d))


def _bool(k: str, d: bool) -> bool:
    v = env(k)
    return d if v is None else v.lower() in ('1', 'true', 'yes', 'on')


def _list(k: str) -> list[str]:
    return [s.strip() for s in (env(k) or '').split(',') if s.strip()]


@dataclass
class LlmConfig:
    mode: str = field(default_factory=lambda: env('LLM_JUDGE') or 'auto')  # auto | off
    model: str = field(default_factory=lambda: env('CLAUDE_MODEL') or 'claude-opus-5-5')
    effort: str = field(default_factory=lambda: env('CLAUDE_EFFORT') or 'medium')
    recommendation_effort: str = field(default_factory=lambda: env('CLAUDE_RECOMMENDATION_EFFORT') or 'high')
    # Server-side refusal fallbacks; set CLAUDE_FALLBACKS=off to disable.
    fallbacks: bool = field(default_factory=lambda: _bool('CLAUDE_FALLBACKS', True))
    max_concurrent: int = field(default_factory=lambda: _int('CLAUDE_MAX_CONCURRENT', 4))


@dataclass
class Config:
    port: int = field(default_factory=lambda: _int('PORT', 8787))
    host: str = field(default_factory=lambda: env('HOST') or '0.0.0.0')
    # Proxies whose X-Forwarded-For is believed (the client address in sign-in limits and the audit log).
    forwarded_allow_ips: str = field(default_factory=lambda: env('FORWARDED_ALLOW_IPS') or '127.0.0.1')
    public_url: str | None = field(default_factory=lambda: env('PUBLIC_URL'))
    database_url: str | None = field(default_factory=lambda: env('DATABASE_URL'))
    # Embedded PostgreSQL data directory when DATABASE_URL is unset (not a PGlite directory).
    pg_dir: str = field(default_factory=lambda: env('PG_DIR') or './data/pg')
    upload_dir: str = field(default_factory=lambda: env('UPLOAD_DIR') or './data/uploads')
    api_token: str | None = field(default_factory=lambda: env('API_TOKEN'))
    app_secret: str | None = field(default_factory=lambda: env('APP_SECRET'))
    run_worker: bool = field(default_factory=lambda: _bool('RUN_WORKER', True))
    worker_concurrency: int = field(default_factory=lambda: _int('WORKER_CONCURRENCY', 2))
    web_dist: str | None = field(default_factory=lambda: env('WEB_DIST'))
    demo_mode: str = field(default_factory=lambda: env('DEMO_MODE') or 'on')  # on | off
    llm: LlmConfig = field(default_factory=LlmConfig)
    audio_model_url: str | None = field(default_factory=lambda: env('AUDIO_MODEL_URL'))
    # Integrations bootstrapped from the environment on start (in addition to ones created in the console).
    bootstrap: dict = field(default_factory=lambda: {
        'elevenlabs': {'apiKey': env('ELEVENLABS_API_KEY'), 'webhookSecret': env('ELEVENLABS_WEBHOOK_SECRET'), 'agentIds': _list('ELEVENLABS_AGENT_IDS'), 'baseUrl': env('ELEVENLABS_BASE_URL')} if env('ELEVENLABS_API_KEY') else None,
        'retell': {'apiKey': env('RETELL_API_KEY'), 'agentIds': _list('RETELL_AGENT_IDS'), 'baseUrl': env('RETELL_BASE_URL')} if env('RETELL_API_KEY') else None,
        'treppan': {'baseUrl': env('TREPPAN_API_URL'), 'apiKey': env('TREPPAN_API_KEY') or ''} if env('TREPPAN_API_URL') else None,
    })
    stt_api_key: str | None = field(default_factory=lambda: env('ELEVENLABS_STT_API_KEY') or env('ELEVENLABS_API_KEY'))
    stt_model: str = field(default_factory=lambda: env('ELEVENLABS_STT_MODEL') or 'scribe_v2')
    log_level: str = field(default_factory=lambda: env('LOG_LEVEL') or 'info')
    # Self-serve: anyone may sign up and gets a workspace of their own (several companies in one installation).
    self_signup: bool = field(default_factory=lambda: _bool('SELF_SIGNUP', False))
    trial_days: int = field(default_factory=lambda: _int('TRIAL_DAYS', 14))
    # Plans, credit and usage limits; off = no limits (a self-hosted installation for one company).
    billing: bool = field(default_factory=lambda: _bool('BILLING', False))
    stripe_secret_key: str | None = field(default_factory=lambda: env('STRIPE_SECRET_KEY'))
    stripe_webhook_secret: str | None = field(default_factory=lambda: env('STRIPE_WEBHOOK_SECRET'))
    # Transactional email (verification, invitations, password resets, receipts): smtp[s]://user:pass@host:port
    smtp_url: str | None = field(default_factory=lambda: env('SMTP_URL'))
    email_from: str = field(default_factory=lambda: env('EMAIL_FROM') or 'Call Evaluation <no-reply@localhost>')
    site_dist: str | None = field(default_factory=lambda: env('SITE_DIST'))


config = Config()


def reload_config() -> Config:
    """Re-read the environment into the shared config object (tests change variables between cases)."""
    fresh = Config()
    for k, v in vars(fresh).items():
        setattr(config, k, v)
    return config


def llm_enabled() -> bool:
    if config.llm.mode == 'off':
        return False
    return bool(env('ANTHROPIC_API_KEY') or env('ANTHROPIC_AUTH_TOKEN'))
