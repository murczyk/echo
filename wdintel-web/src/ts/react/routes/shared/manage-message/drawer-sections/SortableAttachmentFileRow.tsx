import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { useMediaQuery, useTheme } from '@mui/material';
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { AttachmentFileRow } from '../../../../components/AttachmentPickerUi';
import { PowerIconButton } from '../../../../components/PowerIconButton';

const attachmentCollisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

export function AttachmentSortContext({
  ids,
  busy,
  onReorder,
  children,
}: {
  ids: string[];
  busy: boolean;
  onReorder: (id: string, targetId: string) => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [draggedAttachment, setDraggedAttachment] = useState<ComponentProps<
    typeof AttachmentFileRow
  > | null>(null);
  useEffect(() => {
    if (!draggedAttachment) return;
    const preventEditorEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    document.addEventListener('keydown', preventEditorEscape, true);
    return () => document.removeEventListener('keydown', preventEditorEscape, true);
  }, [draggedAttachment]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: 'auto',
    }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={attachmentCollisionDetection}
      onDragStart={({ active }) => setDraggedAttachment(active.data.current?.attachment ?? null)}
      onDragCancel={() => setDraggedAttachment(null)}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            'Щоб змінити порядок вкладення, натисніть пробіл або Enter. Стрілками вгору та вниз оберіть позицію. Натисніть пробіл або Enter для підтвердження, Escape для скасування.',
        },
        announcements: {
          onDragStart: () => 'Вкладення взято для переміщення.',
          onDragOver: ({ over }) =>
            over ? `Позиція ${ids.indexOf(String(over.id)) + 1} із ${ids.length}.` : undefined,
          onDragEnd: ({ active, over }) =>
            over && active.id !== over.id
              ? `Вкладення переміщено на позицію ${ids.indexOf(String(over.id)) + 1} із ${ids.length}.`
              : 'Порядок вкладень не змінено.',
          onDragCancel: () => 'Переміщення скасовано. Порядок вкладень не змінено.',
        },
      }}
      onDragEnd={({ active, over }) => {
        setDraggedAttachment(null);
        const id = String(active.id);
        const targetId = over ? String(over.id) : null;
        if (!busy && targetId && id !== targetId && ids.includes(id) && ids.includes(targetId)) {
          onReorder(id, targetId);
        }
      }}
    >
      {draggedAttachment ? <style>{'body, body * { cursor: grabbing !important; }'}</style> : null}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-echo-xs">{children}</div>
      </SortableContext>
      {createPortal(
        <DragOverlay
          className="pointer-events-none"
          zIndex={theme.zIndex.modal}
          dropAnimation={reduceMotion ? null : undefined}
          transition={reduceMotion ? 'none' : undefined}
        >
          {draggedAttachment ? (
            <div
              ref={(element) => element?.setAttribute('inert', '')}
              aria-hidden="true"
              data-attachment-drag-overlay=""
              className="rounded-echo-sm bg-echo-surface shadow-echo-md"
            >
              <AttachmentFileRow
                {...draggedAttachment}
                dragHandle={
                  <PowerIconButton
                    size="small"
                    tabIndex={-1}
                    sx={{ width: 24, height: 24, p: 0.5 }}
                  >
                    <DragIndicatorIcon sx={{ fontSize: 16 }} />
                  </PowerIconButton>
                }
              />
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

export function SortableAttachmentFileRow({
  sortableId,
  reorderable,
  ...props
}: ComponentProps<typeof AttachmentFileRow> & {
  sortableId: string;
  reorderable: boolean;
}) {
  const disabled = props.busy || !reorderable;
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sortableId,
    disabled,
    data: { attachment: props },
    transition: reduceMotion ? null : undefined,
  });
  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'opacity-0' : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <AttachmentFileRow
        {...props}
        dragHandle={
          reorderable ? (
            <PowerIconButton
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              size="small"
              aria-label={`Змінити порядок ${props.file.name}`}
              disabled={disabled}
              className="touch-none shrink-0"
              sx={{
                width: 24,
                height: 24,
                p: 0.5,
                cursor: disabled ? undefined : isDragging ? 'grabbing' : 'grab',
              }}
            >
              <DragIndicatorIcon sx={{ fontSize: 16 }} />
            </PowerIconButton>
          ) : undefined
        }
      />
    </div>
  );
}
