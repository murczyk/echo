import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import { Divider, FormControlLabel, Switch, Tooltip } from '@mui/material';
import clsx from 'clsx';
import { useCallback, useState } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';

import { PowerButton } from '../../../../../../../PowerButton';
import { PowerIconButton } from '../../../../../../../PowerIconButton';
import { PowerMenu } from '../../../../../../../PowerMenu';
import { INTERNAL_COLUMN_IDS, useTableStateContext } from '../../../../../table-state-provider';

type ColumnsVisibilityButtonProps = {
  disabled?: boolean;
  showTitle?: boolean;
  rowNumberAppearanceControl?: boolean;
};

export function ColumnsVisibilityButton(props: ColumnsVisibilityButtonProps) {
  const tableStateContext = useTableStateContext();
  const columnsToExclude = props.rowNumberAppearanceControl
    ? INTERNAL_COLUMN_IDS.filter((c) => c !== 'mrt-row-numbers')
    : INTERNAL_COLUMN_IDS;

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  function onOpen(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  }

  function onClose() {
    setAnchorEl(null);
  }

  function onToggleColumn(event: ChangeEvent<HTMLInputElement>, columnKey: string) {
    event.stopPropagation();
    tableStateContext.onChangeColumnVisibility(columnKey, event.target.checked);
  }

  function onClickReset(event: MouseEvent) {
    event.stopPropagation();
    tableStateContext.onResetColumnsVisibility();
  }

  function onToggleColumnOrdering(event: ChangeEvent<HTMLInputElement>) {
    event.stopPropagation();
    tableStateContext.setEnableColumnOrdering(event.target.checked);
  }

  function onResetLayoutSettings(event: MouseEvent) {
    event.stopPropagation();
    tableStateContext.onColumnOrderChange([]);
    tableStateContext.onColumnSizingChange({});
  }

  function onToggleColumnResizing(event: ChangeEvent<HTMLInputElement>) {
    event.stopPropagation();
    tableStateContext.setEnableColumnResizing(event.target.checked);
  }

  const allColumns = tableStateContext.tableInstance?.getAllColumns?.() || [];
  const hasLayoutChanges = tableStateContext.columnOrderTouched || tableStateContext.columnSizeTouched;
  const getColumnIdentifier = useCallback(
    (column: { id: string; columnDef: { accessorKey?: string; id?: string } }) => column.id || column.columnDef.id || column.columnDef.accessorKey || '',
    [],
  );
  const sortedColumns = allColumns.sort((c1, c2) => {
    return (
      tableStateContext.columnOrder.findIndex((c) => c === getColumnIdentifier(c1)) -
      tableStateContext.columnOrder.findIndex((c) => c === getColumnIdentifier(c2))
    );
  });

  return (
    <>
      <PowerMenu
        onClose={onClose}
        anchorEl={anchorEl}
        open={!!anchorEl}
        anchorOrigin={{
          vertical: -15,
          horizontal: 'center',
        }}
        transformOrigin={{
          vertical: 'bottom',
          horizontal: 'center',
        }}
      >
        <div className={clsx('!p-4 min-w-80')}>
          <div className="mb-3">
            <div className="mb-1 flex min-h-10 items-center justify-between gap-2">
              <p className="mb-0 font-semibold leading-6">Налаштування</p>
              <PowerButton
                onClick={onResetLayoutSettings}
                size="small"
                disabled={!hasLayoutChanges}
                style={{ alignSelf: 'center', minHeight: 'unset', paddingTop: 0, paddingBottom: 0 }}
              >
                Скинути
              </PowerButton>
            </div>
            <div>
              <FormControlLabel
                control={<Switch onChange={onToggleColumnOrdering} checked={tableStateContext.enableColumnOrdering} />}
                label="Зміна порядку стовпців"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            <div>
              <FormControlLabel
                control={<Switch onChange={onToggleColumnResizing} checked={tableStateContext.enableColumnResizing} />}
                label="Зміна розміру стовпців"
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>
          <Divider className="!mb-3" />
          <div className="mb-1 flex min-h-10 items-center justify-between gap-2">
            <p className="mb-0 font-semibold leading-6">Показати</p>
            <PowerButton
              onClick={onClickReset}
              size="small"
              disabled={!tableStateContext.columnVisibilityTouched}
              style={{ alignSelf: 'center', minHeight: 'unset', paddingTop: 0, paddingBottom: 0 }}
            >
              Скинути
            </PowerButton>
          </div>
          {sortedColumns.map((column) => {
            const columnIdentifier = getColumnIdentifier(column);

            if (columnsToExclude.includes(columnIdentifier)) {
              return null;
            }

            if (column.columnDef.columns) {
              return (
                <div className="my-1" key={columnIdentifier}>
                  <p className="font-semibold">{column.columnDef.header}</p>
                  <div className="pl-3">
                    {column.columnDef.columns.map((childColumn) => {
                      const childColumnIdentifier = childColumn.id || '';
                      return (
                        <div key={childColumnIdentifier} className="mb-0.5">
                          <FormControlLabel
                            control={
                              <Switch
                                onChange={(event) => onToggleColumn(event, childColumnIdentifier)}
                                checked={tableStateContext.columnVisibility[childColumnIdentifier] || false}
                                size="small"
                              />
                            }
                            label={childColumn.header}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }

            return (
              <div key={columnIdentifier}>
                <FormControlLabel
                  control={
                    <Switch
                      onChange={(event) => onToggleColumn(event, columnIdentifier)}
                      checked={tableStateContext.columnVisibility[columnIdentifier] || false}
                    />
                  }
                  label={column.columnDef.header}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>
      </PowerMenu>
      <Tooltip title={props.showTitle ? '' : 'Показати/приховати стовпці'}>
        <span className="relative">
          <PowerIconButton
            disabled={props.disabled}
            size="small"
            onClick={onOpen}
            className="relative"
            sx={
              props.showTitle
                ? {
                    '&:hover': {
                      backgroundColor: 'transparent',
                    },
                    padding: '6px 12px',
                  }
                : undefined
            }
          >
            <ViewColumnIcon />
            {tableStateContext.columnVisibilityTouched && (
              <div
                className="bg-red-500 absolute top-[7px] h-2 w-2 rounded-full z-10"
                style={{
                  left: props.showTitle ? '28px' : '21px',
                }}
              />
            )}
            {props.showTitle && <span className="pl-1 text-sm pointer-events-none">Показати/приховати стовпці</span>}
          </PowerIconButton>
        </span>
      </Tooltip>
    </>
  );
}
