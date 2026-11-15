import { HStack, Spinner, Tag, Text, Wrap } from '@chakra-ui/react';
import { sourceChips, type SearchActivity } from '../chat/searchActivity';

function hostname(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

/** "Searching the web for …" while a turn's searches run. */
export function SearchIndicator({ activity }: { activity: SearchActivity }) {
  const query = activity.queries.at(-1);
  return (
    <HStack gap="2" color="fg.muted" fontSize="sm">
      <Spinner size="xs" />
      <Text aria-live="polite">
        {query ? `Searching the web for “${query}”…` : 'Searching the web…'}
      </Text>
    </HStack>
  );
}

/** Up to six source chips under the reply; titles are tooltips, never HTML. */
export function SourceChips({ activity }: { activity: SearchActivity }) {
  const chips = sourceChips(activity);
  if (!chips.length) return null;
  return (
    <Wrap gap="2" aria-label="Sources">
      {chips.map((source) => (
        <Tag.Root key={source.url} size="sm" variant="surface" asChild>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            title={source.title}
          >
            <Tag.Label>{hostname(source.url)}</Tag.Label>
          </a>
        </Tag.Root>
      ))}
    </Wrap>
  );
}
