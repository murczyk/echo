import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useState } from 'react';

import { GroupList, type GroupScope } from '../shared/group-navigation';
import { MessengerAccountList } from './components/MessengerAccountList';
import { MessengerSearchField } from './components/MessengerSearchField';
import { LeftPanelTab, type AnalysisPageViewModel } from './types';

type Props = {
  page: AnalysisPageViewModel;
  leftPanelVisible: boolean;
  fullHeight?: boolean;
};

export function AnalysisLeftPanel({ page, leftPanelVisible, fullHeight = false }: Props) {
  const tab = page.leftPanelTab;
  const [query, setQuery] = useState('');

  if (!leftPanelVisible) return null;

  const selectMessengerAccount = (id: string) => {
    page.selectMessengerAccount(id);
    if (fullHeight) page.toggleLeftPanel();
  };

  const selectGroup = (scope: GroupScope) => {
    page.groupNavigation.select(scope);
    if (fullHeight) page.toggleLeftPanel();
  };

  return (
    <aside
      aria-label="Навігація груп"
      className={
        'flex h-full min-h-0 flex-col overflow-hidden' +
        (fullHeight
          ? ''
          : ' min-[1200px]:border-r min-[1200px]:border-solid min-[1200px]:border-black/12 dark:min-[1200px]:border-white/12')
      }
    >
      {page.messengerEnabled ? (
        <div className="flex flex-col gap-3 px-3 pt-2">
          <ToggleButtonGroup
            value={tab}
            exclusive
            fullWidth
            size="small"
            color="primary"
            aria-label="Джерело"
            onChange={(_event, next: LeftPanelTab | null) => {
              if (next) page.setLeftPanelTab(next);
            }}
          >
            <ToggleButton value={LeftPanelTab.EchoGroups}>Ехо групи</ToggleButton>
            <ToggleButton value={LeftPanelTab.Messenger}>Телеграм</ToggleButton>
          </ToggleButtonGroup>
          {tab === LeftPanelTab.Messenger ? (
            <MessengerSearchField
              value={query}
              onChange={setQuery}
              ariaLabel="Пошук телеграм акаунту"
            />
          ) : null}
        </div>
      ) : null}
      <section
        data-analysis-group-list
        aria-labelledby={
          fullHeight || tab !== LeftPanelTab.EchoGroups ? undefined : 'analysis-groups-title'
        }
        className="flex min-h-0 flex-1 flex-col px-3 py-2"
      >
        {tab === LeftPanelTab.EchoGroups ? (
          <GroupList
            groups={page.groupNavigation.groups}
            scope={page.groupNavigation.scope}
            onSelect={selectGroup}
            title={fullHeight ? undefined : 'Групи'}
            titleId={fullHeight ? undefined : 'analysis-groups-title'}
            loading={page.groupNavigation.loading}
            error={
              typeof page.groupNavigation.error === 'string' ? page.groupNavigation.error : null
            }
            onRetry={page.groupNavigation.retry}
          />
        ) : (
          <MessengerAccountList
            accounts={page.messengerAccounts}
            loading={page.messengerAccountsLoading}
            error={page.messengerAccountsError}
            selectedId={page.selectedMessengerAccountId}
            onSelect={selectMessengerAccount}
            query={query}
          />
        )}
      </section>
    </aside>
  );
}
