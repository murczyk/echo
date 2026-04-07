import { Alert, Box, Stack } from '@mui/material';

import { TableContentState } from '../../components/TableContentState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  TableStateProvider,
} from '../../components/mui-customized/table/table-state-provider';
import {
  DEFAULT_GOI_KNOWLEDGE_COLUMN_ORDER,
  DEFAULT_GOI_KNOWLEDGE_COLUMN_VISIBILITY,
  GoiKnowledgeTable,
} from './GoiKnowledgeTable';
import { useGoiKnowledgePage } from './use-goi-knowledge-page';

function GoiKnowledgePageBody() {
  const page = useGoiKnowledgePage();

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
          title="ГОІ: інформованість"
          titleInfo="Імпортовані з усіх доступних серверів ГОІ записи інформованості для поточного користувача."
          withGlobalTextFilter
          hideGlobalTextFilter={page.status !== 'success' && page.rows.length === 0}
          internalActionsDisabled={page.status !== 'success' && page.rows.length === 0}
        />

        {page.notice ? <Alert severity={page.notice.kind}>{page.notice.text}</Alert> : null}

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
            errorMessage={page.errorMessage || 'Помилка завантаження інформованості'}
          >
            <div className="flex w-full min-w-0 flex-1 min-h-0">
              <GoiKnowledgeTable
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

export function GoiKnowledgePage() {
  return (
    <TableStateProvider
      tableId="goi-knowledge"
      defaultColumnOrder={DEFAULT_GOI_KNOWLEDGE_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_GOI_KNOWLEDGE_COLUMN_VISIBILITY}
      defaultSorting={[{ id: 'sourceKnowledgeId', desc: true }]}
    >
      <GoiKnowledgePageBody />
    </TableStateProvider>
  );
}
