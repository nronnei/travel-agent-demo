import type { IntakeContext } from '@travel-agent/shared';
import { intakePrompt, plannerPrompt } from './prompts.js';

const empty: IntakeContext = {
  address: '',
  givenName: '',
  surname: '',
  prefix: '',
  destination: '',
  purpose: '',
  interests: '',
  briefConfirmed: 'no',
};
const full: IntakeContext = {
  ...empty,
  address: 'Dr Lima',
  givenName: 'Ana',
  destination: 'Lisbon',
  purpose: 'a food tour',
  interests: 'Food & drink',
  briefConfirmed: 'yes',
};

describe('prompts', () => {
  it('render with an empty intake', () => {
    expect(intakePrompt(empty)).toContain('(not given yet)');
    expect(plannerPrompt(empty)).toContain('(none chosen)');
  });

  it('carry the guest brief and address', () => {
    expect(intakePrompt(full)).toContain(
      'Address the guest as exactly "Dr Lima"',
    );
    const planner = plannerPrompt(full);
    expect(planner).toContain('- Destination: Lisbon');
    expect(planner).toContain('at most 3 searches');
  });
});
