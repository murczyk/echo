import { MenuItem, Tab, Tabs, TextField } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
import { AccountsTab } from './AccountsTab';
import { ActivityHistory, QualityHistory, ReportsHistory } from './HistoryTabs';
import { KpiPanel, MetricCard, SnapshotState } from './KpiSummary';
import { KpiTab, kpiTabs } from './tabs';
import { useKpiData } from './use-kpi-data';

const KPI_DAY_MS = 86_400_000;

function selectedTab() {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return Object.values(KpiTab).find((value) => value === tab) ?? KpiTab.Accounts;
}

export function AdminKpiPage() {
  const { accounts, reports } = useKpiData();
  const [tab, setTab] = useState(selectedTab);
  const [days, setDays] = useState(30);
  const [until, setUntil] = useState(Date.now);
  const period = useMemo(() => ({ since: until - days * KPI_DAY_MS, until }), [days, until]);

  useEffect(() => {
    const onPopState = () => setTab(selectedTab());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const changeTab = (tab: KpiTab) => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState(null, '', url);
    setTab(tab);
  };

  return (
    <main className="min-w-0 space-y-echo-xl text-echo-text">
      <PageHeader
        title="KPI"
        actions={
          <PowerButton
            variant="outlined"
            disabled={accounts.loading || reports.loading}
            onClick={() => {
              void accounts.reload();
              void reports.reload();
              setUntil(Date.now());
            }}
          >
            Оновити KPI
          </PowerButton>
        }
      />
      <Tabs
        value={tab}
        onChange={(_, value: KpiTab) => changeTab(value)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        aria-label="Розділи KPI"
      >
        {Object.values(KpiTab).map((value) => (
          <Tab
            key={value}
            value={value}
            label={kpiTabs[value]}
            id={`kpi-tab-${value}`}
            aria-controls={`kpi-panel-${value}`}
          />
        ))}
      </Tabs>
      {Object.values(KpiTab).map((value) => (
        <div
          key={value}
          hidden={value !== tab}
          role="tabpanel"
          id={`kpi-panel-${value}`}
          aria-labelledby={`kpi-tab-${value}`}
          className="min-w-0 space-y-echo-xl"
          tabIndex={0}
        >
          {value === KpiTab.Accounts && <AccountsTab accounts={accounts} />}
          {value === tab && (
            <>
              {(tab === KpiTab.Activity || tab === KpiTab.Speed || tab === KpiTab.Quality) && (
                <TextField
                  select
                  label="Період історії"
                  value={days}
                  onChange={(event) => {
                    setDays(Number(event.target.value));
                    setUntil(Date.now());
                  }}
                >
                  {[7, 30, 90].map((value) => (
                    <MenuItem key={value} value={value}>
                      Останні {value} днів
                    </MenuItem>
                  ))}
                </TextField>
              )}
              {tab === KpiTab.Activity && (
                <>
                  <ActivityHistory period={period} />
                  <ReportsHistory period={period} />
                  <KpiPanel title="Звіти: вся система">
                    <p>
                      Уся доступна історія системи. Фільтри облікових записів та періоду не
                      застосовуються.
                    </p>
                    <SnapshotState
                      snapshot={reports}
                      label="звіти"
                      retry={() => void reports.reload()}
                    />
                    {reports.data !== null && (
                      <MetricCard
                        title="Успішні звіти в доступній історії"
                        value={reports.data}
                        description="Кількість збережених записів зі статусом done; не завантаження файлів і не всі повторні спроби генерації. Дані аналітики можуть надходити із затримкою."
                      />
                    )}
                    <a href="/admin/all-reports">Переглянути всі звіти</a>
                  </KpiPanel>
                </>
              )}
              {tab === KpiTab.Speed && <ReportsHistory period={period} />}
              {tab === KpiTab.Quality && <QualityHistory period={period} />}
            </>
          )}
        </div>
      ))}
    </main>
  );
}
