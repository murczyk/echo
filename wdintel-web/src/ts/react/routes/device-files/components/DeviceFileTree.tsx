import { Collapse, List } from '@mui/material';

import type { DeviceFileRoot, DeviceFileTreeEntry } from '../../../../../Bindings';
import type { DeviceFilesState } from '../use-device-files';
import { isDeviceArchive } from '../device-file-archive';
import { DeviceArchiveTree } from './DeviceArchiveTree';
import { DeviceFileTreePage } from './DeviceFileTreePage';
import { DeviceFileTreeRow } from './DeviceFileTreeRow';
import { DeviceFileIcon } from './DeviceFileIcon';

type DirectoryNode = {
  entryId: string;
  rootEntryId: string;
  name: string;
  scopeLabel: string;
};

type DirectoryProps = {
  node: DirectoryNode;
  depth: number;
  files: DeviceFilesState;
};

function joinScopeLabel(parent: string, name: string): string {
  return parent.endsWith('\\') ? `${parent}${name}` : `${parent}\\${name}`;
}

function toDirectoryNode(entry: DeviceFileTreeEntry, parent: DirectoryNode): DirectoryNode {
  return {
    entryId: entry.entryId,
    rootEntryId: parent.rootEntryId,
    name: entry.name,
    scopeLabel: joinScopeLabel(parent.scopeLabel, entry.name),
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
    <li className="min-w-0">
      <DeviceFileTreeRow
        name={entry.name}
        depth={depth}
        entryId={entry.entryId}
        selected={selected}
        hasContent={entry.hasContent}
        onClick={() => files.selectFile(entry)}
        icon={<DeviceFileIcon entry={entry} color={selected ? 'primary' : 'action'} />}
      />
    </li>
  );
}

function DeviceFileDirectory({ node, depth, files }: DirectoryProps) {
  const branch = files.tree.branches[node.entryId];
  const expanded = files.tree.expandedEntryIds.has(node.entryId);
  const selected = files.selectedDirectory === node.entryId;
  const childrenId = `device-file-tree-${node.entryId}-children`;

  return (
    <li className="min-w-0">
      <DeviceFileTreeRow
        name={node.name}
        depth={depth}
        selected={selected}
        expanded={expanded}
        childrenId={childrenId}
        label={`Відкрити папку ${node.name}`}
        toggleLabel={`${expanded ? 'Згорнути' : 'Розгорнути'} каталог ${node.name}`}
        onToggle={() => files.tree.toggleDirectory(node.entryId)}
        onClick={() => {
          if (!expanded) files.tree.toggleDirectory(node.entryId);
          files.openDirectory(node.entryId);
        }}
        icon={<DeviceFileIcon entry={{ kind: 'directory', name: node.name }} expanded={expanded} />}
      />

      <Collapse in={expanded} timeout="auto" unmountOnExit id={childrenId}>
        <List component="ul" dense disablePadding>
          {branch?.entries.map((entry) =>
            entry.kind === 'directory' ? (
              <DeviceFileDirectory
                key={entry.entryId}
                node={toDirectoryNode(entry, node)}
                depth={depth + 1}
                files={files}
              />
            ) : isDeviceArchive(entry) ? (
              <DeviceArchiveTree
                key={`${entry.entryId}/${entry.revision}/${files.archiveEpoch}`}
                deviceId={files.deviceId}
                file={entry}
                filters={{
                  tagIds: files.tagFilter.tagIds,
                  tagMatch: files.tagFilter.tagMatch,
                  untagged: files.tagFilter.untagged,
                  hasContent: files.contentFilter,
                  filters: files.appliedListingFilters,
                }}
                depth={depth + 1}
                selectedEntryId={
                  files.selectedFile?.entryId ?? files.selectedDirectory ?? undefined
                }
                expandedEntryIds={files.tree.expandedEntryIds}
                revealedBranches={files.tree.branches}
                onSelectFile={files.selectFile}
                onOpenDirectory={files.openDirectory}
                onAccessDenied={files.clearSelectedFile}
              />
            ) : (
              <DeviceFileRow key={entry.entryId} entry={entry} depth={depth + 1} files={files} />
            ),
          )}
          {branch?.nextCursor &&
          !branch.loading &&
          !branch.refreshing &&
          !branch.loadingMore &&
          !branch.error &&
          !branch.loadMoreError ? (
            <DeviceFileTreePage
              cursor={branch.nextCursor}
              onLoadMore={() => void files.tree.loadMoreBranch(node.entryId)}
            />
          ) : null}
        </List>
      </Collapse>
    </li>
  );
}

function rootToNode(root: DeviceFileRoot): DirectoryNode {
  return {
    entryId: root.entryId,
    rootEntryId: root.entryId,
    name: root.name,
    scopeLabel: root.name,
  };
}

export function DeviceFileTree({ files }: { files: DeviceFilesState }) {
  return (
    <div
      className="w-max min-w-full [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-0"
      data-testid="device-files-tree"
      aria-busy={files.tree.refreshing}
    >
      <List component="ul" dense disablePadding aria-label="Синхронізовані файлові корені">
        {files.roots.map((root) => (
          <DeviceFileDirectory key={root.entryId} node={rootToNode(root)} depth={0} files={files} />
        ))}
      </List>
    </div>
  );
}
