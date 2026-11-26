import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryIntakeStore } from './intake.memory-store.js';
import { IntakeService } from './intake.service.js';

const identity = { givenName: 'Ana', surname: '', prefix: 'Dr' } as const;
const trip = { destination: 'Lisbon', purpose: 'a long weekend', interests: [] };

describe('IntakeService', () => {
  it('claims a conversation and authorizes only its key', async () => {
    const intake = new IntakeService();
    const { conversationKey } = await intake.setIdentity('c1', identity, undefined);
    expect(await intake.authorize('c1', conversationKey)).toMatchObject({ identity });
    await expect(intake.authorize('c1', 'guess')).rejects.toThrow(ForbiddenException);
    await expect(intake.authorize('c1', undefined)).rejects.toThrow(ForbiddenException);
    await expect(intake.authorize('nobody', conversationKey)).rejects.toThrow(
      NotFoundException,
    );
    await expect(intake.saveDraft('nobody', trip)).rejects.toThrow(NotFoundException);
  });

  it('prunes after INTAKE_RETENTION_DAYS without activity (7 by default)', async () => {
    const day = 24 * 60 * 60 * 1000;
    const store = new MemoryIntakeStore();
    await new IntakeService(store).setIdentity('c1', identity, undefined);
    expect(await new IntakeService(store).prune(Date.now() + 6 * day)).toBe(0);
    expect(await new IntakeService(store).prune(Date.now() + 8 * day)).toBe(1);

    const short = new IntakeService(store, new ConfigService({ INTAKE_RETENTION_DAYS: '1' }));
    await short.setIdentity('c2', identity, undefined);
    expect(await short.prune(Date.now() + 2 * day)).toBe(1);
  });

  it('never throws from prune', async () => {
    const store = new MemoryIntakeStore();
    store.prune = () => Promise.reject(new Error('db down'));
    expect(await new IntakeService(store).prune()).toBe(0);
  });
});
