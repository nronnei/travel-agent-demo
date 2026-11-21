import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { IntakeService } from '../intake/intake.service.js';
import type { ParlantClient } from './parlant.client.js';
import { ParlantController } from './parlant.controller.js';
import type { ParlantService } from './parlant.service.js';

function setup() {
  const intake = new IntakeService();
  const { conversationKey } = intake.setIdentity(
    'chat1',
    { givenName: 'Ana', surname: '', prefix: 'Dr' },
    undefined,
  );
  const parlant = {
    sessionFor: vi.fn(async () => 'sess1'),
    forget: vi.fn(),
  };
  const client = {
    postMessage: vi.fn(async () => ({ offset: 4 })),
    cancel: vi.fn(async () => {}),
  };
  const controller = new ParlantController(
    intake,
    parlant as unknown as ParlantService,
    client as unknown as ParlantClient,
  );
  return { controller, client, parlant, key: conversationKey! };
}

describe('ParlantController', () => {
  it("posts the guest's message to the conversation's session", async () => {
    const { controller, client, key } = setup();
    expect(
      await controller.message('chat1', key, { text: ' Lisbon ' }),
    ).toEqual({
      offset: 4,
    });
    expect(client.postMessage).toHaveBeenCalledWith('sess1', 'Lisbon');
    await controller.cancel('chat1', key);
    expect(client.cancel).toHaveBeenCalledWith('sess1');
  });

  it('forgets a session Parlant no longer has', async () => {
    const { controller, client, parlant, key } = setup();
    client.postMessage.mockRejectedValueOnce(new GoneException('gone'));
    await expect(
      controller.message('chat1', key, { text: 'hi' }),
    ).rejects.toBeInstanceOf(GoneException);
    expect(parlant.forget).toHaveBeenCalledWith('chat1');
  });

  it('lets only the browser that claimed the conversation talk in it', async () => {
    const { controller, client } = setup();
    await expect(
      controller.message('chat1', 'guess', { text: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.cancel('nobody', 'k')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it('validates messages, ids and offsets', async () => {
    const { controller, key } = setup();
    for (const body of [{}, { text: '' }, { text: 'x'.repeat(4001) }]) {
      await expect(
        controller.message('chat1', key, body),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      controller.message('../x', key, { text: 'hi' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.events('chat1', key, undefined, '-1', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.event('chat1', '../x', key, {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
