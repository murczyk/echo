import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import PaletteIcon from '@mui/icons-material/Palette';
import {
  Box,
  Checkbox,
  CircularProgress,
  IconButton,
  Typography,
  ThemeProvider,
} from '@mui/material';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { PalitraDetails } from '../maps/palitra-types';
import { useNeoMuiTheme } from './mui-theme';
import { PowerChip } from './components/PowerChip';
import { SearchInput } from './components/SearchInput';
import { ELLIPSIS } from './utils/misc';

type PalitraGroup = {
  key: string;
  name: string;
  sourceFileName: string | null;
  folderPath: string;
  colors: PalitraDetails[];
};

type FolderGroup = {
  key: string;
  path: string;
  name: string;
  palitras: PalitraGroup[];
};

type PalitrasOverlayProps = {
  palitras: PalitraDetails[];
  visibleIds: number[];
  loadState: 'idle' | 'loading' | 'success' | 'error';
  interactionDisabled: boolean;
  forceCollapsed?: boolean;
  onVisibleIdsChange: (visibleIds: number[]) => void;
};

const COLLAPSE_STORAGE_KEY = 'palitras-control-collapsed';
const MAP_CONTROL_GAP = 12;
function normalizeText(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeFolderPath(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function buildGroupKey(palitraDetails: PalitraDetails): string {
  const palitra = palitraDetails.palitra;
  if (typeof palitra.api_palitra_id === 'number') {
    return `api:${palitra.api_palitra_id}`;
  }
  return `id:${palitra.id}`;
}

function groupPalitras(palitras: PalitraDetails[]): PalitraGroup[] {
  const groupsByKey = new Map<string, PalitraGroup>();

  palitras.forEach((palitraDetails) => {
    const key = buildGroupKey(palitraDetails);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.colors.push(palitraDetails);
      return;
    }

    groupsByKey.set(key, {
      key,
      name: palitraDetails.palitra.name,
      sourceFileName: palitraDetails.palitra.source_file_name ?? null,
      folderPath: normalizeFolderPath(palitraDetails.palitra.folder),
      colors: [palitraDetails],
    });
  });

  return Array.from(groupsByKey.values()).sort((left, right) => left.name.localeCompare(right.name, 'uk'));
}

function splitGroupsByFolder(groups: PalitraGroup[]): { folderGroups: FolderGroup[]; rootGroups: PalitraGroup[] } {
  const rootGroups: PalitraGroup[] = [];
  const foldersByPath = new Map<string, FolderGroup>();

  groups.forEach((group) => {
    if (group.folderPath === '') {
      rootGroups.push(group);
      return;
    }

    const existing = foldersByPath.get(group.folderPath);
    if (existing) {
      existing.palitras.push(group);
      return;
    }

    foldersByPath.set(group.folderPath, {
      key: 'folder:' + group.folderPath,
      path: group.folderPath,
      name: group.folderPath,
      palitras: [group],
    });
  });

  const folderGroups = Array.from(foldersByPath.values())
    .map((folder) => ({
      ...folder,
      palitras: [...folder.palitras].sort((left, right) => left.name.localeCompare(right.name, 'uk')),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'uk'));

  return { folderGroups, rootGroups };
}

function perimeterPointsCount(palitraDetails: PalitraDetails): number {
  const geometry = palitraDetails.palitra.geometry;
  if (!geometry) {
    return 0;
  }
  const ringCount = geometry.perimeter_linear_ring?.length ?? 0;
  const linePoints = geometry.line_strings?.reduce((acc, line) => acc + line.length, 0) ?? 0;
  return ringCount + linePoints;
}

type PalitraGroupRowProps = {
  group: PalitraGroup;
  visibleIdsSet: Set<number>;
  interactionDisabled: boolean;
  nested?: boolean;
  onToggleGroup: (group: PalitraGroup) => void;
  onToggleColor: (palitraId: number) => void;
};

function isGroupSelectionEqual(group: PalitraGroup, prevSet: Set<number>, nextSet: Set<number>): boolean {
  for (let index = 0; index < group.colors.length; index += 1) {
    const colorId = group.colors[index].palitra.id;
    if (prevSet.has(colorId) !== nextSet.has(colorId)) {
      return false;
    }
  }
  return true;
}

const PalitraGroupRow = memo(function PalitraGroupRow(props: PalitraGroupRowProps) {
  const { group, visibleIdsSet, onToggleGroup, onToggleColor } = props;
  const [expanded, setExpanded] = useState(false);

  const groupIds = useMemo(
    () => group.colors.map((palitraDetails) => palitraDetails.palitra.id),
    [group.colors],
  );
  const selectedColorsCount = groupIds.filter((id) => visibleIdsSet.has(id)).length;
  const groupSelected = selectedColorsCount === groupIds.length && groupIds.length > 0;
  const groupPartiallySelected = selectedColorsCount > 0 && selectedColorsCount < groupIds.length;

  return (
    <Box className={`palitra-item ${props.nested ? 'palitra-item-nested' : ''}`}>
      <Box className={`palitra-main-row ${props.nested ? 'palitra-main-row-nested' : ''}`}>
        <Checkbox
          className="palitra-checkbox"
          checked={groupSelected}
          indeterminate={groupPartiallySelected}
          disabled={props.interactionDisabled}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onChange={() => onToggleGroup(group)}
          size="small"
        />
        <Box
          className="palitra-title-button"
          onClick={() => onToggleGroup(group)}
          title={group.sourceFileName ? `${group.name} (${group.sourceFileName})` : group.name}
        >
          <Typography className="palitra-name">{group.name}</Typography>
        </Box>
        <IconButton
          className={`palitra-expand-button ${expanded ? 'expanded' : ''}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setExpanded((prev) => !prev);
          }}
          aria-label={expanded ? 'Сховати кольори палітри' : `Показати всі кольори палітри (${group.colors.length})`}
          title={expanded ? 'Сховати кольори палітри' : `Показати всі кольори палітри (${group.colors.length})`}
          size="small"
          disabled={props.interactionDisabled}
        >
          <ExpandMoreIcon fontSize="small" />
        </IconButton>
      </Box>

      {expanded ? (
        <Box className="palitra-content">
          <Box className="palitra-colors-row">
            {group.colors.map((palitraDetails, index) => {
              const palitra = palitraDetails.palitra;
              const palitraId = palitra.id;
              const selected = visibleIdsSet.has(palitraId);
              const colorKey = `${group.key}-${palitraId}-${palitra.color_hex}-${index}`;

              return (
                <PowerChip
                  key={colorKey}
                  label={String(perimeterPointsCount(palitraDetails))}
                  selected={selected}
                  onClick={() => {
                    onToggleColor(palitraId);
                  }}
                  backgroundColor={palitra.color_hex}
                  autoTextContrast
                  interactive={!props.interactionDisabled}
                  size="medium"
                  minWidth={40}
                  labelPaddingX={0.8}
                  fontWeight={700}
                  selectedBorderColor="rgba(255,255,255,0.9)"
                  unselectedBorderColor="rgba(255,255,255,0.45)"
                  unselectedOpacity={0.7}
                  title={palitra.color_hex}
                  sx={{
                    transition: 'box-shadow 0.15s ease, transform 0.15s ease, opacity 0.15s ease',
                    boxShadow: selected
                      ? '0 0 0 2px rgba(255,255,255,0.95), 0 0 0 4px rgba(13,110,253,0.55)'
                      : 'none',
                    transform: selected ? 'translateY(-1px)' : 'none',
                  }}
                />
              );
            })}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}, (prevProps, nextProps) => {
  if (prevProps.group !== nextProps.group) {
    return false;
  }
  if (prevProps.interactionDisabled !== nextProps.interactionDisabled) {
    return false;
  }
  if (prevProps.onToggleGroup !== nextProps.onToggleGroup || prevProps.onToggleColor !== nextProps.onToggleColor) {
    return false;
  }
  return isGroupSelectionEqual(prevProps.group, prevProps.visibleIdsSet, nextProps.visibleIdsSet);
});

type FolderGroupRowProps = {
  folder: FolderGroup;
  visibleIdsSet: Set<number>;
  interactionDisabled: boolean;
  onToggleFolder: (folder: FolderGroup) => void;
  onToggleGroup: (group: PalitraGroup) => void;
  onToggleColor: (palitraId: number) => void;
};

const FolderGroupRow = memo(function FolderGroupRow(props: FolderGroupRowProps) {
  const { folder, visibleIdsSet, interactionDisabled, onToggleFolder, onToggleGroup, onToggleColor } = props;
  const [expanded, setExpanded] = useState(false);

  const folderColorIds = useMemo(
    () => folder.palitras.flatMap((group) => group.colors.map((palitraDetails) => palitraDetails.palitra.id)),
    [folder.palitras],
  );
  const selectedColorsCount = folderColorIds.filter((id) => visibleIdsSet.has(id)).length;
  const folderSelected = selectedColorsCount === folderColorIds.length && folderColorIds.length > 0;
  const folderPartiallySelected = selectedColorsCount > 0 && selectedColorsCount < folderColorIds.length;

  return (
    <Box className="palitra-item palitra-folder-item">
      <Box className="palitra-main-row palitra-folder-main-row">
        <Checkbox
          className="palitra-checkbox"
          checked={folderSelected}
          indeterminate={folderPartiallySelected}
          disabled={interactionDisabled}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onChange={() => {
            onToggleFolder(folder);
            setExpanded(!folderSelected);
          }}
          size="small"
        />
        <Box
          className="palitra-title-button palitra-folder-title-button"
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
          title={folder.path}
        >
          <Typography className="palitra-name">{folder.name}</Typography>
          <FolderIcon className="palitra-folder-icon" fontSize="small" />
        </Box>
        <IconButton
          className={`palitra-expand-button ${expanded ? 'expanded' : ''}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setExpanded((prev) => !prev);
          }}
          aria-label={expanded ? 'Сховати палітри папки' : `Показати палітри папки (${folder.palitras.length})`}
          title={expanded ? 'Сховати палітри папки' : `Показати палітри папки (${folder.palitras.length})`}
          size="small"
          disabled={interactionDisabled}
        >
          <ExpandMoreIcon fontSize="small" />
        </IconButton>
      </Box>

      {expanded ? (
        <Box className="palitra-folder-content">
          {folder.palitras.map((group) => (
            <PalitraGroupRow
              key={group.key}
              group={group}
              visibleIdsSet={visibleIdsSet}
              interactionDisabled={interactionDisabled}
              nested
              onToggleGroup={onToggleGroup}
              onToggleColor={onToggleColor}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  );
});

function PalitrasOverlay(props: PalitrasOverlayProps) {
  const { palitras, visibleIds, loadState, interactionDisabled, forceCollapsed, onVisibleIdsChange } = props;
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [isCollapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true';
    } catch (_error) {
      return false;
    }
  });
  const [filterValue, setFilterValue] = useState('');
  const [localVisibleIds, setLocalVisibleIds] = useState<number[]>(visibleIds);
  const [controlMaxHeight, setControlMaxHeight] = useState<number | null>(null);
  const localVisibleIdsRef = useRef<number[]>(visibleIds);

  useEffect(() => {
    setLocalVisibleIds(visibleIds);
    localVisibleIdsRef.current = visibleIds;
  }, [visibleIds]);

  const visibleIdsSet = useMemo(() => new Set(localVisibleIds), [localVisibleIds]);

  const applyVisibleIdsChange = useCallback(
    (nextVisibleIds: number[]) => {
      const normalized = Array.from(new Set(nextVisibleIds));
      localVisibleIdsRef.current = normalized;
      setLocalVisibleIds(normalized);
      onVisibleIdsChange(normalized);
    },
    [onVisibleIdsChange],
  );

  const palitraGroups = useMemo(() => groupPalitras(palitras), [palitras]);
  const { folderGroups, rootGroups } = useMemo(() => splitGroupsByFolder(palitraGroups), [palitraGroups]);

  const allColorIds = useMemo(() => {
    const ids = palitraGroups.flatMap((group) => group.colors.map((palitraDetails) => palitraDetails.palitra.id));
    return Array.from(new Set(ids));
  }, [palitraGroups]);

  const normalizedFilter = normalizeText(filterValue);
  const filteredData = useMemo(() => {
    if (normalizedFilter === '') {
      return {
        folders: folderGroups,
        rootPalitras: rootGroups,
      };
    }

    const folders = folderGroups
      .map((folder) => {
        const folderMatches = normalizeText(folder.name).includes(normalizedFilter);
        if (folderMatches) {
          return folder;
        }
        const matchedPalitras = folder.palitras.filter((group) => normalizeText(group.name).includes(normalizedFilter));
        if (matchedPalitras.length === 0) {
          return null;
        }
        return { ...folder, palitras: matchedPalitras };
      })
      .filter((folder): folder is FolderGroup => folder !== null);

    const rootPalitras = rootGroups.filter((group) => normalizeText(group.name).includes(normalizedFilter));

    return {
      folders,
      rootPalitras,
    };
  }, [folderGroups, normalizedFilter, rootGroups]);

  const filteredRowsCount = filteredData.folders.length + filteredData.rootPalitras.length;

  const allSelected = allColorIds.length > 0 && allColorIds.every((id) => visibleIdsSet.has(id));
  const someSelected = allColorIds.some((id) => visibleIdsSet.has(id));

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      } catch (_error) {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (forceCollapsed) {
      setCollapsed(true);
      return;
    }
    try {
      const saved = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      setCollapsed(saved === 'true');
    } catch (_error) {
      setCollapsed(false);
    }
  }, [forceCollapsed]);

  const toggleSelectAll = useCallback(() => {
    if (interactionDisabled) {
      return;
    }
    if (allSelected) {
      applyVisibleIdsChange([]);
      return;
    }
    applyVisibleIdsChange(allColorIds);
  }, [allColorIds, allSelected, applyVisibleIdsChange, interactionDisabled]);

  const toggleGroup = useCallback(
    (group: PalitraGroup) => {
      if (interactionDisabled) {
        return;
      }
      const groupIds = group.colors.map((palitraDetails) => palitraDetails.palitra.id);
      const groupIdsSet = new Set(groupIds);
      const currentVisibleIds = localVisibleIdsRef.current;
      const currentVisibleSet = new Set(currentVisibleIds);
      const allSelectedInGroup = groupIds.every((id) => currentVisibleSet.has(id));
      if (allSelectedInGroup) {
        const next = currentVisibleIds.filter((id) => !groupIdsSet.has(id));
        applyVisibleIdsChange(next);
        return;
      }
      const next = Array.from(new Set([...currentVisibleIds, ...groupIds]));
      applyVisibleIdsChange(next);
    },
    [applyVisibleIdsChange, interactionDisabled],
  );

  const toggleFolder = useCallback(
    (folder: FolderGroup) => {
      if (interactionDisabled) {
        return;
      }
      const folderIds = folder.palitras.flatMap((group) => group.colors.map((palitraDetails) => palitraDetails.palitra.id));
      const folderIdsSet = new Set(folderIds);
      const currentVisibleIds = localVisibleIdsRef.current;
      const currentVisibleSet = new Set(currentVisibleIds);
      const allSelectedInFolder = folderIds.every((id) => currentVisibleSet.has(id));
      if (allSelectedInFolder) {
        const next = currentVisibleIds.filter((id) => !folderIdsSet.has(id));
        applyVisibleIdsChange(next);
        return;
      }
      const next = Array.from(new Set([...currentVisibleIds, ...folderIds]));
      applyVisibleIdsChange(next);
    },
    [applyVisibleIdsChange, interactionDisabled],
  );

  const toggleColor = useCallback(
    (palitraId: number) => {
      if (interactionDisabled) {
        return;
      }
      const currentVisibleIds = localVisibleIdsRef.current;
      const currentVisibleSet = new Set(currentVisibleIds);
      if (currentVisibleSet.has(palitraId)) {
        applyVisibleIdsChange(currentVisibleIds.filter((id) => id !== palitraId));
        return;
      }
      applyVisibleIdsChange(Array.from(new Set([...currentVisibleIds, palitraId])));
    },
    [applyVisibleIdsChange, interactionDisabled],
  );

  const hasPalitras = palitras.length > 0;
  const canInteract = loadState === 'success' && hasPalitras;

  useLayoutEffect(() => {
    if (isCollapsed || !canInteract) {
      setControlMaxHeight(null);
      return undefined;
    }

    const measure = () => {
      const control = controlRef.current;
      if (!control) {
        return;
      }

      const mapRoot = control.closest('#analysis-map');
      if (!(mapRoot instanceof HTMLElement)) {
        setControlMaxHeight(null);
        return;
      }

      const controlRect = control.getBoundingClientRect();
      const settingsControl = mapRoot.querySelector('.map-settings-control-host');
      const settingsRect = settingsControl instanceof HTMLElement ? settingsControl.getBoundingClientRect() : null;
      const mapRect = mapRoot.getBoundingClientRect();
      const maxBottom = settingsRect ? settingsRect.top - MAP_CONTROL_GAP : mapRect.bottom - MAP_CONTROL_GAP;
      const nextMaxHeight = Math.floor(maxBottom - controlRect.top);

      setControlMaxHeight(nextMaxHeight > 0 ? nextMaxHeight : null);
    };

    measure();

    const mapRoot = controlRef.current?.closest('#analysis-map');
    const resizeObserver =
      mapRoot instanceof HTMLElement
        ? new ResizeObserver(() => {
            measure();
          })
        : null;

    if (resizeObserver && mapRoot instanceof HTMLElement) {
      resizeObserver.observe(mapRoot);
      const settingsControl = mapRoot.querySelector('.map-settings-control-host');
      if (settingsControl instanceof HTMLElement) {
        resizeObserver.observe(settingsControl);
      }
    }

    window.addEventListener('resize', measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [canInteract, filteredRowsCount, isCollapsed]);

  if (!canInteract) {
    const hintText = (() => {
      if (loadState === 'loading') {
        return `Палітри завантажуються${ELLIPSIS}`;
      }
      if (loadState === 'success' && !hasPalitras) {
        return 'Доступних палітр немає';
      }
      return 'Палітри недоступні: не вдалося завантажити список';
    })();

    return (
      <Box className="palitras-control collapsed">
        <Box className="palitras-control-header">
          <span title={hintText}>
            <IconButton
              className="palitras-palette-icon"
              aria-label={hintText}
              title={hintText}
              size="small"
              disabled
            >
              {loadState === 'loading' ? <CircularProgress size={16} thickness={5} /> : <PaletteIcon fontSize="small" />}
            </IconButton>
          </span>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      ref={controlRef}
      className={`palitras-control ${isCollapsed ? 'collapsed' : ''}`}
      sx={
        isCollapsed || controlMaxHeight === null
          ? undefined
          : {
              maxHeight: `${controlMaxHeight}px`,
            }
      }
    >
      <Box className="palitras-control-header">
        {isCollapsed ? (
          <IconButton
            className="palitras-palette-icon"
            onClick={toggleCollapsed}
            aria-label="Розгорнути список палітр"
            title="Розгорнути список палітр"
            size="small"
          >
            <PaletteIcon fontSize="small" />
          </IconButton>
        ) : (
          <>
            <Box className="palitras-header-row" onClick={toggleSelectAll}>
              <Checkbox
                className="palitra-checkbox"
                checked={allSelected}
                indeterminate={!allSelected && someSelected}
                disabled={interactionDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onChange={toggleSelectAll}
                size="small"
              />
              <Typography className="palitras-control-title">Палітри</Typography>
            </Box>
            <IconButton
              className="palitras-toggle-button"
              onClick={toggleCollapsed}
              aria-label="Згорнути список палітр"
              title="Згорнути список палітр"
              size="small"
            >
              <ExpandMoreIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Box>

      <Box
        className="palitras-control-filter-wrap"
        sx={{
          display: isCollapsed ? 'none' : 'block',
        }}
      >
        <SearchInput
          placeholder="Пошук"
          onSearch={setFilterValue}
          minWidth={260}
          disabled={interactionDisabled}
        />
      </Box>

      <Box className="palitras-control-list">
        {filteredRowsCount === 0 ? (
          <Typography className="palitras-control-empty">Палітри не знайдено</Typography>
        ) : (
          <>
            {filteredData.folders.map((folder) => (
              <FolderGroupRow
                key={folder.key}
                folder={folder}
                visibleIdsSet={visibleIdsSet}
                interactionDisabled={interactionDisabled}
                onToggleFolder={toggleFolder}
                onToggleGroup={toggleGroup}
                onToggleColor={toggleColor}
              />
            ))}
            {filteredData.rootPalitras.map((group) => (
              <PalitraGroupRow
                key={group.key}
                group={group}
                visibleIdsSet={visibleIdsSet}
                interactionDisabled={interactionDisabled}
                onToggleGroup={toggleGroup}
                onToggleColor={toggleColor}
              />
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}

function AnalysisMapPalitrasRoot(props: PalitrasOverlayProps) {
  const theme = useNeoMuiTheme();
  return (
    <ThemeProvider theme={theme}>
      <PalitrasOverlay {...props} />
    </ThemeProvider>
  );
}

class AnalysisMapPalitrasElement extends HTMLElement {
  private root: Root | null = null;
  private palitras: PalitraDetails[] = [];
  private visibleIds: number[] = [];
  private loadState: 'idle' | 'loading' | 'success' | 'error' = 'idle';
  private interactionDisabled = false;
  private forceCollapsed = false;
  private pendingUnmountHandle: number | null = null;

  connectedCallback() {
    if (this.pendingUnmountHandle !== null) {
      window.clearTimeout(this.pendingUnmountHandle);
      this.pendingUnmountHandle = null;
    }

    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.renderComponent();
  }

  disconnectedCallback() {
    this.scheduleRootUnmount();
  }

  setPalitras(palitras: PalitraDetails[]) {
    this.palitras = palitras;
    this.renderComponent();
  }

  setVisibleIds(visibleIds: number[]) {
    this.visibleIds = visibleIds;
    this.renderComponent();
  }

  setLoadState(loadState: 'idle' | 'loading' | 'success' | 'error') {
    this.loadState = loadState;
    this.renderComponent();
  }

  setInteractionDisabled(disabled: boolean) {
    this.interactionDisabled = disabled;
    this.renderComponent();
  }

  setCollapsed(collapsed: boolean) {
    this.forceCollapsed = collapsed;
    this.renderComponent();
  }

  private renderComponent() {
    if (!this.root) {
      return;
    }

    this.root.render(
      <AnalysisMapPalitrasRoot
        palitras={this.palitras}
        visibleIds={this.visibleIds}
        loadState={this.loadState}
        interactionDisabled={this.interactionDisabled}
        forceCollapsed={this.forceCollapsed}
        onVisibleIdsChange={(visibleIds) => {
          this.dispatchEvent(
            new CustomEvent('palitras-visible-ids-change', {
              detail: { visibleIds },
              bubbles: true,
              composed: true,
            }),
          );
        }}
      />,
    );
  }

  private scheduleRootUnmount() {
    if (this.pendingUnmountHandle !== null) {
      return;
    }

    const root = this.root;
    if (!root) {
      return;
    }

    this.pendingUnmountHandle = window.setTimeout(() => {
      this.pendingUnmountHandle = null;

      if (this.isConnected || this.root !== root) {
        return;
      }

      root.unmount();
      this.root = null;
    }, 0);
  }
}

if (!customElements.get('analysis-map-palitras')) {
  customElements.define('analysis-map-palitras', AnalysisMapPalitrasElement);
}
