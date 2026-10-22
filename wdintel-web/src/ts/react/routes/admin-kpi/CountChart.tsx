import { useTheme } from '@mui/material/styles';
import { useEffect, useRef, useState } from 'react';
import type { ECharts } from 'echarts';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import type { CountRow } from './helpers';

export function CountChart({
  title,
  rows,
  description,
}: {
  title: string;
  rows: CountRow[];
  description?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const colors = theme.echo.color[theme.palette.mode];
  const { notify } = usePowerSnackbar();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element || !rows.some((row) => row.count > 0)) return;
    let cancelled = false;
    let chart: ECharts | undefined;
    const observer = new ResizeObserver(() => chart?.resize());
    observer.observe(element);
    setFailed(false);

    import('echarts')
      .then((echarts) => {
        if (cancelled) return;
        chart = echarts.init(element, undefined, { renderer: 'svg' });
        const visibleRows = rows.slice(0, 10);
        chart.setOption({
          animation: false,
          textStyle: { color: colors.text },
          grid: { left: 8, right: 40, top: 8, bottom: 24, containLabel: true },
          xAxis: {
            type: 'value',
            minInterval: 1,
            axisLabel: { color: colors.text },
            splitLine: { lineStyle: { color: colors.border } },
          },
          yAxis: {
            type: 'category',
            inverse: true,
            data: visibleRows.map((row) => row.label),
            axisLabel: { color: colors.text, width: 125, overflow: 'truncate' },
            axisLine: { lineStyle: { color: colors.border } },
            axisTick: { show: false },
          },
          series: [
            {
              type: 'bar',
              data: visibleRows.map((row) => row.count),
              itemStyle: { color: colors.primary },
              label: { show: true, position: 'right', color: colors.text },
            },
          ],
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        notify({ severity: 'error', message: `Не вдалося побудувати графік «${title}».` });
      });

    return () => {
      cancelled = true;
      observer.disconnect();
      chart?.dispose();
    };
  }, [rows, colors, notify, title, attempt]);

  return (
    <section
      aria-label={title}
      className="min-w-0 rounded-echo-lg border border-echo-border bg-echo-surface p-echo-lg"
    >
      <h2 className="m-0 text-echo-lg font-semibold">{title}</h2>
      {description && <p className="mt-echo-sm text-echo-sm">{description}</p>}
      {rows.some((row) => row.count > 0) ? (
        <>
          <div ref={host} aria-hidden="true" className="h-64 w-full" hidden={failed} />
          {failed && (
            <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
              Графік недоступний. Значення наведено в таблиці.
              <PowerButton onClick={() => setAttempt((value) => value + 1)}>
                Повторити графік
              </PowerButton>
            </PowerAlert>
          )}
          {rows.length > 10 && (
            <p className="text-echo-sm">На графіку — перші 10 груп. Повний список — у таблиці.</p>
          )}
        </>
      ) : (
        <p className="my-echo-md">Немає даних у вибраному розрізі.</p>
      )}
      <details className="mt-echo-md">
        <summary className="cursor-pointer">Точні значення: {title}</summary>
        <table className="mt-echo-sm w-full text-echo-sm">
          <caption className="sr-only">{title}: точні значення</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">
                Група
              </th>
              <th scope="col" className="text-right">
                Кількість
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="break-words py-echo-xs text-left font-normal">
                  {row.label}
                </th>
                <td className="text-right tabular-nums">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
