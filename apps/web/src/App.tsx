import { Shell } from './components/Shell';
import { ErrorState, Loading } from './components/ui';
import { PageKey, useStore } from './store';
import { AttentionPage } from './pages/Attention';
import { RecommendationsPage } from './pages/Recommendations';
import { MatrixPage } from './pages/Matrix';
import { CallsPage } from './pages/Calls';
import { VersionPage } from './pages/Version';
import { TracesPage } from './pages/Traces';
import { AudioPage } from './pages/Audio';
import { FunnelPage } from './pages/Funnel';
import { FixPage } from './pages/Fix';
import { ReviewPage } from './pages/Review';
import { TaxonomyPage } from './pages/Taxonomy';
import { AlertsPage } from './pages/Alerts';
import { ScoringPage } from './pages/Scoring';
import { IntegrationsPage } from './pages/Integrations';

const PAGES: Record<PageKey, () => JSX.Element> = {
  attention: AttentionPage, recommendations: RecommendationsPage, fix: FixPage, matrix: MatrixPage, calls: CallsPage,
  version: VersionPage, traces: TracesPage, funnel: FunnelPage, review: ReviewPage, taxonomy: TaxonomyPage,
  alerts: AlertsPage, scoring: ScoringPage, integrations: IntegrationsPage, audio: AudioPage,
};

export function App() {
  const { page, meta, metaError, reloadMeta } = useStore();
  const Page = PAGES[page] ?? AttentionPage;
  let body: JSX.Element;
  if (meta) body = <Page key={page} />;
  else if (metaError) body = <ErrorState error={`The Call Evaluation API isn’t reachable (${metaError}). Start it with npm run dev:api, or check the API token.`} onRetry={reloadMeta} />;
  else body = <Loading label="Connecting to the Call Evaluation API…" />;
  return <Shell>{body}</Shell>;
}
