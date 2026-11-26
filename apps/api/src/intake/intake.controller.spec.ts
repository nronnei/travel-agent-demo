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
  it('serves the stored identity and confirmed trip to the context fetcher', async () => {
    const c = controller();
    const { conversationKey } = await c.setIdentity('chat1', identity);
    await c.confirmTrip('chat1', trip, conversationKey);

    expect(await c.context('chat1', 'tok')).toEqual({
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

  it('addresses guests by full name without a title or surname', async () => {
    const c = controller();
    await c.setIdentity('a', { ...identity, prefix: 'none' });
    await c.setIdentity('b', { givenName: 'Madonna', prefix: 'Ms' });
    expect((await c.context('a', 'tok')).address).toBe('Gabriel García Márquez');
    expect((await c.context('b', 'tok')).address).toBe('Madonna');
  });

  it('lets only the browser that claimed a conversation write to it', async () => {
    const c = controller();
    const { conversationKey } = await c.setIdentity('chat1', identity);
    expect(conversationKey).toMatch(/^[\w-]{43}$/);

    // Someone else can't overwrite the identity or brief, with or without a key.
    await expect(c.setIdentity('chat1', identity)).rejects.toThrow(ForbiddenException);
    await expect(c.confirmTrip('chat1', trip, 'guess')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(c.confirmTrip('nobody', trip, conversationKey)).rejects.toThrow(
      NotFoundException,
    );

    // The owner can update their identity; no new key is issued.
    expect(
      await c.setIdentity('chat1', { ...identity, prefix: 'Mx' }, conversationKey),
    ).toEqual({});
    expect((await c.context('chat1', 'tok')).address).toBe('Mx García Márquez');
  });

  it('returns empty context for an unknown conversation', async () => {
    expect(await controller().context('nobody', 'tok')).toMatchObject({
      address: '',
      briefConfirmed: 'no',
    });
  });

  it('rejects a wrong or missing token, and is unavailable when unconfigured', async () => {
    await expect(controller().context('chat1', 'nope')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(controller().context('chat1', undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(controller(null).context('chat1', 'tok')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('validates bodies and conversation ids', async () => {
    const c = controller();
    await expect(
      c.setIdentity('chat1', { givenName: '', prefix: 'Dr' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      c.setIdentity('chat1', { ...identity, prefix: 'Sir' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      c.confirmTrip('chat1', { ...trip, destination: '<UNKNOWN>' }, 'k'),
    ).rejects.toThrow(BadRequestException);
    await expect(c.setIdentity('../etc', identity)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('serves a draft brief until the trip is confirmed', async () => {
    const c = controller();
    const { conversationKey } = await c.setIdentity('chat1', identity);

    // The Parlant agent's tool writes with the intake token.
    await c.saveDraft('chat1', trip, undefined, 'tok');
    expect(await c.context('chat1', 'tok')).toMatchObject({
      destination: 'New England',
      interests: 'Fall foliage, Food & drink',
      briefConfirmed: 'no',
    });

    // The guest's own edit, with their conversation key.
    await c.saveDraft('chat1', { ...trip, destination: 'Vermont' }, conversationKey);
    expect((await c.context('chat1', 'tok')).destination).toBe('Vermont');

    // Confirming wins over any later draft.
    await c.confirmTrip('chat1', trip, conversationKey);
    await c.saveDraft('chat1', { ...trip, destination: 'Maine' }, conversationKey);
    expect(await c.context('chat1', 'tok')).toMatchObject({
      destination: 'New England',
      briefConfirmed: 'yes',
    });
  });

  it('guards draft writes by conversation key or intake token', async () => {
    const c = controller();
    await c.setIdentity('chat1', identity);
    await expect(c.saveDraft('chat1', trip, 'guess')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(c.saveDraft('chat1', trip, undefined, 'nope')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(c.saveDraft('nobody', trip, undefined, 'tok')).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      c.saveDraft('chat1', { ...trip, purpose: 'tbd' }, undefined, 'tok'),
    ).rejects.toThrow(BadRequestException);
  });
});
