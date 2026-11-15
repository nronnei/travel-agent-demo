import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntakeController } from './intake.controller.js';
import { IntakeService } from './intake.service.js';

function controller(token: string | null = 'tok') {
  return new IntakeController(
    new IntakeService(),
    new ConfigService(token ? { INTAKE_API_TOKEN: token } : {}),
  );
}

const identity = {
  givenName: 'Gabriel',
  surname: 'García Márquez',
  prefix: 'Dr',
};
const trip = {
  destination: 'New England',
  purpose: 'a relaxing autumn getaway with your partner',
  interests: ['Fall foliage', 'Food & drink'],
};

describe('IntakeController', () => {
  it('serves the stored identity and confirmed trip to the context fetcher', () => {
    const c = controller();
    const { conversationKey } = c.setIdentity('chat1', identity);
    c.confirmTrip('chat1', trip, conversationKey);

    expect(c.context('chat1', 'tok')).toEqual({
      address: 'Dr García Márquez',
      givenName: 'Gabriel',
      surname: 'García Márquez',
      prefix: 'Dr',
      destination: 'New England',
      purpose: 'a relaxing autumn getaway with your partner',
      interests: 'Fall foliage, Food & drink',
      briefConfirmed: 'yes',
    });
  });

  it('addresses guests by full name without a title or surname', () => {
    const c = controller();
    c.setIdentity('a', { ...identity, prefix: 'none' });
    c.setIdentity('b', { givenName: 'Madonna', prefix: 'Ms' });
    expect(c.context('a', 'tok').address).toBe('Gabriel García Márquez');
    expect(c.context('b', 'tok').address).toBe('Madonna');
  });

  it('lets only the browser that claimed a conversation write to it', () => {
    const c = controller();
    const { conversationKey } = c.setIdentity('chat1', identity);
    expect(conversationKey).toMatch(/^[\w-]{43}$/);

    // Someone else can't overwrite the identity or brief, with or without a key.
    expect(() => c.setIdentity('chat1', identity)).toThrow(ForbiddenException);
    expect(() => c.confirmTrip('chat1', trip, 'guess')).toThrow(
      ForbiddenException,
    );
    expect(() => c.confirmTrip('nobody', trip, conversationKey)).toThrow(
      NotFoundException,
    );

    // The owner can update their identity; no new key is issued.
    expect(
      c.setIdentity('chat1', { ...identity, prefix: 'Mx' }, conversationKey),
    ).toEqual({});
    expect(c.context('chat1', 'tok').address).toBe('Mx García Márquez');
  });

  it('returns empty context for an unknown conversation', () => {
    expect(controller().context('nobody', 'tok')).toMatchObject({
      address: '',
      briefConfirmed: 'no',
    });
  });

  it('rejects a wrong or missing token, and is unavailable when unconfigured', () => {
    expect(() => controller().context('chat1', 'nope')).toThrow(
      UnauthorizedException,
    );
    expect(() => controller().context('chat1', undefined)).toThrow(
      UnauthorizedException,
    );
    expect(() => controller(null).context('chat1', 'tok')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('validates bodies and conversation ids', () => {
    const c = controller();
    expect(() =>
      c.setIdentity('chat1', { givenName: '', prefix: 'Dr' }),
    ).toThrow(BadRequestException);
    expect(() =>
      c.setIdentity('chat1', { ...identity, prefix: 'Sir' }),
    ).toThrow(BadRequestException);
    expect(() =>
      c.confirmTrip('chat1', { ...trip, destination: '<UNKNOWN>' }, 'k'),
    ).toThrow(BadRequestException);
    expect(() => c.setIdentity('../etc', identity)).toThrow(
      BadRequestException,
    );
  });

  it('serves a draft brief until the trip is confirmed', () => {
    const c = controller();
    const { conversationKey } = c.setIdentity('chat1', identity);

    // The Parlant agent's tool writes with the intake token.
    c.saveDraft('chat1', trip, undefined, 'tok');
    expect(c.context('chat1', 'tok')).toMatchObject({
      destination: 'New England',
      interests: 'Fall foliage, Food & drink',
      briefConfirmed: 'no',
    });

    // The guest's own edit, with their conversation key.
    c.saveDraft('chat1', { ...trip, destination: 'Vermont' }, conversationKey);
    expect(c.context('chat1', 'tok').destination).toBe('Vermont');

    // Confirming wins over any later draft.
    c.confirmTrip('chat1', trip, conversationKey);
    c.saveDraft('chat1', { ...trip, destination: 'Maine' }, conversationKey);
    expect(c.context('chat1', 'tok')).toMatchObject({
      destination: 'New England',
      briefConfirmed: 'yes',
    });
  });

  it('guards draft writes by conversation key or intake token', () => {
    const c = controller();
    c.setIdentity('chat1', identity);
    expect(() => c.saveDraft('chat1', trip, 'guess')).toThrow(
      ForbiddenException,
    );
    expect(() => c.saveDraft('chat1', trip, undefined, 'nope')).toThrow(
      UnauthorizedException,
    );
    expect(() => c.saveDraft('nobody', trip, undefined, 'tok')).toThrow(
      NotFoundException,
    );
    expect(() =>
      c.saveDraft('chat1', { ...trip, purpose: 'tbd' }, undefined, 'tok'),
    ).toThrow(BadRequestException);
  });
});
