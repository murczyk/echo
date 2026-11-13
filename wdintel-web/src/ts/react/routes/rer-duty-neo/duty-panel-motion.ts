import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { MessageItem } from './utils';
import { DUTY_SEARCH_PANEL_WIDTH_PX } from './duty-layout';

const DUTY_PANEL_EASING = 'cubic-bezier(.2,0,.38,.9)';

export function animateDutyElement(element: HTMLElement, frames: Keyframe[], duration: number) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (preference.matches || !element.animate) return null;
  const animation = element.animate(frames, { duration, easing: DUTY_PANEL_EASING });
  const finish = () => {
    if (preference.matches) animation.finish();
  };
  preference.addEventListener('change', finish);
  void animation.finished
    .catch(() => {})
    .finally(() => preference.removeEventListener('change', finish));
  return animation;
}

export function useDutyPanelPresence(open: boolean) {
  const [visible, setVisible] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = animationRef.current;
    const style = getComputedStyle(element);
    const opacity = previous?.playState === 'running' ? style.opacity : open ? '0' : '1';
    const transform =
      previous?.playState === 'running' ? style.transform : open ? 'translateX(-12px)' : 'none';
    previous?.cancel();
    if (open) setVisible(true);
    element.inert = !open;
    element.setAttribute('aria-hidden', String(!open));
    element.style.opacity = open ? '1' : '0';
    const animation = animateDutyElement(
      element,
      [
        { opacity, transform },
        { opacity: open ? 1 : 0, transform: open ? 'none' : 'translateX(-12px)' },
      ],
      open ? 180 : 140,
    );
    animationRef.current = animation;
    if (!open) {
      if (!animation) setVisible(false);
      else
        void animation.finished
          .then(() => {
            if (animationRef.current === animation) setVisible(false);
          })
          .catch(() => {});
    }
  }, [open]);
  useLayoutEffect(() => () => animationRef.current?.cancel(), []);
  return { ref, present: open || visible };
}

type DutyColumnSize = {
  open: boolean;
  baseWidth: number | undefined;
  width: number | undefined;
  layoutWidth: number | undefined;
};

function captureDutyColumnMotions(
  element: HTMLElement | null,
  before: DutyColumnSize,
  after: DutyColumnSize,
  animations: Map<HTMLElement, Animation>,
) {
  const targets: Array<[HTMLElement | null, Record<string, number>, Record<string, number>]> =
    element &&
    after.width !== undefined &&
    before.width !== undefined &&
    after.baseWidth !== undefined &&
    before.baseWidth !== undefined
      ? [
          [element, { width: before.width }, { width: after.width }],
          [
            element.querySelector<HTMLElement>('[data-duty-feed-main]'),
            { width: before.baseWidth, marginLeft: before.open ? DUTY_SEARCH_PANEL_WIDTH_PX : 0 },
            { width: after.baseWidth, marginLeft: after.open ? DUTY_SEARCH_PANEL_WIDTH_PX : 0 },
          ],
          [
            element.querySelector<HTMLElement>('[data-duty-search-panel]')?.parentElement ?? null,
            { width: before.open ? DUTY_SEARCH_PANEL_WIDTH_PX : 0 },
            { width: after.open ? DUTY_SEARCH_PANEL_WIDTH_PX : 0 },
          ],
        ]
      : [];
  return targets.flatMap(([target, from, to]) => {
    if (!target) return [];
    const running = animations.get(target)?.playState === 'running';
    const style = running ? getComputedStyle(target) : null;
    const frames = [from, to].map((values, index) =>
      Object.fromEntries(
        Object.entries(values).map(([property, value]) => [
          property,
          index === 0 && style ? style[property as 'width' | 'marginLeft'] : `${value}px`,
        ]),
      ),
    );
    return [{ target, frames }];
  });
}

export function useDutyColumnWidth(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  baseWidth: number | undefined,
  enabled: boolean,
) {
  const layoutWidth = ref.current?.parentElement?.clientWidth;
  const previous = useRef({ open, baseWidth, width: baseWidth, layoutWidth });
  const animations = useRef(new Map<HTMLElement, Animation>());
  useLayoutEffect(() => {
    const element = ref.current;
    const before = previous.current;
    const width = baseWidth ? baseWidth + (open ? DUTY_SEARCH_PANEL_WIDTH_PX : 0) : undefined;
    const containerWidth = element?.parentElement?.clientWidth;
    previous.current = { open, baseWidth, width, layoutWidth: containerWidth };
    const resizing = before.layoutWidth !== containerWidth;
    if (!enabled || resizing) {
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
      return;
    }
    if (before.open === open && before.baseWidth === baseWidth) return;
    const motions = captureDutyColumnMotions(element, before, previous.current, animations.current);
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
    const duration = open || (baseWidth ?? 0) < (before.baseWidth ?? 0) ? 180 : 140;
    for (const { target, frames } of motions) {
      const animation = animateDutyElement(target, frames, duration);
      if (animation) {
        animations.current.set(target, animation);
        void animation.finished
          .finally(() => {
            if (animations.current.get(target) === animation) animations.current.delete(target);
          })
          .catch(() => {});
      }
    }
  }, [ref, open, baseWidth, enabled, layoutWidth]);
  useLayoutEffect(
    () => () => {
      for (const animation of animations.current.values()) animation.cancel();
    },
    [],
  );
}

export function useDutyResultAppearance(
  resultsRef: RefObject<HTMLDivElement | null>,
  listRef: RefObject<HTMLDivElement | null>,
  items: MessageItem[],
  identity: string,
) {
  const previous = useRef({
    identity,
    ready: items.length > 0,
    ids: new Set(items.map(([id]) => id)),
  });
  const animations = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const results = resultsRef.current;
    const list = listRef.current;
    if (!results || !list) return;
    if (previous.current.identity !== identity) {
      for (const animation of animations.current) animation.cancel();
      previous.current = { identity, ready: false, ids: new Set() };
    }
    const targets: HTMLElement[] = [];
    if (items.length && !previous.current.ready) targets.push(results);
    else {
      const bounds = list.getBoundingClientRect();
      for (const row of results.querySelectorAll<HTMLElement>('[data-duty-search-row]')) {
        if (previous.current.ids.has(Number(row.dataset.dutySearchRow))) continue;
        const rect = row.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < bounds.bottom) targets.push(row);
      }
    }
    const duration = previous.current.ready ? 90 : 100;
    animations.current = animations.current.filter(
      (animation) => animation.playState === 'running',
    );
    for (const target of targets) {
      const animation = animateDutyElement(target, [{ opacity: 0 }, { opacity: 1 }], duration);
      if (animation) animations.current.push(animation);
    }
    previous.current = {
      identity,
      ready: previous.current.ready || items.length > 0,
      ids: new Set(items.map(([id]) => id)),
    };
  }, [identity, items, resultsRef, listRef]);
  useLayoutEffect(
    () => () => {
      for (const animation of animations.current) animation.cancel();
    },
    [],
  );
}
