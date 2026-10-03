import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useState } from 'react';

import { FeedbackTab } from './FeedbackTab';
import { KnowledgeTab } from './KnowledgeTab';
export { AdminAiPositionPage } from './PositionPage';
import { MentionsTab } from './MentionsTab';
import { SettingsTab } from './SettingsTab';

/** AI-extracted positions: review mentions and coordinates, tune the worker. */
export function AdminAiPositionsPage() {
  const [tab, setTab] = useState<'mentions' | 'knowledge' | 'feedback' | 'settings'>('mentions');
  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <Tabs value={tab} onChange={(_event, value) => setTab(value)}>
        <Tab value="mentions" label="Згадки" />
        <Tab value="knowledge" label="Відомі позиції" />
        <Tab value="feedback" label="Відгуки" />
        <Tab value="settings" label="Налаштування" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === 'mentions' ? <MentionsTab /> : null}
        {tab === 'knowledge' ? <KnowledgeTab /> : null}
        {tab === 'feedback' ? <FeedbackTab /> : null}
        {tab === 'settings' ? <SettingsTab /> : null}
      </Box>
    </Stack>
  );
}
