/**
 * Which permissions a feed destination requires.
 *
 * The thread case is the one that matters: `SendMessages` on a parent
 * does not let a bot post inside a thread, so a gate that checked only
 * that bit would admit exactly the silently-broken subscription
 * `/feed subscribe` exists to refuse.
 */
import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';

import {
  PERMISSION_LABEL_KEYS,
  missingFeedPermissions,
  requiredFeedPermissions,
} from '../../../../src/handlers/feed-panel/permission-requirements';

/** A permission set granting exactly `granted`. */
const has =
  (granted: readonly bigint[]) =>
  (bit: bigint): boolean =>
    granted.includes(bit);

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
];

describe('requiredFeedPermissions', () => {
  it('asks for SendMessages in an ordinary channel', () => {
    expect(requiredFeedPermissions(false)).toEqual(['ViewChannel', 'EmbedLinks', 'SendMessages']);
  });

  it('asks for SendMessagesInThreads inside a thread', () => {
    expect(requiredFeedPermissions(true)).toEqual([
      'ViewChannel',
      'EmbedLinks',
      'SendMessagesInThreads',
    ]);
  });
});

describe('missingFeedPermissions', () => {
  it('reports nothing when every required bit is granted', () => {
    expect(missingFeedPermissions(has(ALL), false)).toEqual([]);
    expect(missingFeedPermissions(has(ALL), true)).toEqual([]);
  });

  it('names only the bit that is actually absent', () => {
    const granted = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks];

    expect(missingFeedPermissions(has(granted), false)).toEqual(['SendMessages']);
  });

  it('rejects a thread where the bot may only post in the parent', () => {
    // The exact configuration that used to pass the gate and then 403
    // on every delivery.
    const granted = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.SendMessages,
    ];

    expect(missingFeedPermissions(has(granted), true)).toEqual(['SendMessagesInThreads']);
  });

  it('reports all three in a stable order when nothing is granted', () => {
    expect(missingFeedPermissions(has([]), false)).toEqual([
      'ViewChannel',
      'EmbedLinks',
      'SendMessages',
    ]);
  });

  it('has a catalog label key for every permission it can report', () => {
    for (const isThread of [false, true]) {
      for (const name of requiredFeedPermissions(isThread)) {
        expect(PERMISSION_LABEL_KEYS[name]).toBeTruthy();
      }
    }
  });
});
