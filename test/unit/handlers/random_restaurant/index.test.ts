/**
 * `/random_restaurant` failure classification.
 *
 * The handler used to catch everything and answer "no restaurants
 * found" (or the late-night line), so a dead upstream, a DNS failure, or
 * a missing endpoint were all indistinguishable from an empty result —
 * and none of them reached the operator log with a trace id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import RandomRestaurant from '../../../../src/handlers/commands/random_restaurant';
import { boundedHttp } from '../../../../src/infra/http';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';

const API_URL = 'https://food.test/recommend';

const buildBot = () => {
  const { bot, logger } = buildFakeBot({
    config: { random_restaurant: { apiUrl: API_URL } },
  });
  return { bot, error: logger.error };
};

const buildInteraction = () => {
  const sink = newInteractionSink();
  return { interaction: buildChatInputInteraction({ guildId: 'g1', sink }), sink };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('random_restaurant', () => {
  it('queries the endpoint from config, not a compiled-in URL', async () => {
    const get = vi.spyOn(boundedHttp, 'get').mockResolvedValue({
      data: { message: 'try this', restaurant: {} },
    } as never);
    const { bot } = buildBot();
    const { interaction, sink } = buildInteraction();

    await new RandomRestaurant().execute(interaction, bot);

    expect(get.mock.calls[0]?.[0]).toBe(API_URL);
    expect(sink.editReplies).toEqual([{ content: 'replies:random_restaurant.description' }]);
  });

  it('answers a no-match with the friendly copy and no error log', async () => {
    // An empty result set: the API answers without a `restaurant`
    // object, so reading through it raises a TypeError.
    vi.spyOn(boundedHttp, 'get').mockResolvedValue({ data: {} } as never);
    const { bot, error } = buildBot();
    const { interaction, sink } = buildInteraction();
    // Mid-afternoon in Taipei, so the late-night branch is not taken.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T06:00:00Z'));

    await new RandomRestaurant().execute(interaction, bot);

    expect(sink.editReplies).toEqual([{ content: 'replies:random_restaurant.no_match' }]);
    expect(error).not.toHaveBeenCalled();
  });

  it('routes a transport failure through the trace-id error boundary', async () => {
    vi.spyOn(boundedHttp, 'get').mockRejectedValue(new Error('getaddrinfo ENOTFOUND food.test'));
    const { bot, error } = buildBot();
    const { interaction, sink } = buildInteraction();

    await new RandomRestaurant().execute(interaction, bot);

    // Previously this printed "no restaurants found" and logged nothing
    // at error level.
    expect(sink.editReplies).toEqual([
      expect.objectContaining({ content: 'replies:random_restaurant.failed' }),
    ]);
    expect(error).toHaveBeenCalled();
  });

  it('refuses to register without the endpoint block', () => {
    expect(() => new RandomRestaurant().validateBotConfig({})).toThrow();
    expect(() =>
      new RandomRestaurant().validateBotConfig({ random_restaurant: { apiUrl: API_URL } }),
    ).not.toThrow();
  });
});
