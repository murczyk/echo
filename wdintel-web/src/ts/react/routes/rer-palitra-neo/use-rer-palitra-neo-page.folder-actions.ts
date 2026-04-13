import type { Dispatch, SetStateAction } from 'react';

import type { Palitra } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import { archivePalitraFolder, assignPalitraFolder, deletePalitraFolder, renamePalitraFolder } from '../../services/api/palitra';
import {
  buildAssignFolderPreview,
  buildFolderSubtreePreview,
  formatErrorMessage,
  getFolderNodeByPath,
  normalizeFolderPathForUi,
  validateFolderPath,
} from './helpers';
import type { FolderActionDialogState, FolderActionPreview, FolderTreeNode, PalitraRowView, UiStatus } from './types';

type SetState<T> = Dispatch<SetStateAction<T>>;

function buildFolderDialogState(args: {
  kind: FolderActionDialogState['kind'];
  folderPath: string;
  nextFolderPath: string;
  preview: FolderActionPreview;
  targetPalitraNames?: string[];
}): FolderActionDialogState {
  return {
    kind: args.kind,
    folderPath: args.folderPath,
    nextFolderPath: args.nextFolderPath,
    targetPalitraIds: args.preview.modifiableIds,
    targetPalitraNames: args.targetPalitraNames ?? [],
    preview: args.preview,
  };
}

type Props = {
  selectedPalitraIds: number[];
  palitraRows: PalitraRowView[];
  folderTree: FolderTreeNode[];
  folderDialogState: FolderActionDialogState | null;
  folderActionInFlight: boolean;
  folderActionsBlocked: boolean;
  bulkDeleteInFlight: boolean;
  inFlightArchiveId: number | null;
  inFlightDeleteId: number | null;
  setStatus: SetState<UiStatus>;
  setFolderDialogState: SetState<FolderActionDialogState | null>;
  setFolderActionInFlight: SetState<boolean>;
  setExpandedFolderPaths: SetState<string[]>;
  setSelectedPalitraIds: SetState<number[]>;
  setPalitraFolderLocally: (palitraIds: number[], nextFolderPath: string) => void;
  renameFolderLocally: (palitraIds: number[], fromFolderPath: string, nextFolderPath: string) => void;
  archiveFolderLocally: (palitraIds: number[]) => void;
  deleteFolderLocally: (palitraIds: number[]) => void;
  buildFolderActionStatus: (state: FolderActionDialogState, changedIds: number[]) => UiStatus;
};

export function createPalitraFolderActionHandlers(props: Props) {
  function openAssignFolderDialog(targetPalitraIds: number[], emptySelectionMessage: string, blockedSelectionMessage: string) {
    const preview = buildAssignFolderPreview(props.palitraRows, targetPalitraIds, '');
    if (preview.requestedCount === 0) {
      props.setStatus({ kind: 'warning', text: emptySelectionMessage });
      return;
    }

    if (preview.modifiableCount === 0) {
      props.setStatus({ kind: 'warning', text: blockedSelectionMessage });
      return;
    }

    const requestedIdSet = new Set(preview.requestedIds);
    const targetPalitraNames = props.palitraRows.filter((row) => requestedIdSet.has(row.id)).map((row) => row.name);

    props.setFolderDialogState(
      buildFolderDialogState({
        kind: 'assign',
        folderPath: '',
        nextFolderPath: '',
        preview,
        targetPalitraNames,
      }),
    );
  }

  function requestAssignFolder() {
    if (props.folderActionsBlocked || props.bulkDeleteInFlight || props.inFlightArchiveId !== null || props.inFlightDeleteId !== null) return;

    openAssignFolderDialog(
      props.selectedPalitraIds,
      'Оберіть хоча б одну палітру для переміщення.',
      'Серед вибраних палітр немає доступних для переміщення.',
    );
  }

  function requestAssignFolderForPalitra(palitra: Palitra) {
    if (props.folderActionsBlocked || props.bulkDeleteInFlight || props.inFlightArchiveId !== null || props.inFlightDeleteId !== null) return;

    openAssignFolderDialog([palitra.id], 'Не вдалося знайти палітру для переміщення.', 'Цю палітру зараз не можна перемістити.');
  }

  function openFolderSubtreeDialog(
    path: string,
    kind: Exclude<FolderActionDialogState['kind'], 'assign'>,
    emptyMessage: string,
  ) {
    if (props.folderActionsBlocked || props.bulkDeleteInFlight || props.inFlightArchiveId !== null || props.inFlightDeleteId !== null) return;
    const node = getFolderNodeByPath(props.folderTree, path);
    if (!node) return;

    const preview = buildFolderSubtreePreview(node);
    if (preview.requestedCount === 0) {
      props.setStatus({ kind: 'warning', text: emptyMessage });
      return;
    }

    props.setFolderDialogState(
      buildFolderDialogState({
        kind,
        folderPath: node.path,
        nextFolderPath: node.path,
        preview,
      }),
    );
  }

  function requestRenameFolder(path: string) {
    openFolderSubtreeDialog(path, 'rename', 'У цій папці немає палітр для перейменування.');
  }

  function requestArchiveFolder(path: string) {
    openFolderSubtreeDialog(path, 'archive', 'У цій папці немає палітр для архівації.');
  }

  function requestDeleteFolder(path: string) {
    openFolderSubtreeDialog(path, 'delete', 'У цій папці немає палітр для видалення.');
  }

  function cancelFolderAction() {
    if (props.folderActionInFlight) return;
    props.setFolderDialogState(null);
  }

  function setFolderDialogNextFolderPath(nextFolderPath: string) {
    props.setFolderDialogState((prev) => {
      if (!prev) return prev;
      if (prev.kind === 'assign') {
        const preview = buildAssignFolderPreview(props.palitraRows, prev.preview.requestedIds, nextFolderPath);
        return {
          ...prev,
          nextFolderPath,
          targetPalitraIds: preview.modifiableIds,
          preview,
        };
      }

      return {
        ...prev,
        nextFolderPath,
      };
    });
  }

  function toggleFolderExpanded(path: string) {
    props.setExpandedFolderPaths((prev) => (prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]));
  }

  async function handleAssignFolderConfirm(state: FolderActionDialogState) {
    const nextFolderPath = state.nextFolderPath.trim();
    if (nextFolderPath === '') {
      props.setStatus({ kind: 'warning', text: 'Вкажіть назву папки для переміщення.' });
      return;
    }

    const folderPathError = validateFolderPath(nextFolderPath);
    if (folderPathError) {
      props.setStatus({ kind: 'warning', text: folderPathError });
      return;
    }

    const changedIds = await assignPalitraFolder(state.targetPalitraIds, nextFolderPath);
    props.setPalitraFolderLocally(changedIds, nextFolderPath);
    props.setSelectedPalitraIds([]);
    props.setExpandedFolderPaths((prev) => {
      const normalizedFolderPath = normalizeFolderPathForUi(nextFolderPath);
      if (normalizedFolderPath === '' || prev.includes(normalizedFolderPath)) return prev;
      return [...prev, normalizedFolderPath];
    });
    props.setFolderDialogState(null);
    props.setStatus(props.buildFolderActionStatus(state, changedIds));
  }

  async function handleRenameFolderConfirm(state: FolderActionDialogState) {
    const nextFolderPath = state.nextFolderPath.trim();
    if (nextFolderPath === '') {
      props.setStatus({ kind: 'warning', text: 'Вкажіть нову назву папки.' });
      return;
    }

    const folderPathError = validateFolderPath(nextFolderPath);
    if (folderPathError) {
      props.setStatus({ kind: 'warning', text: folderPathError });
      return;
    }

    if (nextFolderPath === state.folderPath) {
      props.setStatus({ kind: 'warning', text: 'Нова назва папки збігається з поточною.' });
      return;
    }

    const changedIds = await renamePalitraFolder(state.folderPath, nextFolderPath);
    props.renameFolderLocally(changedIds, state.folderPath, nextFolderPath);
    props.setExpandedFolderPaths((prev) => {
      const normalizedFromPath = normalizeFolderPathForUi(state.folderPath);
      const normalizedNextPath = normalizeFolderPathForUi(nextFolderPath);
      const fromPrefix = normalizedFromPath + '/';

      return [
        ...new Set(
          prev.map((item) => {
            if (item === normalizedFromPath) return normalizedNextPath;
            if (item.startsWith(fromPrefix)) return normalizedNextPath + item.slice(normalizedFromPath.length);
            return item;
          }),
        ),
      ];
    });
    props.setFolderDialogState(null);
    props.setStatus(props.buildFolderActionStatus(state, changedIds));
  }

  async function handleArchiveFolderConfirm(state: FolderActionDialogState) {
    const changedIds = await archivePalitraFolder(state.folderPath);
    props.archiveFolderLocally(changedIds);
    props.setFolderDialogState(null);
    props.setStatus(props.buildFolderActionStatus(state, changedIds));
  }

  async function handleDeleteFolderConfirm(state: FolderActionDialogState) {
    const changedIds = await deletePalitraFolder(state.folderPath);
    props.deleteFolderLocally(changedIds);
    props.setExpandedFolderPaths((prev) => {
      const normalizedFolderPath = normalizeFolderPathForUi(state.folderPath);
      const folderPrefix = normalizedFolderPath + '/';
      return prev.filter((item) => item !== normalizedFolderPath && !item.startsWith(folderPrefix));
    });
    props.setFolderDialogState(null);
    props.setStatus(props.buildFolderActionStatus(state, changedIds));
  }

  async function confirmFolderAction() {
    const state = props.folderDialogState;
    if (!state || props.folderActionInFlight) return;

    props.setFolderActionInFlight(true);
    props.setStatus(null);

    try {
      if (state.kind === 'assign') {
        await handleAssignFolderConfirm(state);
      } else if (state.kind === 'rename') {
        await handleRenameFolderConfirm(state);
      } else if (state.kind === 'archive') {
        await handleArchiveFolderConfirm(state);
      } else {
        await handleDeleteFolderConfirm(state);
      }
    } catch (folderError) {
      if (isUnauthorizedError(folderError)) {
        window.location.assign('/login');
        return;
      }

      props.setStatus({ kind: 'error', text: 'Не вдалося виконати операцію з папкою: ' + formatErrorMessage(folderError) });
    } finally {
      props.setFolderActionInFlight(false);
    }
  }

  return {
    requestAssignFolder,
    requestAssignFolderForPalitra,
    requestRenameFolder,
    requestArchiveFolder,
    requestDeleteFolder,
    cancelFolderAction,
    confirmFolderAction,
    setFolderDialogNextFolderPath,
    toggleFolderExpanded,
  };
}
