import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useState } from 'react';

import { KnowledgeTab } from './KnowledgeTab';
import { MentionsTab } from './MentionsTab';
import { SettingsTab } from './SettingsTab';

/** AI-extracted positions: review mentions and coordinates, tune the worker. */
export function AdminAiPositionsPage() {
  const [tab, setTab] = useState<'mentions' | 'knowledge' | 'settings'>('mentions');
  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <Tabs value={tab} onChange={(_event, value) => setTab(value)}>
        <Tab value="mentions" label="Згадки" />
        <Tab value="knowledge" label="Відомі позиції" />
        <Tab value="settings" label="Налаштування" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === 'mentions' ? <MentionsTab /> : null}
        {tab === 'knowledge' ? <KnowledgeTab /> : null}
        {tab === 'settings' ? <SettingsTab /> : null}
      </Box>
    </Stack>
  );
}
