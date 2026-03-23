import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '../../../button';
import { GlobalFilterTextField } from './components/global-filter-text-field';
import { InternalTableActions } from './components/internal-actions';
import { useTableStateContext } from '../../table-state-provider';

type MobileActionsBarProps = {
  header: ReactNode;
  children: ReactNode;
  onToggleMobileActions?: () => void;
  showMobileActions?: boolean;
};

function MobileActionsBar(props: MobileActionsBarProps) {
  const [showMobileActions, setShowMobileActions] = useState(false);

  function onToggleMobileActions() {
    setShowMobileActions(!showMobileActions);
  }

  useEffect(() => {
    if (props.onToggleMobileActions !== undefined) {
      setShowMobileActions(props.showMobileActions || false);
    }
  }, [props.showMobileActions]);

  return (
    <div className="block sm:hidden w-full mb-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.header}
        <Button variant="contained" onClick={props.onToggleMobileActions || onToggleMobileActions}>
          {showMobileActions ? 'Приховати' : 'Показати'} дії
        </Button>
      </div>
      <div
        className={clsx('h-0 overflow-hidden', {
          'h-auto': showMobileActions,
        })}
      >
        <div className="flex flex-col gap-2 pt-2">{props.children}</div>
      </div>
    </div>
  );
}

type DesktopActionsBarProps = {
  children: ReactNode;
};

function DesktopActionsBar(props: DesktopActionsBarProps) {
  return <div className="mb-3 hidden sm:flex flex-wrap items-center justify-between gap-2">{props.children}</div>;
}

type TableTopToolbarProps = {
  // Date global filter
  withDatePicker: boolean;
  datePicker?: ReactNode;
  // Filter
  filter?: ReactNode;
  // Text global filter
  withGlobalTextFilter: boolean;
  // Toolbar elements
  header: ReactNode;
  additionalActions?: ReactNode;
  additionalNoTableActions?: ReactNode;
  // Internal table actions
  densityDisabled?: boolean;
  densityHidden?: boolean;
  filtersHidden?: boolean;
  colOrderHidden?: boolean;
  colOrderDisabled?: boolean;
  filtersDisabled?: boolean;
  columnsVisibilityDisabled?: boolean;
  additionalInternalActions?: ReactNode;
  internalTableActionsPlaceholder?: ReactNode;
  rowNumberAppearanceControl?: boolean;
};

export function TableTopToolbar(props: TableTopToolbarProps) {
  const tableStateContext = useTableStateContext();

  const internalTableActions =
    props.internalTableActionsPlaceholder ||
    (
      <InternalTableActions
        table={tableStateContext.tableInstance}
        densityDisabled={props.densityDisabled}
        densityHidden={props.densityHidden}
        filtersHidden={props.filtersHidden}
        colOrderHidden={props.colOrderHidden}
        columnsVisibilityDisabled={props.columnsVisibilityDisabled}
        colOrderDisabled={props.colOrderDisabled}
        filtersDisabled={props.filtersDisabled}
        rowNumberAppearanceControl={props.rowNumberAppearanceControl}
      >
        {props.additionalInternalActions}
      </InternalTableActions>
    );

  return (
    <>
      <DesktopActionsBar>
        <div className="flex items-center flex-wrap gap-3">
          {props.header}
          {props.withDatePicker && props.datePicker}
          {props.withGlobalTextFilter && (
            <GlobalFilterTextField
              globalFilter={tableStateContext.globalFilter}
              setGlobalFilter={tableStateContext.onChangeGlobalFilter}
            />
          )}
          {props.filter}
        </div>
        <div className="flex items-center gap-3">
          {tableStateContext.tableInstance && props.additionalActions}
          {props.additionalNoTableActions}
          {internalTableActions}
        </div>
      </DesktopActionsBar>
      <MobileActionsBar header={props.header}>
        {internalTableActions}
        {props.withDatePicker && props.datePicker}
        {props.withGlobalTextFilter && (
          <GlobalFilterTextField
            globalFilter={tableStateContext.globalFilter}
            setGlobalFilter={tableStateContext.onChangeGlobalFilter}
          />
        )}
        {props.filter}
        {tableStateContext.tableInstance && props.additionalActions}
        {props.additionalNoTableActions}
      </MobileActionsBar>
    </>
  );
}
