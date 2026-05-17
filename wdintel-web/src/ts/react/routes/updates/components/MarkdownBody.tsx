import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';

import { rewriteRelativeMediaUrls } from '../markdown-helpers';
import { resolveReleaseMediaUrl } from '../releases.service';

interface MarkdownBodyProps {
  releaseId: string;
  markdown: string;
}

export function MarkdownBody({ releaseId, markdown }: MarkdownBodyProps) {
  const rewritten = rewriteRelativeMediaUrls(markdown, (href) =>
    resolveReleaseMediaUrl(releaseId, href),
  );

  return (
    <ReactMarkdown
      rehypePlugins={[rehypeRaw]}
      components={{
        p: ({ node: _node, ...props }) => (
          <p
            className="text-sm leading-relaxed text-[var(--color-text)]"
            {...props}
          />
        ),
        img: ({ node: _node, ...props }) => (
          <img
            className="w-full max-w-full rounded border border-[var(--color-border)]"
            loading="lazy"
            src={
              typeof props.src === 'string'
                ? props.src.startsWith('/')
                  ? props.src
                  : resolveReleaseMediaUrl(releaseId, props.src)
                : props.src
            }
            {...props}
          />
        ),
        video: ({ node: _node, ...props }) => (
          <video
            className="w-full rounded border border-[var(--color-border)] bg-black"
            controls
            preload="metadata"
            {...props}
          />
        ),
        a: ({ node: _node, ...props }) => (
          <a
            className="text-[var(--color-primary)] underline"
            target={props.href?.startsWith('http') ? '_blank' : undefined}
            rel={props.href?.startsWith('http') ? 'noreferrer' : undefined}
            {...props}
          />
        ),
      }}
    >
      {rewritten}
    </ReactMarkdown>
  );
}
