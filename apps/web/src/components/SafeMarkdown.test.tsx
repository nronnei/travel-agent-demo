import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from './SafeMarkdown';

const render = (text: string) =>
  renderToStaticMarkup(<SafeMarkdown>{text}</SafeMarkdown>);

describe('SafeMarkdown', () => {
  it('renders no images, so nothing is fetched without a click', () => {
    const html = render('Look ![x](https://evil.example/?q=secret) here');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('x');
  });

  it('drops javascript: and other non-http(s) links', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'vbscript:x',
      'mailto:a@b.c',
    ]) {
      const html = render(`[click](${url})`);
      expect(html).not.toContain('href');
      expect(html).toContain('click');
    }
  });

  it('opens http(s) links in a new tab without a referrer', () => {
    const html = render('[Festas](https://example.com/festas)');
    expect(html).toContain('href="https://example.com/festas"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});
