import type { AriaAttributes, MouseEventHandler, ReactNode, Ref } from 'react';
import { forwardRef, memo } from 'react';

export type EchoChipTone = 'primary' | 'neutral' | 'tag';

type EchoChipProps = AriaAttributes & {
  label: ReactNode;
  href?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  selected?: boolean;
  tone?: EchoChipTone;
  title?: string;
  className?: string;
  labelClassName?: string;
  'data-testid'?: string;
  [key: `data-${string}`]: string | boolean | undefined;
};

const toneClassNames: Record<EchoChipTone, string> = {
  primary: 'echo-chip--primary',
  neutral: 'echo-chip--neutral',
  tag: 'echo-chip--tag',
};

export const EchoChip = memo(
  forwardRef<HTMLElement, EchoChipProps>(function EchoChip(
    {
      label,
      href,
      onClick,
      selected = false,
      tone = 'neutral',
      title,
      className,
      labelClassName,
      ...props
    },
    ref,
  ) {
    const classNames = ['echo-chip', toneClassNames[tone], className].filter(Boolean).join(' ');
    const content = (
      <span className={['echo-chip__label', labelClassName].filter(Boolean).join(' ')}>
        {label}
      </span>
    );
    const attributes = {
      ...props,
      title,
      'data-selected': selected ? 'true' : 'false',
      'data-interactive': href != null || onClick != null ? 'true' : 'false',
      className: classNames,
    };

    if (href != null) {
      return (
        <a ref={ref as Ref<HTMLAnchorElement>} href={href} {...attributes}>
          {content}
        </a>
      );
    }
    if (onClick != null) {
      return (
        <button ref={ref as Ref<HTMLButtonElement>} type="button" onClick={onClick} {...attributes}>
          {content}
        </button>
      );
    }
    return (
      <span ref={ref as Ref<HTMLSpanElement>} {...attributes}>
        {content}
      </span>
    );
  }),
);
