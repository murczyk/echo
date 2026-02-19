import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import { Divider, FormControlLabel, Switch, Tooltip } from '@mui/material';
import clsx from 'clsx';
import React from 'react';

import { Button } from '../../../../../../button';
import { IconButton } from '../../../../../../icon-button';
import { Menu } from '../../../../../../menu';
import { useTableStateContext } from '../../../../../table-state-provider';

const internalColumns = ['mrt-row-actions', 'mrt-row-drag', 'mrt-row-numbers', 'mrt-row-select', 'mrt-row-expand'];

type ColumnsVisibilityButtonProps = {
  disabled?: boolean;
  showTitle?: boolean;
  rowNumberAppearanceControl?: boolean;
};

export function ColumnsVisibilityButton(props: ColumnsVisibilityButtonProps) {
  const tableStateContext = useTableStateContext();
  const columnsToExclude = props.rowNumberAppearanceControl
    ? internalColumns.filter((c) => c !== 'mrt-row-numbers')
    : internalColumns;

  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);

  function onOpen(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  }

  function onClose() {
    setAnchorEl(null);
  }

  function onToggleColumn(event: React.ChangeEvent<HTMLInputElement>, columnKey: string) {
    event.stopPropagation();
    tableStateContext.onChangeColumnVisibility(columnKey, event.target.checked);
  }

  function onClickReset(event: React.MouseEvent) {
    event.stopPropagation();
    tableStateContext.onResetColumnsVisibility();
  }

  function onToggleColumnOrdering(event: React.ChangeEvent<HTMLInputElement>) {
    event.stopPropagation();
    tableStateContext.setEnableColumnOrdering(event.target.checked);
  }

  function onResetColumnOrdering(event: React.MouseEvent) {
    event.stopPropagation();
    tableStateContext.onColumnOrderChange([]);
  }

  function onResetColumnSizing(event: React.MouseEvent) {
    event.stopPropagation();
    tableStateContext.onColumnSizingChange({});
  }

  function onToggleColumnResizing(event: React.ChangeEvent<HTMLInputElement>) {
    event.stopPropagation();
    tableStateContext.setEnableColumnResizing(event.target.checked);
  }

  const allColumns = tableStateContext.tableInstance?.getAllColumns?.() || [];
  const sortedColumns = allColumns.sort((c1, c2) => {
    return (
      tableStateContext.columnOrder.findIndex((c) => c === (c1.columnDef.accessorKey || '')) -
      tableStateContext.columnOrder.findIndex((c) => c === (c2.columnDef.accessorKey || ''))
    );
  });

  return (
    <>
      <Menu
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
            <div>
              <FormControlLabel
                control={<Switch onChange={onToggleColumnOrdering} checked={tableStateContext.enableColumnOrdering} />}
                label="Зміна порядку стовпців"
                onClick={(e) => e.stopPropagation()}
              />
              {tableStateContext.columnOrderTouched && (
                <Button onClick={onResetColumnOrdering} size="small">
                  Скинути
                </Button>
              )}
            </div>
            <div>
              <FormControlLabel
                control={<Switch onChange={onToggleColumnResizing} checked={tableStateContext.enableColumnResizing} />}
                label="Зміна розміру стовпців"
                onClick={(e) => e.stopPropagation()}
              />
              {tableStateContext.columnSizeTouched && (
                <Button onClick={onResetColumnSizing} size="small">
                  Скинути
                </Button>
              )}
            </div>
          </div>
          <Divider className="!mb-3" />
          <div className="flex items-center gap-2 mb-1 h-10">
            <p className="font-semibold mb-0.5">Показати</p>
            {tableStateContext.columnVisibilityTouched && (
              <Button onClick={onClickReset} size="small">
                Скинути
              </Button>
            )}
          </div>
          {sortedColumns.map((column) => {
            const columnIdentifier = column.columnDef.accessorKey || column.columnDef.id;

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
      </Menu>
      <Tooltip title={props.showTitle ? '' : 'Показати/приховати стовпці'}>
        <span className="relative">
          <IconButton
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
          </IconButton>
        </span>
      </Tooltip>
    </>
  );
}
