import dayjs, { Dayjs } from 'dayjs';
import React from 'react';

import { useLocalStorage } from '../../../hooks/use-local-storage';
import { objectsEqual, strArraysEqual } from '../../../utils/misc';

import {
  MRT_ColumnFiltersState,
  MRT_ColumnOrderState,
  MRT_ColumnSizingState,
  MRT_DensityState,
  MRT_SortingState,
  MRT_TableInstance,
  MRT_VisibilityState,
} from 'material-react-table';

type Updater<T> = T | ((prev: T) => T);

type SearchParams = {
  [k: string]: string;
};

function getCurrentSearchParamsObject(): SearchParams {
  return Object.fromEntries(Array.from(new URLSearchParams(window.location.search).entries()));
}

type TableStateContextValue = {
  globalFilter: string;
  onChangeGlobalFilter: (value: Updater<string>) => void;
  date: Dayjs | null;
  dateForRequest?: string;
  onChangeDate: (value: Dayjs | null) => SearchParams;
  tableInstance: MRT_TableInstance<any> | null;
  onTableInitialized: (table: any) => void;
  isEditable: boolean;
  columnVisibility: { [key: string]: boolean };
  columnVisibilityTouched: boolean;
  onChangeColumnVisibility: (key: string, value: boolean) => void;
  onResetColumnsVisibility: () => void;
  setDefaultColumnVisibility: (value: { [key: string]: boolean }) => void;
  onChangeColumnsVisibility: (value: { [key: string]: boolean }) => SearchParams;
  onColumnVisibilityChange: (value: Updater<MRT_VisibilityState>) => void;
  updateColumnVisibility: (value?: { [key: string]: boolean }) => void;
  density: MRT_DensityState;
  setDensity: (value: MRT_DensityState) => void;
  columnFilters: MRT_ColumnFiltersState;
  onColumnFiltersChange: (value: Updater<MRT_ColumnFiltersState>, updatedSearchParams?: SearchParams) => SearchParams;
  sorting: MRT_SortingState;
  onSortingChange: (value: Updater<MRT_SortingState>, updatedSearchParams?: SearchParams) => SearchParams;
  tableId: string;
  columnOrder: MRT_ColumnOrderState;
  columnOrderTouched: boolean;
  columnSizeTouched: boolean;
  onColumnOrderChange: (value: Updater<MRT_ColumnOrderState>) => void;
  columnSizing: MRT_ColumnSizingState;
  onColumnSizingChange: (value: Updater<MRT_ColumnSizingState>) => void;
  enableColumnOrdering: boolean;
  setEnableColumnOrdering: (value: boolean) => void;
  enableColumnResizing: boolean;
  setEnableColumnResizing: (value: boolean) => void;
};

const TableStateContext = React.createContext<TableStateContextValue>({
  globalFilter: '',
  onChangeGlobalFilter: () => {},
  date: null,
  onChangeDate: () => ({}) as SearchParams,
  tableInstance: null,
  onTableInitialized: () => {},
  isEditable: false,
  columnVisibility: {},
  columnVisibilityTouched: false,
  onResetColumnsVisibility: () => {},
  onChangeColumnVisibility: () => {},
  onColumnVisibilityChange: () => {},
  setDefaultColumnVisibility: () => {},
  onChangeColumnsVisibility: () => ({}) as SearchParams,
  updateColumnVisibility: () => {},
  density: 'compact',
  setDensity: () => {},
  columnFilters: [],
  onColumnFiltersChange: () => ({}) as SearchParams,
  sorting: [],
  onSortingChange: () => ({}) as SearchParams,
  columnOrder: [],
  columnOrderTouched: false,
  columnSizeTouched: false,
  onColumnOrderChange: () => {},
  columnSizing: {},
  onColumnSizingChange: () => {},
  enableColumnOrdering: false,
  setEnableColumnOrdering: () => {},
  enableColumnResizing: true,
  setEnableColumnResizing: () => {},
  tableId: '',
});

type ColumnVisibility = { [key: string]: boolean };

type TableStateProviderProps = {
  defaultColumnVisibility: ColumnVisibility;
  defaultColumnOrder: MRT_ColumnOrderState;
  defaultSorting?: MRT_SortingState;
  defaultDate?: Dayjs;
  disableSavingOfColumnsVisibility?: boolean;
  tableId: string;
};

function useSearchParamsState(): [URLSearchParams, (value: SearchParams) => void] {
  const [searchParams, setSearchParams] = React.useState(() => new URLSearchParams(window.location.search));

  React.useEffect(() => {
    function onPopState() {
      setSearchParams(new URLSearchParams(window.location.search));
    }

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function updateSearchParams(value: SearchParams) {
    const params = new URLSearchParams(value);
    const next = params.toString();
    const nextUrl = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
    setSearchParams(new URLSearchParams(next));
  }

  return [searchParams, updateSearchParams];
}

export function TableStateProvider(props: React.PropsWithChildren<TableStateProviderProps>) {
  const localStorage = useLocalStorage();
  const [searchParams, setSearchParams] = useSearchParamsState();

  const [tableInstance, setTableInstance] = React.useState<MRT_TableInstance<any> | null>(null);

  const [date, setDate] = React.useState<Dayjs | null>(() => {
    const dateFromParams = searchParams.get('date');
    if (dateFromParams) {
      return dayjs(dateFromParams);
    }
    return props.defaultDate || dayjs().startOf('D');
  });

  const [columnFilters, setColumnFilters] = React.useState<MRT_ColumnFiltersState>(() => {
    const columnFiltersFromParams = searchParams.get('columnFilters');
    if (!columnFiltersFromParams) return [];

    try {
      return JSON.parse(columnFiltersFromParams).map(({ id, value }: { id: string; value: any }) => ({
        id,
        value,
      }));
    } catch (error) {
      return [];
    }
  });
  const [sorting, setSorting] = React.useState<MRT_SortingState>(() => {
    const sortByFromParams = searchParams.get('sorting');
    if (!sortByFromParams) return props.defaultSorting ?? [];

    try {
      return JSON.parse(sortByFromParams).map(({ id, desc }: { id: string; desc: any }) => ({
        id,
        desc,
      }));
    } catch (error) {
      return props.defaultSorting ?? [];
    }
  });
  const [density, setDensity] = React.useState<MRT_DensityState>('compact');
  const [globalFilter, setGlobalFilter] = React.useState(() => searchParams.get('globalFilter') || '');
  const [columnSizing, setColumnSizing] = React.useState<MRT_ColumnSizingState>(() => getInitialColumnSizing());
  const [enableColumnOrdering, setEnableColumnOrdering] = React.useState<boolean>(() => getInitialEnableColumnOrdering());
  const [enableColumnResizing, setEnableColumnResizing] = React.useState<boolean>(() => getInitialEnableColumnResizing());

  const [defaultColumnVisibility, setDefaultColumnVisibility] = React.useState<{ [key: string]: boolean }>(
    () => props.defaultColumnVisibility,
  );
  const [columnVisibility, setColumnVisibility] = React.useState<{ [key: string]: boolean }>(() =>
    getInitialColumnsVisibility(),
  );
  const [columnOrder, setColumnOrder] = React.useState<MRT_ColumnOrderState>(() => getInitialColumnOrder());

  const columnOrderTouched = !strArraysEqual(
    columnOrder.filter((c) => columnVisibility[c]),
    props.defaultColumnOrder.filter((c) => columnVisibility[c]),
  );
  const columnSizeTouched = Object.keys(columnSizing).length > 0;

  const columnVisibilityTouched = !objectsEqual(columnVisibility, defaultColumnVisibility);

  function getInitialColumnOrder() {
    const columnOrderFromStorage = localStorage.getItem(`columnOrder-${props.tableId}`);
    if (columnOrderFromStorage) {
      try {
        const currentColumnOrder: string[] = JSON.parse(columnOrderFromStorage);

        if (
          currentColumnOrder.length !== props.defaultColumnOrder.length ||
          currentColumnOrder.some((c) => !props.defaultColumnOrder.find((dc) => dc === c)) ||
          props.defaultColumnOrder.some((c) => !currentColumnOrder.find((dc) => dc === c))
        ) {
          localStorage.setItem(`columnOrder-${props.tableId}`, JSON.stringify(props.defaultColumnOrder));
          return props.defaultColumnOrder;
        } else {
          return JSON.parse(columnOrderFromStorage);
        }
      } catch (error) {}
    }
    return props.defaultColumnOrder;
  }

  function getInitialColumnSizing() {
    const columnSizingFromStorage = localStorage.getItem(`columnSizing-${props.tableId}`);
    if (columnSizingFromStorage) {
      try {
        return JSON.parse(columnSizingFromStorage);
      } catch (error) {}
    }
    return {};
  }

  function getInitialEnableColumnOrdering() {
    const value = localStorage.getItem(`enableColumnOrdering-${props.tableId}`);
    if (value) {
      try {
        return JSON.parse(value);
      } catch (error) {}
    }
    return false;
  }

  function getInitialEnableColumnResizing() {
    const value = localStorage.getItem(`enableColumnResizing-${props.tableId}`);
    if (value) {
      try {
        return JSON.parse(value);
      } catch (error) {}
    }
    return true;
  }

  function getInitialColumnsVisibility(defaultVisibilityValue?: { [key: string]: boolean }) {
    const visibleColumnsFromStorage = localStorage.getItem(`visibleColumns-${props.tableId}`);
    const hiddenColumnsFromStorage = localStorage.getItem(`hiddenColumns-${props.tableId}`);

    const colVis = {
      ...(defaultVisibilityValue ?? defaultColumnVisibility),
    };

    if (visibleColumnsFromStorage) {
      try {
        Object.assign(
          colVis,
          (JSON.parse(visibleColumnsFromStorage) as string[]).reduce(
            (acc, colName) => ({ ...acc, [colName]: true }),
            {},
          ),
        );
      } catch (error) {}
    }

    if (hiddenColumnsFromStorage) {
      try {
        Object.assign(
          colVis,
          (JSON.parse(hiddenColumnsFromStorage) as string[]).reduce(
            (acc, colName) => ({ ...acc, [colName]: false }),
            {},
          ),
        );
      } catch (error) {}
    }

    return colVis;
  }

  function onChangeGlobalFilter(updaterOrValue: Updater<string>): SearchParams {
    const nextFilter = typeof updaterOrValue === 'function' ? updaterOrValue(globalFilter) : updaterOrValue;
    const newSearchParams = getCurrentSearchParamsObject();

    if (nextFilter) {
      Object.assign(newSearchParams, { globalFilter: nextFilter });
    } else {
      delete newSearchParams['globalFilter'];
    }
    setSearchParams(newSearchParams);
    setGlobalFilter(nextFilter);

    return newSearchParams;
  }

  function onChangeDate(date: Dayjs | null): SearchParams {
    const newSearchParams = getCurrentSearchParamsObject();

    if (date) {
      const isDateEqualToDefault = !!props.defaultDate
        ? date.isSame(props.defaultDate, 'date')
        : dayjs().isSame(date, 'date');

      if (isDateEqualToDefault) {
        delete newSearchParams['date'];
      } else {
        Object.assign(newSearchParams, { date: date.format('YYYY-MM-DD') });
      }
    }
    setSearchParams(newSearchParams);
    setDate(date);

    return newSearchParams;
  }

  function onResetColumnsVisibility() {
    localStorage.removeItem(`visibleColumns-${props.tableId}`);
    localStorage.removeItem(`hiddenColumns-${props.tableId}`);

    setColumnVisibility(defaultColumnVisibility);
  }

  // handler for built-in column toggle
  function onColumnVisibilityChange(updaterOrValue: Updater<MRT_VisibilityState>) {
    let newVisibility;

    if (typeof updaterOrValue === 'function') {
      newVisibility = updaterOrValue(columnVisibility);
    } else {
      newVisibility = updaterOrValue;
    }

    onChangeColumnsVisibility(newVisibility);
  }

  function onChangeColumnsVisibility(newColumnVisibilityValue: { [key: string]: boolean }) {
    if (!props.disableSavingOfColumnsVisibility) {
      const defaultVisibleColumnKeys = Object.keys(defaultColumnVisibility).filter(
        (key) => defaultColumnVisibility[key] === true,
      );

      const additionalVisibleColumnKeys = Object.keys(newColumnVisibilityValue)
        .filter((key) => !defaultVisibleColumnKeys.includes(key))
        .filter((key) => newColumnVisibilityValue[key] === true);

      const defaultHiddenColumnKeys = Object.keys(newColumnVisibilityValue)
        .filter((key) => defaultVisibleColumnKeys.includes(key))
        .filter((key) => newColumnVisibilityValue[key] === false);

      if (additionalVisibleColumnKeys.length > 0) {
        localStorage.setItem(`visibleColumns-${props.tableId}`, JSON.stringify(additionalVisibleColumnKeys));
      } else localStorage.removeItem(`visibleColumns-${props.tableId}`);

      if (defaultHiddenColumnKeys.length > 0) {
        localStorage.setItem(`hiddenColumns-${props.tableId}`, JSON.stringify(defaultHiddenColumnKeys));
      } else localStorage.removeItem(`hiddenColumns-${props.tableId}`);
    }

    setColumnVisibility(newColumnVisibilityValue);

    const disabledVisibilityColumns = Object.keys(newColumnVisibilityValue).filter(
      (column) => !newColumnVisibilityValue[column],
    );
    return onColumnFiltersChange(
      columnFilters.filter((columnFilter) => !disabledVisibilityColumns.includes(columnFilter.id)),
    );
  }

  function onChangeColumnVisibility(key: string, value: boolean) {
    const newColumnVisibilityValue = { ...columnVisibility, [key]: value };
    onChangeColumnsVisibility(newColumnVisibilityValue);
  }

  function onColumnFiltersChange(
    updaterOrValue: Updater<MRT_ColumnFiltersState>,
    updatedSearchParams?: SearchParams,
  ): SearchParams {
    let newFilters;

    if (typeof updaterOrValue === 'function') {
      newFilters = updaterOrValue(columnFilters);
    } else {
      newFilters = updaterOrValue;
    }

    const existingParams = getCurrentSearchParamsObject();
    const newSearchParams = updatedSearchParams || Object.assign({}, existingParams);

    if (newFilters.length > 0) {
      const columnFilters = JSON.stringify(newFilters);

      Object.assign(newSearchParams, { columnFilters });
    } else {
      delete newSearchParams['columnFilters'];
    }

    if (!objectsEqual(existingParams, newSearchParams)) {
      setSearchParams(newSearchParams);
    }
    setColumnFilters(newFilters);

    return newSearchParams;
  }

  function onSortingChange(updaterOrValue: Updater<MRT_SortingState>, updatedSearchParams?: SearchParams): SearchParams {
    let newSorting;

    if (typeof updaterOrValue === 'function') {
      newSorting = updaterOrValue(sorting);
    } else {
      newSorting = updaterOrValue;
    }

    const newSearchParams = updatedSearchParams || getCurrentSearchParamsObject();

    if (newSorting.length > 0) {
      const sorting = JSON.stringify(newSorting);

      Object.assign(newSearchParams, { sorting });
    } else {
      delete newSearchParams['sorting'];
    }

    setSearchParams(newSearchParams);
    setSorting(newSorting);

    return newSearchParams;
  }

  function onColumnOrderChange(updaterOrValue: Updater<MRT_ColumnOrderState>) {
    let newColumnOrder;

    if (typeof updaterOrValue === 'function') {
      newColumnOrder = updaterOrValue(columnOrder);
    } else {
      newColumnOrder = updaterOrValue.length > 0 ? updaterOrValue : props.defaultColumnOrder || [];
    }

    localStorage.setItem(`columnOrder-${props.tableId}`, JSON.stringify(newColumnOrder));
    setColumnOrder(newColumnOrder);
  }

  function onColumnSizingChange(updaterOrValue: Updater<MRT_ColumnSizingState>) {
    let newColumnSizing;

    if (typeof updaterOrValue === 'function') {
      newColumnSizing = updaterOrValue(columnSizing);
    } else {
      newColumnSizing = updaterOrValue;
    }

    localStorage.setItem(`columnSizing-${props.tableId}`, JSON.stringify(newColumnSizing));
    setColumnSizing(newColumnSizing);
  }

  function onSetEnableColumnOrdering(value: boolean) {
    localStorage.setItem(`enableColumnOrdering-${props.tableId}`, JSON.stringify(value));
    setEnableColumnOrdering(value);
  }

  function onSetEnableColumnResizing(value: boolean) {
    localStorage.setItem(`enableColumnResizing-${props.tableId}`, JSON.stringify(value));
    setEnableColumnResizing(value);
  }

  const isDateEqualToDefault = !!props.defaultDate
    ? date?.isSame(props.defaultDate, 'date')
    : (date ? dayjs().isSame(date, 'date') : false);
  const dateForRequest = isDateEqualToDefault ? undefined : date?.format('YYYY-MM-DD');

  function onTableInitialized(table: MRT_TableInstance<any>) {
    setTableInstance(table);
    // TOOLTIP SCROLL HACK
    if (table.refs['tableContainerRef'].current) {
      table.refs['tableContainerRef'].current.addEventListener('scroll', () => {
        document.querySelectorAll<HTMLDivElement>('.MuiTooltip-popper').forEach((tooltip) => {
          tooltip.setAttribute('style', 'display: none;');
        });
      });
    }
  }

  function updateColumnVisibility(defaultVisibilityValue?: { [key: string]: boolean }) {
    setColumnVisibility(getInitialColumnsVisibility(defaultVisibilityValue));
    if (defaultVisibilityValue) {
      setDefaultColumnVisibility(defaultVisibilityValue);
    }
  }

  return (
    <TableStateContext.Provider
      value={{
        globalFilter,
        onChangeGlobalFilter,
        date,
        dateForRequest,
        onChangeDate,
        tableInstance,
        onTableInitialized,
        columnVisibility,
        columnVisibilityTouched,
        onChangeColumnVisibility,
        onChangeColumnsVisibility,
        onColumnVisibilityChange,
        onResetColumnsVisibility,
        setDefaultColumnVisibility,
        updateColumnVisibility,
        isEditable: !dateForRequest,
        density,
        setDensity,
        columnFilters,
        onColumnFiltersChange,
        sorting,
        onSortingChange,
        columnOrder,
        onColumnOrderChange,
        columnOrderTouched,
        columnSizeTouched,
        columnSizing,
        onColumnSizingChange,
        enableColumnOrdering,
        setEnableColumnOrdering: onSetEnableColumnOrdering,
        enableColumnResizing,
        setEnableColumnResizing: onSetEnableColumnResizing,
        tableId: props.tableId,
      }}
    >
      {props.children}
    </TableStateContext.Provider>
  );
}

export function useTableStateContext() {
  return React.useContext(TableStateContext);
}
