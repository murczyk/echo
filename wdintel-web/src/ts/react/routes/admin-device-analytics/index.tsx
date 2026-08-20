import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useState } from 'react';

import { DeviceGeneralSettingsPanel } from './DeviceGeneralSettingsPanel';
import { DeviceTagsSettingsPanel } from './DeviceTagsSettingsPanel';

type DeviceAnalysisSettingsTab = 'general' | 'tags';

export function AdminDeviceAnalyticsPage() {
  const [activeTab, setActiveTab] = useState<DeviceAnalysisSettingsTab>('general');

  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          Аналіз пристроїв
        </Typography>

        <Box>
          <Tabs
            value={activeTab}
            onChange={(_, value: DeviceAnalysisSettingsTab) => setActiveTab(value)}
            variant="scrollable"
            allowScrollButtonsMobile
            aria-label="Розділи налаштувань аналізу пристроїв"
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab
              value="general"
              label="Основні налаштування"
              id="device-analysis-settings-tab-general"
              aria-controls="device-analysis-settings-panel-general"
            />
            <Tab
              value="tags"
              label="Теги пристроїв"
              id="device-analysis-settings-tab-tags"
              aria-controls="device-analysis-settings-panel-tags"
            />
          </Tabs>

          <Box
            id="device-analysis-settings-panel-general"
            role="tabpanel"
            aria-labelledby="device-analysis-settings-tab-general"
            hidden={activeTab !== 'general'}
            sx={{ pt: 3 }}
          >
            {activeTab === 'general' ? <DeviceGeneralSettingsPanel /> : null}
          </Box>
          <Box
            id="device-analysis-settings-panel-tags"
            role="tabpanel"
            aria-labelledby="device-analysis-settings-tab-tags"
            hidden={activeTab !== 'tags'}
            sx={{ pt: 3 }}
          >
            {activeTab === 'tags' ? <DeviceTagsSettingsPanel /> : null}
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}
