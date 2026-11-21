import Markdown, { type Components } from 'react-markdown';
import { isHttpUrl } from '../chat/searchActivity';

/**
 * Agent replies can now be shaped by third-party search results, so a prompt
 * injection could try to exfiltrate the guest's details through a URL. Images
 * render as their alt text (nothing is fetched without a click), and only
 * http(s) links survive; anything else loses its href.
 */
const components: Components = {
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

function safeUrl(url: string): string | undefined {
  return isHttpUrl(url) ? url : undefined;
}

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <Markdown urlTransform={safeUrl} components={components}>
      {children}
    </Markdown>
  );
}
