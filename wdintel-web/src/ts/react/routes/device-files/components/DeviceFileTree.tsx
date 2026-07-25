import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import {
  Box,
  CircularProgress,
  Collapse,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

import type { DeviceFileRoot, DeviceFileTreeEntry, PathSyntax } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceFilesState } from '../use-device-files';
import type { DeviceFileTreeBranch } from '../use-device-file-tree';

type DirectoryNode = {
  entryId: string;
  rootEntryId: string;
  name: string;
  scopeLabel: string;
  pathSyntax: PathSyntax;
  secondary: string | null;
};

type DirectoryProps = {
  node: DirectoryNode;
  depth: number;
  files: DeviceFilesState;
  canSync: boolean;
};

function joinScopeLabel(parent: string, name: string, pathSyntax: PathSyntax): string {
  const separator = pathSyntax === 'windows' ? '\\' : '/';
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

function toDirectoryNode(entry: DeviceFileTreeEntry, parent: DirectoryNode): DirectoryNode {
  return {
    entryId: entry.entryId,
    rootEntryId: parent.rootEntryId,
    name: entry.name,
    scopeLabel: joinScopeLabel(parent.scopeLabel, entry.name, parent.pathSyntax),
    pathSyntax: parent.pathSyntax,
    secondary: null,
  };
}

function DeviceFileRow({
  entry,
  depth,
  canSync,
  onSyncFile,
}: {
  entry: DeviceFileTreeEntry;
  depth: number;
  canSync: boolean;
  onSyncFile: (entry: DeviceFileTreeEntry) => void;
}) {
  const metadata = entry.mimeType ?? (entry.extension ? `.${entry.extension}` : null);

  return (
    <Box
      component="li"
      sx={{
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        pl: 1 + depth * 2,
        pr: 0.5,
        py: 0.25,
      }}
    >
      <Box sx={{ width: 36, flexShrink: 0 }} />
      <InsertDriveFileOutlinedIcon fontSize="small" color="action" sx={{ mr: 1 }} />
      <ListItemText
        primary={entry.name}
        secondary={metadata}
        primaryTypographyProps={{ noWrap: true, title: entry.name, variant: 'body2' }}
        secondaryTypographyProps={{ noWrap: true, title: metadata ?? undefined }}
        sx={{ minWidth: 0, my: 0 }}
      />
      {canSync ? (
        <Tooltip title="Синхронізувати файл">
          <PowerIconButton
            size="small"
            aria-label={`Синхронізувати файл ${entry.name}`}
            onClick={() => onSyncFile(entry)}
          >
            <SyncOutlinedIcon fontSize="small" />
          </PowerIconButton>
        </Tooltip>
      ) : null}
    </Box>
  );
}

function BranchStatus({
  node,
  branch,
  files,
  depth,
}: {
  node: DirectoryNode;
  branch: DeviceFileTreeBranch | undefined;
  files: DeviceFilesState;
  depth: number;
}) {
  if (branch?.loading) {
    return (
      <Box component="li" sx={{ py: 1, pl: 5 + depth * 2 }}>
        <CircularProgress size={20} aria-label={`Завантаження каталогу ${node.name}`} />
      </Box>
    );
  }

  if (branch?.error) {
    return (
      <Box component="li" sx={{ px: 1, pl: 2 + depth * 2, py: 0.5 }}>
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <PowerButton size="small" onClick={() => void files.tree.retryBranch(node.entryId)}>
              Повторити
            </PowerButton>
          }
        >
          {branch.error.message}
        </PowerAlert>
      </Box>
    );
  }

  if (branch && !branch.refreshing && branch.entries.length === 0) {
    return (
      <Typography
        component="li"
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', py: 0.75, pl: 5 + depth * 2, pr: 1 }}
      >
        Каталог порожній
      </Typography>
    );
  }

  return null;
}

function DeviceFileDirectory({ node, depth, files, canSync }: DirectoryProps) {
  const branch = files.tree.branches[node.entryId];
  const expanded = files.tree.expandedEntryIds.has(node.entryId);
  const selected = files.searchScope?.entryId === node.entryId;
  const childrenId = `device-file-tree-${node.entryId}-children`;

  return (
    <Box component="li" sx={{ minWidth: 0 }}>
      <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', pl: depth * 2, pr: 0.5 }}>
        <PowerIconButton
          size="small"
          aria-expanded={expanded}
          aria-controls={childrenId}
          aria-label={`${expanded ? 'Згорнути' : 'Розгорнути'} каталог ${node.name}`}
          onClick={() => files.tree.toggleDirectory(node.entryId)}
          sx={{ flexShrink: 0 }}
        >
          {expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </PowerIconButton>
        <ListItemButton
          selected={selected}
          aria-pressed={selected}
          aria-label={`Вибрати каталог ${node.name} як область пошуку`}
          onClick={() =>
            files.selectSearchScope({
              entryId: node.entryId,
              rootEntryId: node.rootEntryId,
              label: node.scopeLabel,
            })
          }
          sx={{ minWidth: 0, py: 0.5, px: 0.75, borderRadius: 1 }}
        >
          <ListItemIcon sx={{ minWidth: 32 }}>
            {expanded ? (
              <FolderOpenOutlinedIcon fontSize="small" />
            ) : (
              <FolderOutlinedIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText
            primary={node.name}
            secondary={node.secondary}
            primaryTypographyProps={{ noWrap: true, title: node.name, variant: 'body2' }}
            secondaryTypographyProps={{ noWrap: true, title: node.secondary ?? undefined }}
            sx={{ minWidth: 0, my: 0 }}
          />
          {branch?.refreshing ? (
            <CircularProgress size={16} aria-label="Оновлення каталогу" />
          ) : null}
        </ListItemButton>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit id={childrenId}>
        <List component="ul" dense disablePadding>
          <BranchStatus node={node} branch={branch} files={files} depth={depth} />
          {branch?.entries.map((entry) =>
            entry.kind === 'directory' ? (
              <DeviceFileDirectory
                key={entry.entryId}
                node={toDirectoryNode(entry, node)}
                depth={depth + 1}
                files={files}
                canSync={canSync}
              />
            ) : (
              <DeviceFileRow
                key={entry.entryId}
                entry={entry}
                depth={depth + 1}
                canSync={canSync}
                onSyncFile={files.sync.openSyncForEntry}
              />
            ),
          )}
          {branch?.loadMoreError ? (
            <Box component="li" sx={{ px: 1, pl: 2 + depth * 2, py: 0.5 }}>
              <PowerAlert
                severity="error"
                autoHideDuration={null}
                action={
                  <PowerButton
                    size="small"
                    onClick={() => void files.tree.loadMoreBranch(node.entryId)}
                  >
                    Повторити
                  </PowerButton>
                }
              >
                {branch.loadMoreError.message}
              </PowerAlert>
            </Box>
          ) : null}
          {branch?.nextCursor !== null && branch?.nextCursor !== undefined ? (
            <Box component="li" sx={{ py: 0.75, pl: 5 + depth * 2, pr: 1 }}>
              <PowerButton
                size="small"
                variant="text"
                disabled={branch.loadingMore}
                onClick={() => void files.tree.loadMoreBranch(node.entryId)}
              >
                {branch.loadingMore ? 'Завантаження…' : 'Показати ще'}
              </PowerButton>
            </Box>
          ) : null}
        </List>
      </Collapse>
    </Box>
  );
}

function rootToNode(root: DeviceFileRoot): DirectoryNode {
  return {
    entryId: root.entryId,
    rootEntryId: root.entryId,
    name: root.name,
    scopeLabel: root.name,
    pathSyntax: root.pathSyntax,
    secondary: root.pathSyntax === 'windows' ? 'Windows' : 'POSIX',
  };
}

export function DeviceFileTree({ files, canSync }: { files: DeviceFilesState; canSync: boolean }) {
  return (
    <Paper
      component="aside"
      variant="outlined"
      data-testid="device-files-tree-panel"
      aria-labelledby="device-files-tree-title"
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography id="device-files-tree-title" variant="subtitle1" fontWeight={600}>
          Файлова система
        </Typography>
        <Tooltip title="Оновити файлове дерево">
          <span>
            <PowerIconButton
              size="small"
              aria-label="Оновити файлове дерево"
              disabled={files.rootsLoading || files.rootsRefreshing || files.tree.refreshing}
              onClick={() => void files.refreshVisible()}
            >
              <RefreshIcon fontSize="small" />
            </PowerIconButton>
          </span>
        </Tooltip>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', py: 0.5 }} aria-busy={files.rootsLoading}>
        {files.rootsError ? (
          <Box sx={{ p: 1 }}>
            <PowerAlert
              severity="error"
              autoHideDuration={null}
              action={
                <PowerButton size="small" onClick={() => void files.reloadRoots()}>
                  Повторити
                </PowerButton>
              }
            >
              {files.rootsError.message}
            </PowerAlert>
          </Box>
        ) : null}
        {files.scopeNotice ? (
          <Box sx={{ px: 1, pb: 1 }}>
            <PowerAlert severity="warning" autoHideDuration={null}>
              {files.scopeNotice}
            </PowerAlert>
          </Box>
        ) : null}
        {files.rootsLoading ? (
          <Box sx={{ minHeight: 120, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={28} aria-label="Завантаження файлового дерева" />
          </Box>
        ) : files.roots.length === 0 && files.rootsError === null ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 3, textAlign: 'center' }}
          >
            Для пристрою ще немає синхронізованих файлів.
          </Typography>
        ) : (
          <List component="ul" dense disablePadding aria-label="Синхронізовані файлові корені">
            {files.roots.map((root) => (
              <DeviceFileDirectory
                key={root.entryId}
                node={rootToNode(root)}
                depth={0}
                files={files}
                canSync={canSync}
              />
            ))}
          </List>
        )}
      </Box>
    </Paper>
  );
}
