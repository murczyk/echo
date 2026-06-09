import { describe, it, expect } from 'vitest';
import { escapeHtml } from './html-utils';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes < and >', () => {
    expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;');
  });

  it('escapes double and single quotes', () => {
    expect(escapeHtml('"quote"\'s')).toBe('&quot;quote&quot;&#39;s');
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('does not double-escape already escaped entities', () => {
    expect(escapeHtml('&amp; &lt; &gt; &quot; &#39;')).toBe('&amp;amp; &amp;lt; &amp;gt; &amp;quot; &amp;#39;');
  });
});
