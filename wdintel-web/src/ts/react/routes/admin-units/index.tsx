import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { AdminUnitDuplicatesPage } from '../admin-unit-duplicates';
import { AdminUnitInconsistentPage } from '../admin-unit-inconsistent';
import { AdminUnitUnparsedPage } from '../admin-unit-unparsed';
import { UnlinkedUnitsTab } from './UnlinkedUnitsTab';

type AdminUnitsTab = 'unlinked' | 'duplicates' | 'inconsistent' | 'unparsed';

type AdminUnitsPageProps = {
  authUserRoles: string[];
  initialTab?: AdminUnitsTab;
};

const TAB_PATHS: Record<AdminUnitsTab, string> = {
  unlinked: '/admin/units?tab=unlinked',
  duplicates: '/admin/units?tab=duplicates',
  inconsistent: '/admin/units?tab=inconsistent',
  unparsed: '/admin/units?tab=unparsed',
};

function canonicalTabPath(tab: AdminUnitsTab): string {
  return TAB_PATHS[tab];
}

export function readAdminUnitsTab(search = window.location.search): AdminUnitsTab {
  const tab = new URLSearchParams(search).get('tab');
  return tab === 'duplicates' || tab === 'inconsistent' || tab === 'unparsed' ? tab : 'unlinked';
}

export function AdminUnitsPage({ authUserRoles, initialTab }: AdminUnitsPageProps) {
  const [tab, setTab] = useState<AdminUnitsTab>(() => initialTab ?? readAdminUnitsTab());

  useEffect(() => {
    if (initialTab && window.location.pathname !== '/admin/units') {
      window.history.replaceState(null, '', canonicalTabPath(initialTab));
    } else if (window.location.pathname === '/admin/units') {
      const rawTab = new URLSearchParams(window.location.search).get('tab');
      if (
        rawTab !== null &&
        rawTab !== 'unlinked' &&
        rawTab !== 'duplicates' &&
        rawTab !== 'inconsistent' &&
        rawTab !== 'unparsed'
      ) {
        window.history.replaceState(null, '', canonicalTabPath('unlinked'));
      }
    }
    const onPopState = () => setTab(readAdminUnitsTab());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [initialTab]);

  function selectTab(value: AdminUnitsTab) {
    setTab(value);
    window.history.pushState(null, '', TAB_PATHS[value]);
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
            <Tab value="unlinked" label="Відсутні в Orbit" />
            <Tab value="duplicates" label="Дублікати підрозділів" />
            <Tab value="inconsistent" label="Неконсистентні підрозділи" />
            <Tab value="unparsed" label="Нерозпізнані підрозділи" />
          </Tabs>
        }
        titleActionsGap={2}
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {tab === 'unlinked' ? <UnlinkedUnitsTab authUserRoles={authUserRoles} /> : null}
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
