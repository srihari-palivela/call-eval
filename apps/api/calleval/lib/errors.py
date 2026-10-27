from __future__ import annotations


class HttpStatusError(Exception):
    """An error the API returns with its own status code (404 not found, 400 bad input, …)."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def http_error(status_code: int, message: str) -> HttpStatusError:
    return HttpStatusError(status_code, message)
