import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import {
  Box,
  CircularProgress,
  Collapse,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

import type { DeviceFileRoot, DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { DeviceAnalyticsTagBadges } from './DeviceAnalyticsTagBadges';
import type { DeviceFilesState } from '../use-device-files';
import type { DeviceFileTreeBranch } from '../use-device-file-tree';

const fileCountFormatter = new Intl.NumberFormat('uk-UA');

type DirectoryNode = {
  entryId: string;
  rootEntryId: string;
  name: string;
  scopeLabel: string;
  secondary: string | null;
};

type DirectoryProps = {
  node: DirectoryNode;
  depth: number;
  files: DeviceFilesState;
};

function joinScopeLabel(parent: string, name: string): string {
  return parent.endsWith('\\') ? `${parent}${name}` : `${parent}\\${name}`;
}

function fileCountDescription(fileCount: number): string {
  return `Файлів у каталозі та вкладених каталогах: ${fileCountFormatter.format(fileCount)}`;
}

function DirectoryFileCount({ fileCount }: { fileCount: number | null }) {
  if (fileCount === null) return null;
  const description = fileCountDescription(fileCount);

  return (
    <Tooltip title="Файлів у каталозі та вкладених каталогах">
      <Box aria-label={description} sx={{ flexShrink: 0, ml: 1, display: 'inline-flex' }}>
        <PowerChip
          label={fileCountFormatter.format(fileCount)}
          color="default"
          interactive={false}
          minWidth={32}
          sx={{ height: 22, fontVariantNumeric: 'tabular-nums' }}
        />
      </Box>
    </Tooltip>
  );
}

function toDirectoryNode(entry: DeviceFileTreeEntry, parent: DirectoryNode): DirectoryNode {
  return {
    entryId: entry.entryId,
    rootEntryId: parent.rootEntryId,
    name: entry.name,
    scopeLabel: joinScopeLabel(parent.scopeLabel, entry.name),
    secondary: null,
  };
}

function DeviceFileRow({
  entry,
  depth,
  files,
}: {
  entry: DeviceFileTreeEntry;
  depth: number;
  files: DeviceFilesState;
}) {
  const selected = files.selectedFile?.entryId === entry.entryId;
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
      <ListItemButton
        component="button"
        selected={selected}
        aria-pressed={selected}
        aria-description={entry.hasContent ? undefined : 'Контент файлу відсутній'}
        onClick={() => files.selectFile(entry)}
        className={`min-h-echo-control-md min-w-0 rounded-echo-sm! ${selected ? 'bg-echo-primary/15!' : ''} ${entry.hasContent ? '' : 'opacity-55'}`}
      >
        <Box sx={{ width: 36, flexShrink: 0 }} />
        <InsertDriveFileOutlinedIcon
          fontSize="small"
          color={selected ? 'primary' : 'action'}
          sx={{ mr: 1 }}
        />
        <ListItemText
          primary={
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Typography
                variant="body2"
                color={selected ? 'primary' : 'text.primary'}
                noWrap
                title={entry.name}
                sx={{ minWidth: 0 }}
              >
                {entry.name}
              </Typography>
              <DeviceAnalyticsTagBadges tags={entry.tags} />
            </Stack>
          }
          sx={{ minWidth: 0, my: 0 }}
        />
      </ListItemButton>
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

function DeviceFileDirectory({ node, depth, files }: DirectoryProps) {
  const branch = files.tree.branches[node.entryId];
  const expanded = files.tree.expandedEntryIds.has(node.entryId);
  const selected = files.searchScope?.entryId === node.entryId;
  const childrenId = `device-file-tree-${node.entryId}-children`;
  const subtreeFileCount = files.counts.countsByEntryId[node.entryId] ?? null;
  const subtreeFileCountDescription =
    subtreeFileCount === null ? null : fileCountDescription(subtreeFileCount);

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
          aria-expanded={expanded}
          aria-controls={childrenId}
          aria-label={`Вибрати каталог ${node.name} як область пошуку${
            subtreeFileCountDescription === null ? '' : `; ${subtreeFileCountDescription}`
          }`}
          onClick={() => {
            files.tree.toggleDirectory(node.entryId);
            files.selectSearchScope({
              entryId: node.entryId,
              rootEntryId: node.rootEntryId,
              label: node.scopeLabel,
            });
          }}
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
          <DirectoryFileCount fileCount={subtreeFileCount} />
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
              />
            ) : (
              <DeviceFileRow key={entry.entryId} entry={entry} depth={depth + 1} files={files} />
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
    secondary: 'Windows',
  };
}

export function DeviceFileTree({ files }: { files: DeviceFilesState }) {
  return (
    <div
      className="min-w-0 py-echo-xs"
      data-testid="device-files-tree"
      aria-busy={files.tree.refreshing}
    >
      {files.counts.loading ? (
        <div className="flex justify-end px-echo-sm pb-echo-sm">
          <CircularProgress size={16} aria-label="Завантаження кількості файлів" />
        </div>
      ) : null}
      {files.counts.error ? (
        <div className="px-echo-sm pb-echo-sm">
          <PowerAlert
            severity="warning"
            autoHideDuration={null}
            action={
              <PowerButton size="small" onClick={files.counts.retry}>
                Повторити
              </PowerButton>
            }
          >
            {files.counts.error.message}
          </PowerAlert>
        </div>
      ) : null}
      <List component="ul" dense disablePadding aria-label="Синхронізовані файлові корені">
        {files.roots.map((root) => (
          <DeviceFileDirectory key={root.entryId} node={rootToNode(root)} depth={0} files={files} />
        ))}
      </List>
    </div>
  );
}
