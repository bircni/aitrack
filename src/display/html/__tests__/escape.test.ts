import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../escape.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a>b')).toBe('a&gt;b');
  });

  it('escapes double-quote', () => {
    expect(escapeHtml('"value"')).toBe('&quot;value&quot;');
  });

  it('escapes single-quote', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapes all special chars in one string', () => {
    expect(escapeHtml('<a href="x" data-v=\'y\'>&</a>')).toBe(
      '&lt;a href=&quot;x&quot; data-v=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
