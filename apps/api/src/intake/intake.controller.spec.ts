import {
  BadRequestException,
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
    c.setIdentity('chat1', identity);
    c.confirmTrip('chat1', trip);

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
    expect(c.setIdentity('a', { ...identity, prefix: 'none' }).address).toBe(
      'Gabriel García Márquez',
    );
    expect(
      c.setIdentity('b', { givenName: 'Madonna', prefix: 'Ms' }).address,
    ).toBe('Madonna');
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
      c.confirmTrip('chat1', { ...trip, destination: '<UNKNOWN>' }),
    ).toThrow(BadRequestException);
    expect(() => c.setIdentity('../etc', identity)).toThrow(
      BadRequestException,
    );
  });
});
