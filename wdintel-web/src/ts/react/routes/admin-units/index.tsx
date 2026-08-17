import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { AdminUnitDuplicatesPage } from '../admin-unit-duplicates';
import { AdminUnitInconsistentPage } from '../admin-unit-inconsistent';
import { AdminUnitUnparsedPage } from '../admin-unit-unparsed';

type AdminUnitsTab = 'duplicates' | 'inconsistent' | 'unparsed';

type AdminUnitsPageProps = {
  authUserRoles: string[];
  initialTab: AdminUnitsTab;
};

const TAB_PATHS: Record<AdminUnitsTab, string> = {
  duplicates: '/admin/unit-duplicates',
  inconsistent: '/admin/unit-inconsistent',
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
      <PageHeader
        title="Підрозділи"
        titleActions={
          <Tabs
            value={tab}
            onChange={(_, value) => selectTab(value as AdminUnitsTab)}
            aria-label="Розділи адміністрування підрозділів"
          >
            <Tab value="duplicates" label="Дублікати Підрозділів" />
            <Tab value="inconsistent" label="Неконсистентні підрозділи" />
            <Tab value="unparsed" label="Нерозпізнані підрозділи" />
          </Tabs>
        }
        titleActionsGap={2}
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === 'duplicates' ? (
          <AdminUnitDuplicatesPage authUserRoles={authUserRoles} embedded />
        ) : null}
        {tab === 'inconsistent' ? <AdminUnitInconsistentPage embedded /> : null}
        {tab === 'unparsed' ? (
          <AdminUnitUnparsedPage authUserRoles={authUserRoles} embedded />
        ) : null}
      </Box>
    </Stack>
  );
}
