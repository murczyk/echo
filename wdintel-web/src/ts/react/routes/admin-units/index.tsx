import { Box, Stack, Tab, Tabs } from '@mui/material';
import { useEffect, useState } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { AdminUnitDuplicatesPage } from '../admin-unit-duplicates';
import { AdminUnitInconsistentPage } from '../admin-unit-inconsistent';
import { AdminUnitNamesPage } from '../admin-unit-names';
import { AdminUnitUnparsedPage } from '../admin-unit-unparsed';

type AdminUnitsTab = 'duplicates' | 'inconsistent' | 'names' | 'unparsed';

type AdminUnitsPageProps = {
  authUserRoles: string[];
  initialTab?: AdminUnitsTab;
};

const TAB_PATHS: Record<AdminUnitsTab, string> = {
  duplicates: '/admin/units?tab=duplicates',
  inconsistent: '/admin/units?tab=inconsistent',
  names: '/admin/units?tab=names',
  unparsed: '/admin/units?tab=unparsed',
};

function canonicalTabPath(tab: AdminUnitsTab): string {
  return TAB_PATHS[tab];
}

export function readAdminUnitsTab(search = window.location.search): AdminUnitsTab {
  const tab = new URLSearchParams(search).get('tab');
  return tab === 'inconsistent' || tab === 'names' || tab === 'unparsed' ? tab : 'duplicates';
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
        rawTab !== 'duplicates' &&
        rawTab !== 'inconsistent' &&
        rawTab !== 'names' &&
        rawTab !== 'unparsed'
      ) {
        window.history.replaceState(null, '', canonicalTabPath('duplicates'));
      } else if (rawTab !== null && window.location.search !== `?tab=${rawTab}`) {
        window.history.replaceState(null, '', canonicalTabPath(readAdminUnitsTab()));
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
            <Tab value="duplicates" label="Дублікати підрозділів" />
            <Tab value="inconsistent" label="Неконсистентні підрозділи" />
            <Tab value="names" label="Назви підрозділів" />
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
        {tab === 'names' ? <AdminUnitNamesPage authUserRoles={authUserRoles} embedded /> : null}
        {tab === 'unparsed' ? (
          <AdminUnitUnparsedPage authUserRoles={authUserRoles} embedded />
        ) : null}
      </Box>
    </Stack>
  );
}
