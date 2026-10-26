// fetch with timeouts and retries on 429/5xx and network errors, honouring Retry-After.

import { log } from './log';

export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchRetry(url: string, init: RequestInit & { timeoutMs?: number; retries?: number } = {}): Promise<Response> {
  const retries = init.retries ?? 4;
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
        log.warn('retrying request', { url: new URL(url).pathname, status: res.status, wait });
        await res.body?.cancel().catch(() => {});
        await sleep(Math.min(wait, 30_000));
        attempt++;
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), url);
      return res;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (attempt >= retries) throw e;
      await sleep(500 * 2 ** attempt);
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function getJson<T>(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await fetchRetry(url, { ...init, headers: { accept: 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) } });
  return (await res.json()) as T;
}
