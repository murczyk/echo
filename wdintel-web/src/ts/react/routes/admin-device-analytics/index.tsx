import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import { DeviceGeneralSettingsPanel } from './DeviceGeneralSettingsPanel';
import { DeviceTagsSettingsPanel } from './DeviceTagsSettingsPanel';

type DeviceAnalysisSettingsTab = 'general' | 'tags';

function readTab(): DeviceAnalysisSettingsTab {
  return new URLSearchParams(window.location.search).get('tab') === 'tags' ? 'tags' : 'general';
}

function writeTab(tab: DeviceAnalysisSettingsTab, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history[replace ? 'replaceState' : 'pushState'](
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function readCanonicalTab(): DeviceAnalysisSettingsTab {
  const tab = readTab();
  if (new URLSearchParams(window.location.search).get('tab') !== tab) writeTab(tab, true);
  return tab;
}

export function AdminDeviceAnalyticsPage() {
  const [activeTab, setActiveTab] = useState<DeviceAnalysisSettingsTab>(readTab);

  useEffect(() => {
    const syncTabFromUrl = () => setActiveTab(readCanonicalTab());
    syncTabFromUrl();
    window.addEventListener('popstate', syncTabFromUrl);
    return () => window.removeEventListener('popstate', syncTabFromUrl);
  }, []);

  const selectTab = (tab: DeviceAnalysisSettingsTab) => {
    if (tab === activeTab) return;
    writeTab(tab);
    setActiveTab(tab);
  };

  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      <Stack spacing={3}>
        <Typography variant="h4" component="h1">
          Аналіз пристроїв
        </Typography>

        <Box>
          <Tabs
            value={activeTab}
            onChange={(_, value: DeviceAnalysisSettingsTab) => selectTab(value)}
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
