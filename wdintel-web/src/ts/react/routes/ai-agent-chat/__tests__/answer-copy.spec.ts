/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import { answerPlainText, copyableAnswer } from '../answer-copy';

function rendered(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('#4182 copying a rendered answer', () => {
  it('keeps the answer text and drops controls, icons and app-only markup', () => {
    const root = rendered(
      [
        '<p class="x">Див. <a class="echo-chip" href="/rer-analysis-neo?m=7" target="_blank">',
        '<span class="echo-chip__label">26.09 11:23 Натрій</span></a> і ',
        '<button class="ai-map-chip" data-copy-text="Позиції"><span aria-hidden="true">img</span>мапа</button>',
        ' <span class="echo-chip"><svg aria-hidden="true"></svg>Звіт</span></p>',
        '<div class="ai-code-block"><div data-copy-skip><span>js</span><button>Копіювати</button></div>',
        '<pre><code class="language-js">let a = 1;\n</code></pre></div>',
        '<button data-copy-skip>Повторити завантаження джерел</button>',
      ].join(''),
    );

    const answer = copyableAnswer(root);

    expect(answer.innerHTML).toBe(
      `<p>Див. <a href="${window.location.origin}/rer-analysis-neo?m=7"><span>26.09 11:23 Натрій</span></a> і Позиції <span>Звіт</span></p>` +
        '<div><pre><code>let a = 1;\n</code></pre></div>',
    );
    expect(root.querySelector('[data-copy-skip]')).not.toBeNull();
    expect(answerPlainText(answer)).toBe('Див. 26.09 11:23 Натрій і Позиції Звіт\n\nlet a = 1;');
  });

  it('lays out headings, line breaks, nested and numbered lists, tasks and tables as text', () => {
    const answer = copyableAnswer(
      rendered(
        [
          '<h2>Підсумок</h2>\n',
          '<p>перший рядок<br>\nдругий рядок</p>\n',
          '<ul>\n<li>\n<p>пункт</p>\n<ul>\n<li>підпункт</li>\n</ul>\n</li>\n',
          '<li class="task-list-item"><input type="checkbox" checked disabled> зроблено</li>\n<li></li>\n</ul>\n',
          '<ol start="3">\n<li>третій</li>\n<li>четвертий</li>\n</ol>\n',
          '<ol start="0"><li>нульовий</li></ol>',
          '<table><thead><tr><th>Дата</th><th>Суть</th></tr></thead>\n',
          '<tbody><tr><td>30.07</td><td></td></tr><tr><td>31.07</td><td><code>x  y</code></td></tr></tbody></table>\n',
          '<pre><code>  відступ\n\n  збережено\n</code></pre>',
        ].join(''),
      ),
    );

    expect(answerPlainText(answer)).toBe(
      [
        'Підсумок',
        '',
        'перший рядок',
        'другий рядок',
        '',
        '• пункт',
        '  • підпункт',
        '• [x] зроблено',
        '•',
        '',
        '3. третій',
        '4. четвертий',
        '',
        '0. нульовий',
        '',
        'Дата\tСуть',
        '30.07\t',
        '31.07\tx y',
        '',
        '  відступ',
        '',
        '  збережено',
      ].join('\n'),
    );
    expect(answer.querySelector('table')?.getAttribute('style')).toBe('border-collapse:collapse');
    expect(answer.querySelector('td')?.getAttribute('style')).toBe(
      'border:1px solid;padding:4px 8px',
    );
    expect(answer.querySelector('ol')?.getAttribute('start')).toBe('3');
  });
});
