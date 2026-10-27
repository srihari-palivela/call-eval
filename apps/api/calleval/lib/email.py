# Transactional email (verification, password resets, invitations) over SMTP. SMTP_URL is
# smtp://user:password@host:587 (STARTTLS) or smtps://user:password@host:465 (TLS); without it nothing is
# sent and the caller shows the link another way (a development link on sign-up, a copyable link elsewhere).

from __future__ import annotations

import asyncio
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import unquote, urlparse

from ..config import config
from .log import err_msg, log


def configured() -> bool:
    return bool(config.smtp_url)


def _send_sync(to: str, subject: str, text: str) -> None:
    u = urlparse(config.smtp_url or '')
    msg = EmailMessage()
    msg['From'] = config.email_from
    msg['To'] = to
    msg['Subject'] = subject
    msg.set_content(text)
    ctx = ssl.create_default_context()
    if u.scheme == 'smtps':
        server: smtplib.SMTP = smtplib.SMTP_SSL(u.hostname or '', u.port or 465, context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(u.hostname or '', u.port or 587, timeout=20)
        server.starttls(context=ctx)
    with server:
        if u.username:
            server.login(unquote(u.username), unquote(u.password or ''))
        server.send_message(msg)


async def send(to: str, subject: str, text: str) -> bool:
    """True when handed to the mail server; False when email isn't configured or sending failed (logged)."""
    if not configured():
        log.warn('email not sent: SMTP_URL is not set', {'to': to, 'subject': subject})
        return False
    try:
        await asyncio.to_thread(_send_sync, to, subject, text)
        return True
    except Exception as e:  # noqa: BLE001 - the caller decides what a failed send means
        log.error('email failed', {'to': to, 'subject': subject, 'error': err_msg(e)})
        return False
