import { describe, expect, it } from 'vitest';
import { parseSearchClient, toSearchClient } from '@travel-agent/shared';

describe('parseSearchClient', () => {
  it('accepts known clients, case- and space-insensitively', () => {
    expect(parseSearchClient('parlant')).toBe('parlant');
    expect(parseSearchClient(' LangGraph ')).toBe('langgraph');
    expect(parseSearchClient('inkeep')).toBe('inkeep');
  });

  it('rejects unknown, missing and non-string values', () => {
    expect(parseSearchClient('unknown')).toBeUndefined();
    expect(parseSearchClient('openai')).toBeUndefined();
    expect(parseSearchClient(undefined)).toBeUndefined();
    expect(parseSearchClient(['parlant'])).toBeUndefined();
    expect(parseSearchClient('')).toBeUndefined();
  });
});

describe('toSearchClient', () => {
  it('falls back for missing or invalid values', () => {
    expect(toSearchClient(undefined, 'unknown')).toBe('unknown');
    expect(toSearchClient('nope', 'inkeep')).toBe('inkeep');
    expect(toSearchClient('parlant', 'inkeep')).toBe('parlant');
  });
});
