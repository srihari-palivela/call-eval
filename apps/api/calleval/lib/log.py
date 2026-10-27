# Structured logs: one JSON object per line, warnings and errors on stderr.

from __future__ import annotations

import sys
from typing import Any

from ..config import config
from ..js import js_json, now_iso

_LEVELS = {'debug': 10, 'info': 20, 'warn': 30, 'error': 40}


def _emit(level: str, msg: str, extra: dict[str, Any] | None = None) -> None:
    if _LEVELS[level] < _LEVELS.get(config.log_level, 20):
        return
    line = js_json({'t': now_iso(), 'level': level, 'msg': msg, **(extra or {})})
    (sys.stderr if level in ('warn', 'error') else sys.stdout).write(line + '\n')


class _Log:
    def debug(self, m: str, e: dict[str, Any] | None = None) -> None: _emit('debug', m, e)
    def info(self, m: str, e: dict[str, Any] | None = None) -> None: _emit('info', m, e)
    def warn(self, m: str, e: dict[str, Any] | None = None) -> None: _emit('warn', m, e)
    def error(self, m: str, e: dict[str, Any] | None = None) -> None: _emit('error', m, e)


log = _Log()


def err_msg(e: BaseException | Any) -> str:
    if isinstance(e, BaseException):
        return str(e) or type(e).__name__
    return str(e)
