import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { getContrastRatio, useTheme } from '@mui/material/styles';
import type { ECharts } from 'echarts';
import type { DailyMessageStatsRsp } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  chartColumns,
  chartColumnWidth,
  chartOption,
  chartScale,
  STATS_CHART_GRID,
} from './statistics-chart-options';

export function StatsChart({ data, byGroups }: { data: DailyMessageStatsRsp; byGroups: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<ECharts | null>(null);
  const scrolled = useRef(false);
  const theme = useTheme();
  const { notify } = usePowerSnackbar();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const scale = chartScale(data);
  const ticks = [4, 3, 2, 1, 0].map((step) => (scale.interval * step).toLocaleString('uk-UA'));
  const empty = !data.series.some((series) => series.points.some((point) => point.messages > 0));
  const current = useRef({ data, byGroups, theme, empty });
  current.current = { data, byGroups, theme, empty };
  const draw = useRef<() => void>(() => undefined);
  draw.current = () => {
    if (!instance.current || !host.current || !viewport.current) return;
    const { data, byGroups, theme, empty } = current.current;
    const element = host.current;
    const available = viewport.current.clientWidth;
    const mobile = window.innerWidth < 768;
    const minWidth =
      STATS_CHART_GRID.right +
      (data.days.length > 1
        ? data.days.length * (data.series.length + 2) * chartColumnWidth(data, mobile)
        : data.series.length * chartColumnWidth(data, mobile));
    const width = empty ? available : Math.max(available, minWidth);
    element.style.width = `${width}px`;
    if (
      instance.current.getWidth() !== width ||
      instance.current.getHeight() !== element.clientHeight
    )
      instance.current.resize({ width, height: element.clientHeight, silent: true });
    const bar = getComputedStyle(element).getPropertyValue('--message-statistics-bar').trim();
    const { black, white } = theme.palette.common;
    const inside = getContrastRatio(bar, white) >= getContrastRatio(bar, black) ? white : black;
    instance.current.setOption(
      chartOption(
        data,
        chartColumns(data, width, mobile),
        byGroups,
        mobile,
        element.clientHeight - STATS_CHART_GRID.top - STATS_CHART_GRID.bottom,
        {
          text: theme.palette.text.secondary,
          divider: theme.palette.divider,
          bar,
          inside,
          background: theme.palette.background.paper,
          tooltip: theme.palette.text.primary,
          font: theme.typography.fontFamily,
        },
      ),
      { replaceMerge: ['series', 'xAxis', 'yAxis'] },
    );
    if (!scrolled.current && !empty) {
      viewport.current.scrollLeft = viewport.current.scrollWidth;
      scrolled.current = true;
    }
  };
  useEffect(() => {
    let active = true;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    import('echarts')
      .then((echarts) => {
        if (!active || !host.current || !viewport.current) return;
        instance.current = echarts.init(host.current, undefined, { renderer: 'svg' });
        draw.current();
        setReady(true);
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => draw.current());
        });
        observer.observe(viewport.current);
      })
      .catch((reason) => {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : 'Не вдалося відобразити графік.';
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
    };
  }, [notify]);
  useLayoutEffect(() => {
    if (ready) draw.current();
  }, [data, byGroups, theme, ready]);
  return (
    <>
      {error ? (
        <div className="message-statistics-chart-notices">
          <PowerAlert severity="error" dismissible={false}>
            {error}
          </PowerAlert>
        </div>
      ) : null}
      <p
        className="message-statistics-axis-title"
        style={{ visibility: empty ? 'hidden' : undefined }}
      >
        Повідомлень
      </p>
      <div
        className="message-statistics-chart-frame"
        data-empty={empty}
        style={
          {
            '--message-statistics-plot-top': `${STATS_CHART_GRID.top}px`,
            '--message-statistics-plot-bottom': `${STATS_CHART_GRID.bottom}px`,
            '--message-statistics-axis-width': `${Math.max(48, Math.max(...ticks.map((tick) => tick.length)) * 7 + 12)}px`,
          } as CSSProperties
        }
      >
        <div className="message-statistics-y-axis" aria-hidden="true">
          <div className="message-statistics-y-axis-ticks">
            {ticks.map((tick, index) => (
              <span key={index} style={{ top: `${index * 25}%` }}>
                {tick}
              </span>
            ))}
          </div>
        </div>
        <div
          ref={viewport}
          className="message-statistics-chart-viewport"
          role="region"
          aria-label="Прокручування графіка"
          tabIndex={0}
        >
          <div
            ref={host}
            className="message-statistics-chart"
            role="img"
            aria-label="Денна статистика повідомлень"
          />
        </div>
      </div>
    </>
  );
}
