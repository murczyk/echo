import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { AdminUnitDuplicatesPage } from '../admin-unit-duplicates';
import { AdminUnitUnparsedPage } from '../admin-unit-unparsed';

type AdminUnitsTab = 'duplicates' | 'unparsed';

type AdminUnitsPageProps = {
  authUserRoles: string[];
  initialTab: AdminUnitsTab;
};

const TAB_PATHS: Record<AdminUnitsTab, string> = {
  duplicates: '/admin/unit-duplicates',
  unparsed: '/admin/unit-unparsed',
};

export function AdminUnitsPage({ authUserRoles, initialTab }: AdminUnitsPageProps) {
  const [tab, setTab] = useState<AdminUnitsTab>(initialTab);

  useEffect(() => setTab(initialTab), [initialTab]);

  function selectTab(value: AdminUnitsTab) {
    setTab(value);
    if (window.location.pathname !== TAB_PATHS[value]) {
      window.history.replaceState(null, '', TAB_PATHS[value]);
    }
  }

  return (
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: 2 }}>
      <Tabs
        value={tab}
        onChange={(_, value) => selectTab(value as AdminUnitsTab)}
        aria-label="Розділи адміністрування підрозділів"
      >
        <Tab value="duplicates" label="Дублікати Підрозділів" />
        <Tab value="unparsed" label="Нерозпізнані підрозділи" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === 'duplicates' ? (
          <AdminUnitDuplicatesPage authUserRoles={authUserRoles} embedded />
        ) : (
          <AdminUnitUnparsedPage authUserRoles={authUserRoles} embedded />
        )}
      </Box>
    </Stack>
  );
}
