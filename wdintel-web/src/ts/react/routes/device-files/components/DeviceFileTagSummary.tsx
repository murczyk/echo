import { Tooltip } from '@mui/material';
import { useLayoutEffect, useRef, useState } from 'react';

import type { AnalyticsTag } from '../../../../../Bindings';
import { EchoChip } from '../../../components/EchoChip';
import { DEVICE_FILE_TABLE_VISIBLE_TAGS_LIMIT } from '../device-file-table-config';

export function DeviceFileTagSummary({ tags }: { tags: AnalyticsTag[] }) {
  const container = useRef<HTMLDivElement>(null);
  const measurement = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(1);
  const candidates = tags.slice(0, DEVICE_FILE_TABLE_VISIBLE_TAGS_LIMIT);
  const count = Math.min(visibleCount, candidates.length);
  const hiddenCount = tags.length - count;

  useLayoutEffect(() => {
    const viewport = container.current;
    const sizes = measurement.current;
    if (!viewport || !sizes) return;
    const update = () => {
      const children = Array.from(sizes.children);
      const limit = Math.min(tags.length, DEVICE_FILE_TABLE_VISIBLE_TAGS_LIMIT);
      const gap = Number.parseFloat(getComputedStyle(viewport).columnGap) || 0;
      let occupied = 0;
      let next = 1;
      for (let index = 0; index < limit; index++) {
        occupied += children[index].getBoundingClientRect().width + (index ? gap : 0);
        const overflow =
          tags.length > index + 1 ? children[limit + index].getBoundingClientRect().width + gap : 0;
        if (occupied + overflow > viewport.clientWidth) break;
        next = index + 1;
      }
      setVisibleCount(next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    observer?.observe(sizes);
    return () => observer?.disconnect();
  }, [tags]);

  if (!tags.length) return null;
  return (
    <Tooltip title={tags.map((tag) => tag.name).join(', ')} describeChild placement="bottom-start">
      <div
        ref={container}
        tabIndex={0}
        data-file-tag-summary
        className="relative flex min-w-0 items-center gap-echo-xs overflow-hidden whitespace-nowrap focus-visible:outline focus-visible:outline-echo-focus"
      >
        {candidates.slice(0, count).map((tag) => (
          <EchoChip
            key={tag.id}
            label={tag.name}
            tone="tag"
            className="min-w-0 shrink"
            labelClassName="block! truncate"
            data-file-tag-visible
          />
        ))}
        {hiddenCount > 0 && (
          <span className="shrink-0 tabular-nums" data-file-tag-overflow>
            +{hiddenCount}
          </span>
        )}
        <span
          ref={measurement}
          aria-hidden="true"
          className="pointer-events-none invisible absolute flex w-max items-center gap-echo-xs"
        >
          {candidates.map((tag) => (
            <EchoChip
              key={tag.id}
              label={tag.name}
              tone="tag"
              className="max-w-none! shrink-0"
              labelClassName="block!"
            />
          ))}
          {candidates.map((tag, index) => (
            <span key={tag.id} className="shrink-0 tabular-nums">
              {tags.length > index + 1 ? `+${tags.length - index - 1}` : ''}
            </span>
          ))}
        </span>
      </div>
    </Tooltip>
  );
}
