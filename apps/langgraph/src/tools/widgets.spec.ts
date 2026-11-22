import { interestPickerProps, kebab, widgetFor } from './widgets.js';

describe('interestPickerProps', () => {
  it('drops extras the standard list already has, and caps at three', () => {
    const props = interestPickerProps('Japan', [
      'Food & drink',
      'Onsen & hot springs',
      ' Temples ',
      'Anime',
      'Karaoke',
      '',
      42,
    ]);
    expect(props.success && props.data).toEqual({
      prompt: 'What should your time in Japan focus on?',
      extras: [
        { id: 'onsen-hot-springs', label: 'Onsen & hot springs' },
        { id: 'temples', label: 'Temples' },
        { id: 'anime', label: 'Anime' },
      ],
    });
  });

  it('kebab-cases labels like the Parlant agent', () => {
    expect(kebab('Fado music!')).toBe('fado-music');
    expect(kebab('***')).toBe('');
  });
});

describe('widgetFor', () => {
  it('builds an interest picker', () => {
    expect(
      widgetFor('suggest_interests', { destination: 'Lisbon', extras: [] }),
    ).toMatchObject({ name: 'InterestPicker', props: { selected: [] } });
  });

  it('rejects a picker without a destination', () => {
    expect(widgetFor('suggest_interests', { extras: [] })).toBeNull();
  });

  it('builds a valid brief', () => {
    expect(
      widgetFor('present_brief', {
        destination: 'Lisbon',
        purpose: 'a food tour',
        interests: [],
      }),
    ).toEqual({
      name: 'TripBrief',
      props: { destination: 'Lisbon', purpose: 'a food tour', interests: [] },
    });
  });

  it.each(['<UNKNOWN>', 'unknown', 'TBD', ''])(
    'rejects a brief with placeholder purpose %j',
    (purpose) => {
      expect(
        widgetFor('present_brief', { destination: 'Lisbon', purpose }),
      ).toBeNull();
    },
  );

  it('ignores other tools', () => {
    expect(widgetFor('web_search', { query: 'x' })).toBeNull();
  });
});
