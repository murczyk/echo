import { Button } from '@mui/material';
import { useMemo, useState } from 'react';
import { useStatsFacet } from './use-stats-facet';
import type { DailyMessageStatsReq } from '../../../../Bindings';
import { SenderFilter } from './SenderFilter';
import type { useStatsCatalog } from './use-stats-catalog';
import { initialState, type StatsState } from './state';
import { StatisticsFilter } from './StatisticsFilter';
import { StatisticsPeriod } from './StatisticsPeriod';
import { statisticsUnitOptions } from './statistics-unit-options';

type Props = {
  state: StatsState;
  update: (patch: Partial<StatsState>, resetPage?: boolean) => void;
  catalog: ReturnType<typeof useStatsCatalog>;
  request: DailyMessageStatsReq | null;
};
export function StatisticsFilters({ state, update, catalog, request }: Props) {
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [unitsOpen, setUnitsOpen] = useState(false);
  const setPeriod = (days: number) => {
    const { from, to } = initialState(days);
    update({ from, to });
  };
  const groupFacet = useStatsFacet('Groups', request, state.children, groupsOpen, catalog);
  const unitFacet = useStatsFacet('Units', request, state.children, unitsOpen, catalog);
  const groupCounts = new Map(groupFacet.data?.counts.map((entry) => [entry.value, entry.count]));
  const groupLabels = new Map(
    catalog.groups.flatMap((group) =>
      group.kind === 'group' ? [[group.masterKey, group.name] as const] : [],
    ),
  );
  state.groups.forEach((key) => {
    if (!groupLabels.has(key)) groupLabels.set(key, 'Недоступна група');
  });
  const unitOptions = useMemo(
    () => statisticsUnitOptions(catalog.hierarchy, unitFacet.data?.counts ?? []),
    [catalog.hierarchy, unitFacet.data],
  );
  return (
    <section aria-label="Фільтри статистики" className="message-statistics-filters">
      <div className="message-statistics-period-controls">
        <StatisticsPeriod state={state} update={update} />
        <div className="flex shrink-0 gap-echo-sm" role="group" aria-label="Швидкий період">
          <Button variant="outlined" size="small" onClick={() => setPeriod(1)}>
            Сьогодні
          </Button>
          <Button variant="outlined" size="small" onClick={() => setPeriod(7)}>
            7 днів
          </Button>
        </div>
      </div>
      <div className="message-statistics-groups-filter">
        <StatisticsFilter
          label="Групи"
          searchPlaceholder="Пошук групи"
          options={catalog.groups.flatMap((group) =>
            group.kind === 'group'
              ? [
                  {
                    value: group.masterKey,
                    label: group.name,
                    count: groupCounts.get(group.masterKey),
                  },
                ]
              : [],
          )}
          labels={groupLabels}
          value={state.groups}
          onChange={(groups) => update({ groups })}
          loading={groupFacet.loading || (catalog.loading && catalog.groups.length === 0)}
          onOpenChange={setGroupsOpen}
          footer={
            groupFacet.error ? (
              <Button size="small" onClick={groupFacet.retry}>
                Повторити завантаження груп
              </Button>
            ) : null
          }
        />
      </div>
      <div className="message-statistics-units-filter">
        <StatisticsFilter
          label="Підрозділи противника"
          searchPlaceholder="Пошук підрозділа"
          tree
          options={unitOptions}
          value={state.units}
          onChange={(units) => update({ units })}
          loading={unitFacet.loading}
          onOpenChange={setUnitsOpen}
          footer={
            unitFacet.error ? (
              <Button size="small" onClick={unitFacet.retry}>
                Повторити завантаження підрозділів
              </Button>
            ) : null
          }
          disabled={!catalog.hierarchy}
          suffix={
            <Button
              className="message-statistics-children"
              aria-label="Включати дочірні"
              aria-pressed={state.children}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                update({ children: !state.children });
              }}
            >
              {state.children ? '+ дочірні' : '− дочірні'}
            </Button>
          }
        />
      </div>
      <SenderFilter
        catalog={catalog}
        request={request}
        selected={state.senders}
        onChange={(senders) => update({ senders })}
      />
      <Button className="message-statistics-reset" onClick={() => update(initialState())}>
        Скинути
      </Button>
    </section>
  );
}
