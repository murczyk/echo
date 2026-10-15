import type { ReactNode } from 'react';

import { GlobalFilterTextField } from './mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { useTableStateContext } from './mui-customized/table/table-state-provider';
import { TableToolbarLayout } from './TableToolbarLayout';

type Props = {
  withGlobalTextFilter?: boolean;
  filter?: ReactNode;
  hideGlobalTextFilter?: boolean;
  trailingActionsBeforeInternal?: ReactNode;
  trailingActions?: ReactNode;
  trailingActionsAfterInternal?: ReactNode;
};

export function TableToolbarControls(props: Props) {
  const tableStateContext = useTableStateContext();
  const hasLeadingControls = Boolean(
    (props.withGlobalTextFilter && !props.hideGlobalTextFilter) || props.filter,
  );
  const hasTrailingActions = Boolean(
    props.trailingActionsBeforeInternal ||
    props.trailingActions ||
    props.trailingActionsAfterInternal,
  );

  if (!hasLeadingControls && !hasTrailingActions) {
    return null;
  }

  return (
    <TableToolbarLayout
      leading={
        <>
          {props.withGlobalTextFilter && !props.hideGlobalTextFilter ? (
            <div className="w-full min-w-56 max-w-[360px] flex-1">
              <GlobalFilterTextField
                className="!min-w-0 !w-full"
                globalFilter={tableStateContext.globalFilter}
                setGlobalFilter={tableStateContext.onChangeGlobalFilter}
              />
            </div>
          ) : null}
          {props.filter}
        </>
      }
      trailing={
        hasTrailingActions ? (
          <>
            {props.trailingActionsBeforeInternal ? (
              <div className="flex shrink-0 flex-wrap items-center gap-echo-md">
                {props.trailingActionsBeforeInternal}
              </div>
            ) : null}
            {props.trailingActions || props.trailingActionsAfterInternal ? (
              <div className="flex shrink-0 flex-wrap items-center gap-echo-md">
                {props.trailingActions}
                {props.trailingActionsAfterInternal}
              </div>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
