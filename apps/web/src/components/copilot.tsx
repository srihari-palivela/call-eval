// Shared pieces of the co-pilot panels (business setup, taxonomy, funnels): the long-running state,
// the questions it asks back, and what the request cost.
import { Alert, Card, Group, List, Loader, Stack, Text } from '@mantine/core';
import { IconHelpCircle } from '@tabler/icons-react';
import type { CopilotUsage } from '@calleval/framework';

export function CopilotWorking({ label }: { label: string }) {
  return (
    <Card withBorder padding="md">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Loader size="sm" color="ink" mt={2} />
        <Stack gap={2}>
          <Text size="sm" fw={600}>{label}</Text>
          <Text size="xs" c="dimmed">This usually takes one to two minutes. Nothing changes until you apply what it proposes.</Text>
        </Stack>
      </Group>
    </Card>
  );
}

export function CopilotQuestions({ questions }: { questions: string[] }) {
  if (!questions.length) return null;
  return (
    <Alert color="gray" variant="light" radius="md" icon={<IconHelpCircle />} title="Questions to settle">
      <List size="sm" spacing={4}>{questions.map((q) => <List.Item key={q}>{q}</List.Item>)}</List>
    </Alert>
  );
}

export function CopilotUsageLine({ usage }: { usage: CopilotUsage }) {
  return <Text size="xs" c="dimmed">{usage.model} · {usage.inputTokens.toLocaleString('en-US')} input and {usage.outputTokens.toLocaleString('en-US')} output tokens</Text>;
}

export const NO_CLAUDE_KEY = 'The co-pilot needs a Claude key on the API (ANTHROPIC_API_KEY). Everything here can still be done by hand.';
