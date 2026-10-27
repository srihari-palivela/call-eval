import { createContext, useContext, useMemo, useState, ReactNode, useCallback, useEffect } from 'react';
import type { AlertsDTO, Filters, MetaDTO } from '@calleval/framework';
import { apiGet, apiSend, errMsg, usePoll } from './api';

export type PageKey =
  | 'attention' | 'recommendations' | 'fix' | 'matrix' | 'calls' | 'version' | 'traces'
  | 'funnel' | 'review' | 'taxonomy' | 'alerts' | 'scoring' | 'integrations' | 'audio'
  | 'business' | 'leads' | 'funnels' | 'campaigns' | 'improvement' | 'access' | 'billing' | 'compliance';
export const PAGE_KEYS: PageKey[] = ['attention', 'recommendations', 'fix', 'matrix', 'calls', 'version', 'traces', 'funnel', 'review', 'taxonomy', 'alerts', 'scoring', 'integrations', 'audio', 'business', 'leads', 'funnels', 'campaigns', 'improvement', 'access', 'billing', 'compliance'];

type QueueEntry = { owner?: string; status?: string };

type Store = {
  page: PageKey;
  go: (p: PageKey, params?: Record<string, string>) => void;
  params: Record<string, string>;
  filters: Filters;
  setFilter: <K extends keyof Filters>(k: K, v: Filters[K]) => void;
  meta: MetaDTO | null;
  metaError: string | null;
  reloadMeta: () => void;
  openAlerts: number;
  refreshAlerts: () => void;
  queue: { owners: Record<string, string>; statuses: Record<string, string> };
  setOwner: (k: string, v: string) => void;
  setStatus: (k: string, v: string) => void;
  openAttention: number;
  setOpenAttention: (n: number) => void;
};

const Ctx = createContext<Store | null>(null);

function parseHash(): { page: PageKey; params: Record<string, string> } {
  try {
    const raw = window.location.hash.replace('#', '');
    const [p, q] = raw.split('?');
    if ((PAGE_KEYS as string[]).includes(p)) {
      const params: Record<string, string> = {};
      new URLSearchParams(q ?? '').forEach((v, k) => { params[k] = v; });
      return { page: p as PageKey, params };
    }
  } catch { /* hash unavailable */ }
  return { page: 'attention', params: {} };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(parseHash, []);
  const [page, setPage] = useState<PageKey>(initial.page);
  const [params, setParams] = useState<Record<string, string>>(initial.params);
  const [filters, setFilters] = useState<Filters>({ range: '30', dir: 'all', path: 'all', ver: 'live', agent: 'all' });
  const [meta, setMeta] = useState<MetaDTO | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaTick, setMetaTick] = useState(0);
  const [openAlerts, setOpenAlerts] = useState(0);
  const [queue, setQueue] = useState<{ owners: Record<string, string>; statuses: Record<string, string> }>({ owners: {}, statuses: {} });
  const [openAttention, setOpenAttention] = useState(0);

  const go = useCallback((p: PageKey, prm: Record<string, string> = {}) => {
    setPage(p); setParams(prm);
    const q = new URLSearchParams(prm).toString();
    try { window.history.replaceState(null, '', '#' + p + (q ? `?${q}` : '')); } catch { /* sandboxed */ }
    try { window.scrollTo({ top: 0 }); } catch { /* noop */ }
  }, []);

  useEffect(() => {
    const onHash = () => { const h = parseHash(); setPage(h.page); setParams(h.params); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    apiGet<MetaDTO>('/api/meta')
      .then((m) => { if (alive) { setMeta(m); setMetaError(null); } })
      .catch((e) => { if (alive) setMetaError(errMsg(e)); });
    return () => { alive = false; };
  }, [metaTick]);

  const refreshAlerts = useCallback(() => {
    apiGet<AlertsDTO>('/api/alerts?status=open').then((a) => setOpenAlerts(a.alerts.length)).catch(() => { /* badge only */ });
  }, []);
  useEffect(() => { if (meta) refreshAlerts(); }, [meta, refreshAlerts]);
  usePoll(refreshAlerts, 60_000, !!meta);

  useEffect(() => {
    if (!meta) return;
    apiGet<Record<string, QueueEntry>>('/api/attention-items').then((items) => {
      const owners: Record<string, string> = {}, statuses: Record<string, string> = {};
      Object.entries(items ?? {}).forEach(([k, v]) => { if (v?.owner) owners[k] = v.owner; if (v?.status) statuses[k] = v.status; });
      setQueue({ owners, statuses });
    }).catch(() => { /* queue starts empty */ });
  }, [meta]);

  const persist = useCallback((key: string, body: QueueEntry) => {
    apiSend('PUT', `/api/attention-items/${encodeURIComponent(key)}`, body).catch(() => { /* kept locally */ });
  }, []);

  const value = useMemo<Store>(() => ({
    page, go, params, filters,
    setFilter: (k, v) => setFilters((f) => ({ ...f, [k]: v })),
    meta, metaError, reloadMeta: () => setMetaTick((t) => t + 1),
    openAlerts, refreshAlerts,
    queue,
    setOwner: (k, v) => { setQueue((q) => ({ ...q, owners: { ...q.owners, [k]: v } })); persist(k, { owner: v }); },
    setStatus: (k, v) => { setQueue((q) => ({ ...q, statuses: { ...q.statuses, [k]: v } })); persist(k, { status: v }); },
    openAttention, setOpenAttention,
  }), [page, go, params, filters, meta, metaError, openAlerts, refreshAlerts, queue, openAttention, persist]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}

/** Meta is loaded before any page renders, so pages can rely on it. */
export function useMeta(): MetaDTO {
  const { meta } = useStore();
  if (!meta) throw new Error('Meta not loaded');
  return meta;
}
