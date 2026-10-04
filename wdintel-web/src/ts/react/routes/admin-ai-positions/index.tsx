import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { FeedbackTab } from './FeedbackTab';
import { KnowledgeTab } from './KnowledgeTab';
export { AdminAiPositionPage } from './PositionPage';
import { MentionsTab } from './MentionsTab';
import { SettingsTab } from './SettingsTab';

enum PositionsTab {
  Mentions = 'mentions',
  Knowledge = 'knowledge',
  Feedback = 'feedback',
  Settings = 'settings',
}

function readTab(rawTab = window.location.pathname.split('/').pop()): PositionsTab {
  return Object.values(PositionsTab).find((value) => value === rawTab) ?? PositionsTab.Mentions;
}

/** AI-extracted positions: review mentions and coordinates, tune the worker. */
export function AdminAiPositionsPage({ tab: rawTab }: { tab: string | null }) {
  const [tab, setTab] = useState(() => readTab(rawTab ?? undefined));

  useEffect(() => {
    const syncTabFromUrl = () => setTab(readTab());
    syncTabFromUrl();
    window.addEventListener('popstate', syncTabFromUrl);
    return () => window.removeEventListener('popstate', syncTabFromUrl);
  }, [rawTab]);

  function selectTab(nextTab: PositionsTab) {
    if (nextTab === tab) return;
    window.history.pushState(window.history.state, '', `/admin/ai/positions/${nextTab}`);
    setTab(nextTab);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <Tabs
        value={tab}
        onChange={(_, value: PositionsTab) => selectTab(value)}
        variant="scrollable"
        aria-label="Розділи позицій ШІ"
      >
        <Tab value={PositionsTab.Mentions} label="Згадки" />
        <Tab value={PositionsTab.Knowledge} label="Відомі позиції" />
        <Tab value={PositionsTab.Feedback} label="Відгуки" />
        <Tab value={PositionsTab.Settings} label="Налаштування" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === PositionsTab.Mentions ? <MentionsTab /> : null}
        {tab === PositionsTab.Knowledge ? <KnowledgeTab /> : null}
        {tab === PositionsTab.Feedback ? <FeedbackTab /> : null}
        {tab === PositionsTab.Settings ? <SettingsTab /> : null}
      </Box>
    </Stack>
  );
}
