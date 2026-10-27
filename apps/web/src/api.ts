// Typed fetch helpers for the Call Evaluation API, plus a small data hook with loading and error state.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Filters } from '@calleval/framework';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function token(): string | null {
  try { return window.localStorage.getItem('calleval.token'); } catch { return null; }
}

// The API refuses cookie-authenticated changes without this header (a cross-site page can't set it).
function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'X-CallEval-Client': 'console' };
  if (json) h['Content-Type'] = 'application/json';
  const t = token();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** Fired when a request comes back 401 outside the sign-in routes: the session ended, so the auth gate shows sign-in. */
export const UNAUTHORIZED_EVENT = 'calleval:unauthorized';
/** Fired when a request comes back 402: the plan or the credit doesn't allow it, so the shell points to Billing. */
export const PAYMENT_REQUIRED_EVENT = 'calleval:payment-required';

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body?.message || body?.error || msg;
    } catch { /* not JSON */ }
    if (res.status === 401 && !new URL(res.url, window.location.href).pathname.startsWith('/api/auth/')) {
      try { window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)); } catch { /* no window */ }
    }
    if (res.status === 402) {
      try { window.dispatchEvent(new CustomEvent(PAYMENT_REQUIRED_EVENT, { detail: msg })); } catch { /* no window */ }
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { headers: headers(false) }));
}

export async function apiSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return handle<T>(await fetch(path, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) }));
}

export async function apiSendText<T>(path: string, text: string, contentType = 'text/csv'): Promise<T> {
  const h = headers(false);
  h['Content-Type'] = contentType;
  return handle<T>(await fetch(path, { method: 'POST', headers: h, body: text }));
}

export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return handle<T>(await fetch(path, { method: 'POST', headers: headers(false), body: form }));
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** The common filters every analytics endpoint takes. */
export function filterQs(f: Filters, extra: Record<string, string | number | boolean | null | undefined> = {}, keys: (keyof Filters)[] = ['range', 'dir', 'ver', 'agent']) {
  const base: Record<string, string> = {};
  keys.forEach((k) => { base[k] = f[k]; });
  return qs({ ...base, ...extra });
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ApiState<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (d: T | null) => void };

/** Fetch `path` whenever it changes (null skips). Keeps the last data while a new request is in flight. */
export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) { setData(null); setError(null); setLoading(false); lastPath.current = null; return; }
    let alive = true;
    setLoading(true);
    setError(null);
    lastPath.current = path;
    apiGet<T>(path)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch((e) => { if (alive) { setError(errMsg(e)); setLoading(false); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Re-run `fn` every `ms` while `active` is true. */
export function usePoll(fn: () => void, ms: number, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}
