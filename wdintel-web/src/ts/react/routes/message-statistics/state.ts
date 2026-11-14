import dayjs from 'dayjs';
import type {
  DailyMessageStatsGrouping,
  DailyMessageStatsReq,
  UnitHierarchyRsp,
} from '../../../../Bindings';
import { APP_TIME_ZONE } from '../../utils/misc';
import { expandUnitSelections, indexUnitHierarchyTree } from '../shared/unit-children-filter';
import { readUnitHierarchyTree } from '../shared/unit-hierarchy';

export const STATS_REFRESH_MS = 60_000;
export const STATS_SERIES_PAGE_SIZE = 10;
export const STATS_MAX_DAYS = 90;
export const senderValue = (key: string | null) => JSON.stringify(key);
export type StatsState = {
  from: string;
  to: string;
  grouping: DailyMessageStatsGrouping;
  groups: string[];
  senders: string[];
  units: string[];
  children: boolean;
  cursors: Array<string | null>;
};
export function today(): string {
  return dayjs().tz(APP_TIME_ZONE).format('YYYY-MM-DD');
}
export function initialState(days = 7): StatsState {
  const to = today();
  return {
    from: dayjs(to)
      .subtract(days - 1, 'day')
      .format('YYYY-MM-DD'),
    to,
    grouping: 'Groups',
    groups: [],
    senders: [],
    units: [],
    children: true,
    cursors: [null],
  };
}
export function readState(): StatsState {
  const params = new URLSearchParams(window.location.search);
  const defaults = initialState();
  return {
    ...defaults,
    from: params.get('from') ?? defaults.from,
    to: params.get('to') ?? defaults.to,
    grouping: params.get('grouping') === 'Senders' ? 'Senders' : 'Groups',
    groups: params.getAll('groups'),
    senders: params.getAll('senders').filter((value) => {
      try {
        const key = JSON.parse(value);
        return key === null || typeof key === 'string';
      } catch {
        return false;
      }
    }),
    units: params.getAll('units'),
    children: params.get('children') !== 'false',
    cursors: [null, ...params.getAll('cursor')],
  };
}
export function stateHref(state: StatsState): string {
  const params = new URLSearchParams({
    from: state.from,
    to: state.to,
    grouping: state.grouping,
    children: String(state.children),
  });
  for (const name of ['groups', 'senders', 'units'] as const)
    state[name].forEach((value) => params.append(name, value));
  state.cursors.slice(1).forEach((value) => {
    if (value) params.append('cursor', value);
  });
  return `/message-statistics?${params.toString()}`;
}
export function periodError(state: StatsState): string | null {
  const valid = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    dayjs(value).isValid() &&
    dayjs(value).format('YYYY-MM-DD') === value;
  if (!valid(state.from) || !valid(state.to)) return 'Вкажіть коректні дати періоду.';
  const days = dayjs(state.to).diff(dayjs(state.from), 'day') + 1;
  return days < 1 || days > STATS_MAX_DAYS || state.to > today()
    ? 'Оберіть від 1 до 90 днів, не пізніше сьогодні.'
    : null;
}
export function buildStatsRequest(
  state: StatsState,
  hierarchy: UnitHierarchyRsp | null,
): DailyMessageStatsReq | null {
  if (periodError(state) || (state.units.length > 0 && !hierarchy)) return null;
  const index = hierarchy
    ? indexUnitHierarchyTree(readUnitHierarchyTree(hierarchy), hierarchy.units)
    : null;
  const ids = expandUnitSelections(state.units, state.children, index)
    .filter((value) => /^unit-id:\d+$/.test(value))
    .map((value) => Number(value.slice(8)));
  return {
    fromDate: state.from,
    toDate: state.to,
    grouping: state.grouping,
    selectedGroups: state.groups.length ? state.groups : null,
    selectedSenders: state.senders.length
      ? state.senders.map((value) => ({ sender: JSON.parse(value) as string | null }))
      : null,
    selectedUnitIds: state.units.length ? ids : null,
    cursor: state.cursors.at(-1) ?? null,
    userLabelId: null,
  };
}
