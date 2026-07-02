import { Box, Stack } from '@mui/material';

import { TableContentState } from '../../components/TableContentState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  DEFAULT_GOI_ASSOCIATIONS_COLUMN_ORDER,
  DEFAULT_GOI_ASSOCIATIONS_COLUMN_VISIBILITY,
  GoiAssociationsTable,
} from './GoiAssociationsTable';
import { useGoiAssociationsPage } from './use-goi-associations-page';
import { PowerAlert } from '../../components/PowerAlert';

function GoiAssociationsPageBody() {
  const page = useGoiAssociationsPage();

  return (
    <Box
      className="w-full"
      sx={{
        height: { xs: 'auto', lg: '100%' },
        minHeight: 0,
        overflow: { xs: 'visible', lg: 'hidden' },
      }}
    >
      <Stack
        spacing={3}
        useFlexGap
        sx={{
          height: { xs: 'auto', lg: '100%' },
          minHeight: 0,
          overflow: { xs: 'visible', lg: 'hidden' },
        }}
      >
        <TablePageToolbar
          title="ГОІ: висновки"
          titleInfo="Імпортовані з усіх доступних серверів ГОІ висновки для поточного користувача."
          withGlobalTextFilter
          hideGlobalTextFilter={page.status !== 'success' && page.rows.length === 0}
          internalActionsDisabled={page.status !== 'success' && page.rows.length === 0}
        />

        {page.notice ? (
          <PowerAlert severity={page.notice.kind}>{page.notice.text}</PowerAlert>
        ) : null}

        <Box
          sx={{
            flex: 1,
            minHeight: { xs: 'auto', lg: 0 },
            minWidth: 0,
            display: 'flex',
          }}
        >
          <TableContentState
            status={page.status}
            errorMessage={page.errorMessage || 'Помилка завантаження висновків'}
          >
            <div className="flex w-full min-w-0 flex-1 min-h-0">
              <GoiAssociationsTable
                rows={page.rows}
                loading={page.status === 'loading'}
                refreshing={page.refreshing}
                loadingMore={page.loadingMore}
                showLoadMore={page.hasMore}
                hasActiveFilters={page.hasActiveFilters}
                onLoadMore={page.onLoadMore}
                onClearFilters={page.onClearFilters}
              />
            </div>
          </TableContentState>
        </Box>
      </Stack>
    </Box>
  );
}

export function GoiAssociationsPage() {
  return (
    <TableStateProvider
      tableId="goi-associations"
      defaultColumnOrder={DEFAULT_GOI_ASSOCIATIONS_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_GOI_ASSOCIATIONS_COLUMN_VISIBILITY}
      defaultSorting={[{ id: 'sourceAssociationId', desc: true }]}
    >
      <GoiAssociationsPageBody />
    </TableStateProvider>
  );
}
