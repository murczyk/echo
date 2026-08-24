/**
 * @vitest-environment happy-dom
 */
// @test-scope parser: DOCX HTML sanitization and unsafe-link rejection fixture
import { describe, expect, it } from 'vitest';

import { sanitizeDocxHtml } from './sanitize-docx-html';

describe('sanitizeDocxHtml', () => {
  it('removes scripts, event handlers, and unsafe links', () => {
    const sanitized = sanitizeDocxHtml(
      '<div onclick="alert(1)" style="background:url(javascript:alert(1))"><script>alert(2)</script><a href="https://evil.test">link</a><img src="https://evil.test/image.png" onerror="alert(3)"></div>',
    );

    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('onclick=');
    expect(sanitized).not.toContain('onerror=');
    expect(sanitized).not.toContain('https://evil.test');
    expect(sanitized).not.toContain('style=');
  });
});
