import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import RemoveIcon from '@mui/icons-material/Remove';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiAgentActivityPresentation } from '../../../../Bindings';

export type RequestActivityItem = { text: string } | { toolId: string };

export type ToolActivity = {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary: string | null;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
  presentation?: AiAgentActivityPresentation | null;
};

export function RequestDuration({
  createdAt,
  finishedAt,
  active,
}: {
  createdAt: number;
  finishedAt?: number;
  active: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active, createdAt]);

  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - createdAt) / 1000));
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <Typography
      component="span"
      variant="caption"
      aria-label="Час виконання"
      sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
    >
      {duration}
    </Typography>
  );
}

function ActivityStatus({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running')
    return <CircularProgress size={12} color="inherit" aria-label="Виконується" />;
  const Icon = status === 'completed' ? CheckIcon : status === 'failed' ? CloseIcon : RemoveIcon;
  return (
    <Icon
      role="img"
      aria-label={
        status === 'completed' ? 'Завершено' : status === 'failed' ? 'Не вдалося' : 'Перервано'
      }
      sx={{ fontSize: 14 }}
    />
  );
}

function ActivityRow({ tool }: { tool: ToolActivity }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="flex-start"
      data-testid={`tool-activity-${tool.id}`}
      data-status={tool.status}
      sx={{ color: 'text.secondary' }}
    >
      <Box sx={{ width: 14, height: 20, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <ActivityStatus status={tool.status} />
      </Box>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {tool.name}
        {tool.status === 'failed' ? ` · не вдалося${tool.summary ? `: ${tool.summary}` : ''}` : ''}
        {tool.status === 'cancelled' ? ' · перервано' : ''}
      </Typography>
    </Stack>
  );
}

export function RequestActivity({
  tools,
  activity,
  active,
  completed,
  status,
  detail,
  duration,
  controls,
}: {
  tools: ToolActivity[];
  activity: RequestActivityItem[];
  active: boolean;
  completed: boolean;
  status: string;
  detail?: string | null;
  duration: ReactNode;
  controls?: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!active && detailsRef.current) detailsRef.current.open = false;
  }, [active]);

  if (completed && activity.length === 0) return null;
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const completedTools = tools.filter((tool) => tool.status === 'completed').length;
  return (
    <Box
      data-testid="request-progress"
      sx={{
        display: 'grid',
        gridTemplateColumns: controls
          ? 'minmax(0, max-content) max-content'
          : 'minmax(0, max-content)',
        columnGap: 1,
        width: '100%',
        color: 'text.secondary',
        '@keyframes requestActivityTitlePulse': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.5 },
        },
      }}
    >
      <Box
        component="details"
        ref={detailsRef}
        sx={{
          minWidth: 0,
          '&[open] .request-activity-chevron': { transform: 'rotate(90deg)' },
        }}
      >
        <Typography
          component="summary"
          variant="body2"
          tabIndex={activity.length > 0 ? 0 : -1}
          aria-disabled={activity.length === 0}
          sx={{
            display: 'block',
            minHeight: 28,
            cursor: activity.length > 0 ? 'pointer' : 'default',
            pointerEvents: activity.length > 0 ? 'auto' : 'none',
            listStyle: 'none',
            '&::-webkit-details-marker': { display: 'none' },
          }}
        >
          <Box
            component="span"
            sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 28 }}
          >
            <ChevronRightIcon
              className="request-activity-chevron"
              sx={{ fontSize: 16, flexShrink: 0, opacity: activity.length > 0 ? 1 : 0 }}
            />
            <Typography
              component="span"
              variant={completed ? 'caption' : 'body2'}
              role={completed ? undefined : 'status'}
              data-testid="request-activity-title"
              noWrap
              title={status}
              sx={{
                minWidth: 0,
                flexShrink: 1,
                fontWeight: active ? 500 : undefined,
                animation: active ? 'requestActivityTitlePulse 2s ease-in-out infinite' : 'none',
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }}
            >
              {status}
              {completed && tools.length > 0 ? ` · ${completedTools}/${tools.length}` : ''}
            </Typography>
            <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex' }}>
              {duration}
            </Box>
          </Box>
          {active && detail ? (
            <Typography
              component="span"
              variant="caption"
              data-testid="request-activity-detail"
              noWrap
              title={detail}
              sx={{ display: 'block', pl: 3 }}
            >
              {detail}
            </Typography>
          ) : null}
        </Typography>
        <Stack spacing={0.75} sx={{ pl: 1.5, mt: 0.5, borderLeft: 1, borderColor: 'divider' }}>
          {activity.map((item, index) => {
            if ('text' in item)
              return (
                <Typography key={`progress-${index}`} variant="body2">
                  {item.text}
                </Typography>
              );
            const tool = toolsById.get(item.toolId);
            return tool ? <ActivityRow key={tool.id} tool={tool} /> : null;
          })}
        </Stack>
      </Box>
      {controls ? <Box sx={{ alignSelf: 'start', flexShrink: 0 }}>{controls}</Box> : null}
    </Box>
  );
}
