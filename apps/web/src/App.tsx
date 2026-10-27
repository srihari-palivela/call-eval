import { Button, Card, Group, Stack, Text } from '@mantine/core';
import { Shell } from './components/Shell';
import { ErrorState, Loading } from './components/ui';
import { PAGE_PERMISSION, PERMISSION_LABEL, ROLE_LABEL, useCan } from './components/access';
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
import { BusinessPage } from './pages/Business';
import { LeadsPage } from './pages/Leads';
import { FunnelsPage } from './pages/Funnels';
import { CampaignsPage } from './pages/Campaigns';
import { ImprovementPage } from './pages/Improvement';
import { AccessPage } from './pages/Access';
import { BillingPage } from './pages/Billing';
import { CompliancePage } from './pages/Compliance';

const PAGES: Record<PageKey, () => JSX.Element> = {
  attention: AttentionPage, recommendations: RecommendationsPage, fix: FixPage, matrix: MatrixPage, calls: CallsPage,
  version: VersionPage, traces: TracesPage, funnel: FunnelPage, review: ReviewPage, taxonomy: TaxonomyPage,
  alerts: AlertsPage, scoring: ScoringPage, integrations: IntegrationsPage, audio: AudioPage,
  business: BusinessPage, leads: LeadsPage, funnels: FunnelsPage, campaigns: CampaignsPage, improvement: ImprovementPage, access: AccessPage,
  billing: BillingPage, compliance: CompliancePage,
};

export function App() {
  const { page, meta, metaError, reloadMeta, go } = useStore();
  const can = useCan();
  const Page = PAGES[page] ?? AttentionPage;
  let body: JSX.Element;
  if (meta && !can(PAGE_PERMISSION[page])) body = <NotAllowed role={ROLE_LABEL[meta.me.role] ?? meta.me.role} needs={PERMISSION_LABEL[PAGE_PERMISSION[page]]} onHome={() => go('attention')} />;
  else if (meta) body = <Page key={page} />;
  else if (metaError) body = <ErrorState error={`The Call Evaluation API isn’t reachable (${metaError}). Start it with npm run dev:api, or check the API token.`} onRetry={reloadMeta} />;
  else body = <Loading label="Connecting to the Call Evaluation API…" />;
  return <Shell>{body}</Shell>;
}

function NotAllowed({ role, needs, onHome }: { role: string; needs: string; onHome: () => void }) {
  return (
    <Card maw={560} mx="auto" mt="xl">
      <Stack gap="sm">
        <Text fw={650}>Your role can’t open this page</Text>
        <Text size="sm" c="dimmed">It needs “{needs}”, which the {role} role doesn’t include. Ask an admin if you need it.</Text>
        <Group><Button variant="default" onClick={onHome}>Go to Needs attention</Button></Group>
      </Stack>
    </Card>
  );
}
