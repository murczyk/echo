import { Box } from '@mui/material';
import { useMemo } from 'react';
import { canManageUser, useUserManagementScope } from './user-management-scope';

import { Login } from '../../../../Bindings';
import { EchoChip } from '../../components/EchoChip';
import { CUSTOM_CELL_STYLES } from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  mrtCustomCell,
  mrtItemsCell,
  mrtTextCell,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import { UserUuidValue } from './UserUuidValue';

import {
  CopyUuidButton,
  formatDate,
  formatOptionalLabel,
  formatUuidShort,
  getStatusInfo,
  matchesStatusFilter,
} from './user-display';
import { ROLE_OPTIONS, STATUS_FILTER_OPTIONS } from './user-types';
export function useUsersColumns(onEdit: (login: Login) => void): AppMrtColumnDef<Login>[] {
  const organism = useUserManagementScope();
  return useMemo(
    () => [
      {
        header: 'Логін',
        accessorKey: 'login',
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text', interactive: true },
        Cell: mrtCustomCell(({ row }) =>
          organism ? (
            canManageUser(organism, row.original) ? (
              <MrtOverflowText
                displayValue={row.original.login}
                fullValue={row.original.login}
                interactive
                component="button"
                componentProps={{ type: 'button', onClick: () => onEdit(row.original) }}
              />
            ) : (
              <MrtOverflowText displayValue={row.original.login} fullValue={row.original.login} />
            )
          ) : (
            <MrtOverflowText
              displayValue={row.original.login}
              fullValue={row.original.login}
              interactive
              component="a"
              componentProps={{
                href: `/admin/users-neo/${encodeURIComponent(row.original.id)}`,
                onClick: (event: MouseEvent) => {
                  if (
                    event.button === 0 &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    window.history.pushState(
                      {},
                      '',
                      `/admin/users-neo/${encodeURIComponent(row.original.id)}`,
                    );
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }
                },
              }}
            />
          ),
        ),
        size: 200,
      },
      {
        header: 'UUID',
        accessorKey: 'id',
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell<Login>(({ row }) => (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              width: '100%',
              '& .uuid-copy-button': {
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 120ms ease',
              },
              '&:hover .uuid-copy-button, &:focus-within .uuid-copy-button': {
                opacity: 1,
                pointerEvents: 'auto',
              },
            }}
          >
            <UserUuidValue uuid={row.original.id} shortValue={formatUuidShort(row.original.id)} />
            <CopyUuidButton uuid={row.original.id} className="uuid-copy-button" />
          </Box>
        )),
        size: 190,
      },
      {
        header: 'Ролі',
        id: 'roles',
        accessorFn: (row) => row.roles,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<Login, string>({
          items: ({ row }) => row.original.roles,
          renderItem: (role) => <EchoChip label={role} tone="neutral" />,
          measurementScope: 'admin-users:roles',
          getItemText: (role) => role,
        }),
        filterVariant: 'multi-select',
        filterSelectOptions: ROLE_OPTIONS,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        size: 260,
      },
      {
        header: 'Організм',
        id: 'organism',
        accessorFn: (row) => formatOptionalLabel(row.organismName),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOptionalLabel(row.original.organismName),
          fullValue: ({ row }) => formatOptionalLabel(row.original.organismName),
        }),
        size: 220,
      },
      {
        header: 'Напрямок',
        id: 'zone',
        accessorFn: (row) => formatOptionalLabel(row.sigintZoneName),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOptionalLabel(row.original.sigintZoneName),
          fullValue: ({ row }) => formatOptionalLabel(row.original.sigintZoneName),
        }),
        size: 200,
      },
      {
        header: 'Дельта логін',
        id: 'deltaLogin',
        accessorFn: (row) => formatOptionalLabel(row.deltaLogin),
        size: 180,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (row) => row.createdAt,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatDate(row.original.createdAt),
          fullValue: ({ row }) => formatDate(row.original.createdAt),
        }),
        size: 150,
      },
      {
        header: 'Статус',
        id: 'status',
        accessorFn: (row) => [getStatusInfo(row).label],
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => {
          const status = getStatusInfo(row.original);
          return (
            <div className="admin-user-status flex min-w-0 max-w-full flex-col items-center text-center leading-tight">
              <span className={`${status.colorClass} max-w-full whitespace-normal break-words`}>
                {status.label}
              </span>
              {status.details?.map((detail) => (
                <span
                  key={detail}
                  className="max-w-full whitespace-normal break-words text-xs text-muted-foreground"
                >
                  {detail}
                </span>
              ))}
            </div>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: STATUS_FILTER_OPTIONS,
        filterFn: (row, _columnId, filterValue) => matchesStatusFilter(row.original, filterValue),
        enableSorting: false,
        size: 200,
        muiTableBodyCellProps: () => ({
          sx: {
            ...CUSTOM_CELL_STYLES,
            justifyContent: 'center',
            minWidth: 0,
            whiteSpace: 'normal',
          },
        }),
      },
      {
        header: 'Нотатка',
        id: 'description',
        accessorFn: (row) => formatOptionalLabel(row.description),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOptionalLabel(row.original.description),
          fullValue: ({ row }) => formatOptionalLabel(row.original.description),
        }),
        size: 260,
      },
    ],
    [organism, onEdit],
  );
}
