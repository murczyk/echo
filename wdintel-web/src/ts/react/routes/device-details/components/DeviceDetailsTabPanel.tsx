import { Box, Paper, Stack, Tab, Tabs } from '@mui/material';
import type { ReactNode } from 'react';

import type { DeviceDetails } from '../../../../../Bindings';
import { DeviceCustomFieldsSection, DeviceRegistrySection } from './DeviceInfoSections';

export type DeviceDetailsTab = 'description' | 'files';

type Props = {
  device: DeviceDetails;
  activeTab: DeviceDetailsTab;
  onActiveTabChange: (tab: DeviceDetailsTab) => void;
  onOpenExternalUrl: (url: string) => void;
  filesPanel: ReactNode;
};

export function DeviceDetailsTabPanel({
  device,
  activeTab,
  onActiveTabChange,
  onOpenExternalUrl,
  filesPanel,
}: Props) {
  return (
    <Paper
      variant="outlined"
      data-testid="device-details-tab-panel"
      sx={{
        minHeight: 0,
        height: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          px: 2,
          pt: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Tabs
          value={activeTab}
          onChange={(_, nextTab: DeviceDetailsTab) => onActiveTabChange(nextTab)}
          variant="standard"
          aria-label="Вкладки пристрою"
          sx={{
            minHeight: 42,
            '& .MuiTabs-indicator': {
              height: 2,
            },
          }}
        >
          <Tab value="description" label="Опис" />
          <Tab value="files" label="Файли" />
        </Tabs>
      </Box>

      <Box sx={{ minHeight: 0, flex: 1, overflow: 'hidden' }}>
        {activeTab === 'description' ? (
          <Box
            sx={{
              p: 2,
              minHeight: 0,
              height: '100%',
              overflowY: 'auto',
              overflowX: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            <Stack spacing={2} sx={{ minWidth: 0 }}>
              <DeviceRegistrySection device={device} onOpenExternalUrl={onOpenExternalUrl} />
              <DeviceCustomFieldsSection device={device} />
            </Stack>
          </Box>
        ) : (
          <Box
            sx={{
              p: 2,
              minHeight: 0,
              height: '100%',
              overflowY: 'auto',
              overflowX: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            {filesPanel}
          </Box>
        )}
      </Box>
    </Paper>
  );
}
