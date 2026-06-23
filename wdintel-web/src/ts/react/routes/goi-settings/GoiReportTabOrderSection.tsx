import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';

import type { GoiReportTabOrderItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import {
  GoiUserIntegration,
  fetchGoiReportTabOrder,
  updateGoiReportTabOrder,
} from '../../services/api/goi-settings';

type ReportOrderScope = {
  key: string;
  label: string;
  integrationId: number | null;
};

type Props = {
  integrations: GoiUserIntegration[];
  isAdmin: boolean;
};

type SortableReportTabOrderItemProps = {
  item: GoiReportTabOrderItem;
  position: number;
  disabled: boolean;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function uniqueIdentifierToNumber(id: UniqueIdentifier): number {
  return typeof id === 'number' ? id : Number(id);
}

function sequence(items: GoiReportTabOrderItem[]): number[] {
  return items.map((item) => item.aorId);
}

function sequencesEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function integrationScopeLabel(integration: GoiUserIntegration): string {
  return integration.serverLabel || integration.ownerOrganismName || `ГОІ ${integration.id}`;
}

function buildScopes(isAdmin: boolean, integrations: GoiUserIntegration[]): ReportOrderScope[] {
  const integrationScopes = integrations.map((integration) => ({
    key: `integration:${integration.id}`,
    label: integrationScopeLabel(integration),
    integrationId: integration.id,
  }));

  if (!isAdmin) return integrationScopes;

  return [
    {
      key: 'global',
      label: 'Типовий порядок',
      integrationId: null,
    },
    ...integrationScopes,
  ];
}

function SortableReportTabOrderItem(props: SortableReportTabOrderItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.item.aorId,
    disabled: props.disabled,
  });

  return (
    <Box
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: '44px minmax(0, 1fr) 56px',
        alignItems: 'center',
        minHeight: 52,
        border: 1,
        borderColor: isDragging ? 'primary.main' : 'divider',
        bgcolor: 'background.paper',
        opacity: isDragging ? 0.82 : 1,
        boxShadow: isDragging ? 2 : 0,
      }}
    >
      <Tooltip title="Перетягнути">
        <span>
          <IconButton
            size="small"
            disabled={props.disabled}
            aria-label={`Перемістити ${props.item.aorName}`}
            sx={{
              mx: 0.5,
              cursor: props.disabled ? 'default' : 'grab',
              touchAction: 'none',
            }}
            {...attributes}
            {...listeners}
          >
            <DragIndicatorIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Typography variant="body2" sx={{ minWidth: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>
        {props.item.aorName}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'right', pr: 1.5 }}>
        {props.position}
      </Typography>
    </Box>
  );
}

export function GoiReportTabOrderSection(props: Props) {
  const scopes = React.useMemo(
    () => buildScopes(props.isAdmin, props.integrations),
    [props.integrations, props.isAdmin],
  );
  const [activeScopeKey, setActiveScopeKey] = React.useState('');
  const [items, setItems] = React.useState<GoiReportTabOrderItem[]>([]);
  const [initialItems, setInitialItems] = React.useState<GoiReportTabOrderItem[]>([]);
  const [loadStatus, setLoadStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = React.useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const activeScope = React.useMemo(
    () => scopes.find((scope) => scope.key === activeScopeKey) ?? scopes[0] ?? null,
    [activeScopeKey, scopes],
  );
  const isDirty = React.useMemo(
    () => !sequencesEqual(sequence(items), sequence(initialItems)),
    [initialItems, items],
  );

  React.useEffect(() => {
    if (scopes.length === 0) {
      setActiveScopeKey('');
      return;
    }
    if (!scopes.some((scope) => scope.key === activeScopeKey)) {
      setActiveScopeKey(scopes[0].key);
    }
  }, [activeScopeKey, scopes]);

  React.useEffect(() => {
    if (!activeScope) {
      setItems([]);
      setInitialItems([]);
      setLoadStatus('idle');
      return;
    }

    const abortController = new AbortController();
    setLoadStatus('loading');
    setLoadError(null);
    setSaveError(null);
    setSaveSuccess(null);

    void fetchGoiReportTabOrder(activeScope.integrationId, abortController.signal)
      .then((nextItems) => {
        if (abortController.signal.aborted) return;
        setItems(nextItems);
        setInitialItems(nextItems);
        setLoadStatus('ready');
      })
      .catch((error) => {
        if (abortController.signal.aborted || isAbortError(error)) return;
        setItems([]);
        setInitialItems([]);
        setLoadError(formatErrorMessage(error));
        setLoadStatus('error');
      });

    return () => abortController.abort();
  }, [activeScope?.key, activeScope?.integrationId]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || saveInProgress) return;

    const activeId = uniqueIdentifierToNumber(active.id);
    const overId = uniqueIdentifierToNumber(over.id);
    setSaveError(null);
    setSaveSuccess(null);
    setItems((currentItems) => {
      const oldIndex = currentItems.findIndex((item) => item.aorId === activeId);
      const newIndex = currentItems.findIndex((item) => item.aorId === overId);
      if (oldIndex < 0 || newIndex < 0) return currentItems;
      return arrayMove(currentItems, oldIndex, newIndex);
    });
  }

  function resetOrder() {
    setItems(initialItems);
    setSaveError(null);
    setSaveSuccess(null);
  }

  async function saveOrder() {
    if (!activeScope || !isDirty || saveInProgress || loadStatus !== 'ready') return;

    setSaveInProgress(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const updatedItems = await updateGoiReportTabOrder({
        integrationId: activeScope.integrationId,
        items: items.map((item, index) => ({
          ...item,
          orderForReport: (index + 1) * 10,
        })),
      });
      setItems(updatedItems);
      setInitialItems(updatedItems);
      setSaveSuccess('Порядок вкладок збережено');
    } catch (error) {
      setSaveError(formatErrorMessage(error));
    } finally {
      setSaveInProgress(false);
    }
  }

  if (scopes.length === 0) return null;

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" sx={{ fontWeight: 700 }}>
            Порядок вкладок у звіті ГОІ
          </Typography>

          {scopes.length > 1 ? (
            <Tabs
              value={activeScope?.key ?? scopes[0].key}
              onChange={(_, value: string) => setActiveScopeKey(value)}
              variant="scrollable"
              allowScrollButtonsMobile
              sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 44 }}
            >
              {scopes.map((scope) => (
                <Tab
                  key={scope.key}
                  value={scope.key}
                  label={scope.label}
                  sx={{ minHeight: 44 }}
                />
              ))}
            </Tabs>
          ) : null}

          {loadStatus === 'loading' ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : null}

          {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
          {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
          {saveSuccess ? <PowerAlert severity="success">{saveSuccess}</PowerAlert> : null}

          {loadStatus === 'ready' && items.length === 0 ? (
            <PowerAlert severity="info">Смуг для звіту не знайдено.</PowerAlert>
          ) : null}

          {loadStatus === 'ready' && items.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={items.map((item) => item.aorId)}
                strategy={verticalListSortingStrategy}
              >
                <Stack spacing={1}>
                  {items.map((item, index) => (
                    <SortableReportTabOrderItem
                      key={item.aorId}
                      item={item}
                      position={index + 1}
                      disabled={saveInProgress}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          ) : null}

          {loadStatus === 'ready' && items.length > 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, pt: 1 }}>
              <PowerButton
                variant="outlined"
                startIcon={<RestartAltIcon fontSize="small" />}
                onClick={resetOrder}
                disabled={!isDirty || saveInProgress}
              >
                Скинути
              </PowerButton>
              <PowerButton
                variant="contained"
                startIcon={
                  saveInProgress ? (
                    <CircularProgress color="inherit" size={16} />
                  ) : (
                    <SaveIcon fontSize="small" />
                  )
                }
                onClick={saveOrder}
                disabled={!isDirty || saveInProgress}
              >
                Зберегти
              </PowerButton>
            </Box>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
