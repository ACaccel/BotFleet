import { describe, expect, it, vi } from 'vitest';
import {
  ActionRowBuilder,
  ComponentType,
  ModalSubmitFields,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  FEATURES,
  ENTERTAINMENT_COMMANDS,
  guildSettingsDraftSchema,
  defaultGuildSettings,
  cloneSettings,
  GuildSettingsError,
  type GuildSettingsActor,
  type OperatorCapabilities,
} from '../../../src/core/guild-settings';
import type { GuildSettingsSession } from '../../../src/application/guild-settings/session';
import type { GuildSettingsService } from '../../../src/application/guild-settings/service';
import {
  renderSettingsPanel,
  panelCategories,
  panelTranslate,
} from '../../../src/application/guild-settings/panel-view';
import {
  buildPanelModal,
  applyPanelModal,
  parseModalContext,
  modalResourceValues,
} from '../../../src/application/guild-settings/panel-modal';
import { panelId, parsePanelId } from '../../../src/application/guild-settings/panel-id';
import {
  handleSettingsInteraction,
  openSettingsPanel,
  type SettingsPanelHost,
} from '../../../src/application/guild-settings/interaction';
import SettingsCommand from '../../../src/handlers/commands/settings';
import { echoTranslator } from '../../fixtures/runtime';
const caps: OperatorCapabilities = {
  features: Object.fromEntries(
    FEATURES.map((value) => [value, true]),
  ) as OperatorCapabilities['features'],
  socialProviders: ['twitter', 'instagram'],
  maxRandomProbability: 0.5,
  minCooldownSeconds: 0,
  maxPreviewUrls: 10,
};
const actor: GuildSettingsActor = {
  botId: '111111111111111111',
  guildId: '222222222222222222',
  userId: '333333333333333333',
  manager: true,
  roleIds: [],
  messageId: '444444444444444444',
};
const session = (): GuildSettingsSession => ({
  id: 'opaque_session',
  botId: actor.botId,
  guildId: actor.guildId,
  userId: actor.userId,
  messageId: actor.messageId,
  expiresAt: Date.now() + 600000,
  baseRevision: 3,
  base: defaultGuildSettings(caps),
  draft: defaultGuildSettings(caps),
  pending: false,
  saving: false,
});
const t = (key: string): string => key.split('.').pop() ?? key;
const jsonPanel = (value: ReturnType<typeof renderSettingsPanel>) => ({
  ...value,
  components: value.components?.map((component) =>
    component instanceof ActionRowBuilder ? component.toJSON() : component,
  ),
});

const actualFields = (
  values: Record<string, readonly string[]> = {},
  text: Record<string, string> = {},
): ModalSubmitFields => {
  const selects = Object.entries(values).map(([customId, selected]) => ({
    type: ComponentType.Label,
    id: 0,
    label: customId,
    component: {
      type: ['roles', 'voter_roles', 'earthquake_role'].includes(customId)
        ? ComponentType.RoleSelect
        : ['allowed', 'excluded', 'debug', 'event', 'giveaway', 'earthquake_channel'].includes(
              customId,
            )
          ? ComponentType.ChannelSelect
          : ComponentType.StringSelect,
      id: 0,
      customId,
      values: selected,
    },
  }));
  const inputs = Object.entries(text).map(([customId, value]) => ({
    type: ComponentType.Label,
    id: 0,
    label: customId,
    component: { type: ComponentType.TextInput, id: 0, customId, value },
  }));
  return Reflect.construct(ModalSubmitFields, [[...selects, ...inputs]]) as ModalSubmitFields;
};
describe('settings panel boundaries', () => {
  it('registers guild-only without a manager default permission', () => {
    expect(new SettingsCommand().config).toMatchObject({ name: 'settings', guildOnly: true });
    expect(new SettingsCommand().config.defaultMemberPermissions).toBeUndefined();
  });
  it.each([
    '',
    'settings|s|save',
    'settings|s|save||extra',
    'settings|s|bad action|',
    `settings|${'x'.repeat(100)}|save|`,
  ])('rejects malformed identifier %s', (value) => expect(parsePanelId(value)).toBeUndefined());
  it('round-trips safe identifiers and bounds generated identifiers', () => {
    expect(parsePanelId(panelId('opaque_session', 'excluded', 'auto_reply'))).toEqual({
      sessionId: 'opaque_session',
      action: 'excluded',
      detail: 'auto_reply',
    });
    expect(() => panelId('x'.repeat(100), 'save')).toThrow();
  });
  it.each(['access', 'features', 'channels', 'auto_reply', 'social', 'status', 'history'] as const)(
    'keeps %s within Discord component limits',
    (category) => {
      const result = jsonPanel(renderSettingsPanel(session(), actor, caps, t, category));
      expect(result.components?.length).toBeLessThanOrEqual(5);
      for (const row of result.components ?? []) {
        if (!('components' in row)) continue;
        expect(row.components.length).toBeLessThanOrEqual(5);
        for (const component of row.components) {
          if ('custom_id' in component) expect(component.custom_id.length).toBeLessThanOrEqual(100);
          if ('options' in component) expect(component.options.length).toBeLessThanOrEqual(25);
        }
      }
    },
  );
  it('filters protected pages, feature labels and history after grants change', () => {
    const draft = session();
    draft.base.access = {
      mode: 'everyone',
      roleIds: [],
      categories: ['auto_reply', 'social_preview'],
    };
    const current = cloneSettings(draft.base);
    current.access.categories = ['auto_reply'];
    const editor = { ...actor, manager: false };
    expect(panelCategories(editor, draft, current)).toEqual([
      'features',
      'auto_reply',
      'status',
      'history',
    ]);
    const result = JSON.stringify(
      jsonPanel(
        renderSettingsPanel(
          draft,
          editor,
          caps,
          t,
          'history',
          undefined,
          'debug',
          undefined,
          [
            {
              revision: 4,
              userId: actor.userId,
              paths: ['channels.debug', 'features.moderation_vote.enabled'],
            },
          ],
          new Set(),
          current,
        ),
      ),
    );
    expect(result).not.toContain('channels.debug');
    expect(result).not.toContain('moderation_vote');
    expect(result).not.toContain('social_preview');
  });
  it('does not expose invisible channel IDs through native selector defaults', () => {
    const draft = session();
    draft.draft.features.auto_reply.channelIds = ['555555555555555555'];
    draft.draft.features.auto_reply.excludedChannelIds = ['666666666666666666'];
    const result = JSON.stringify(
      jsonPanel(
        renderSettingsPanel(
          draft,
          actor,
          caps,
          t,
          'features',
          'auto_reply',
          'debug',
          undefined,
          [],
          new Set(),
        ),
      ),
    );
    expect(result).not.toContain('555555555555555555');
    expect(result).not.toContain('666666666666666666');
  });
  it('keeps protected social controls out of delegated parameter forms', () => {
    const modal = buildPanelModal(session(), 'social', 'nonce', false, caps, t).toJSON();
    expect(modal.components.length).toBe(3);
    expect(JSON.stringify(modal)).toContain('strategy');
    expect(JSON.stringify(modal)).not.toContain('delete');
    expect(JSON.stringify(modal)).not.toContain('max_urls');
    expect(modal.custom_id).toBe(panelId('opaque_session', 'modal', 'social', 'nonce'));
  });
  it('rejects numeric prefix parsing and forged reply behavior', () => {
    const fields = {
      getTextInputValue: vi.fn().mockReturnValue('1junk'),
      getStringSelectValues: vi.fn().mockReturnValue(['random']),
    } as unknown as ModalSubmitInteraction['fields'];
    expect(() => applyPanelModal(session().draft, { fields }, 'auto_reply', true, caps)).toThrow(
      GuildSettingsError,
    );
    fields.getTextInputValue = vi.fn().mockReturnValue('0.2');
    fields.getStringSelectValues = vi.fn().mockReturnValue(['forged']);
    expect(() => applyPanelModal(session().draft, { fields }, 'auto_reply', true, caps)).toThrow(
      GuildSettingsError,
    );
  });
  it('uses the user locale without mutating the translator', () => {
    const translator = echoTranslator();
    translator.t = vi.fn().mockReturnValue('translated');
    expect(panelTranslate(translator, 'en-US')('title')).toBe('translated');
    expect(translator.t).toHaveBeenCalledWith('replies:settings.title', undefined, 'en');
  });
});

const interactionFixture = () => {
  const member = { roles: [], permissions: undefined };
  const guild = {
    roles: { cache: new Map() },
    id: actor.guildId,
    ownerId: actor.userId,
    members: { fetch: vi.fn().mockResolvedValue(member) },
    channels: { cache: { filter: vi.fn().mockReturnValue(new Map()) } },
  };
  return {
    applicationId: actor.botId,
    guildId: actor.guildId,
    guild,
    member,
    user: { id: actor.userId },
    locale: 'en-US',
    message: { id: actor.messageId },
    customId: panelId('opaque_session', 'save', 'features'),
    deferReply: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    fetchReply: vi.fn().mockResolvedValue({ id: actor.messageId }),
    followUp: vi.fn(),
    reply: vi.fn(),
    showModal: vi.fn(),
    isButton: () => true,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isModalSubmit: () => false,
    deferred: true,
    replied: false,
  };
};
const hostFixture = (draft = session()) => {
  const service = {
    capabilities: caps,
    open: vi.fn().mockResolvedValue(draft),
    bindMessage: vi.fn(),
    getSession: vi.fn().mockResolvedValue(draft),
    get: vi.fn().mockReturnValue({ settings: draft.base, audit: [] }),
    save: vi.fn(),
    discard: vi.fn().mockResolvedValue(draft),
    stage: vi.fn(),
    createModalNonce: vi.fn().mockResolvedValue('nonce'),
    beginModal: vi.fn().mockReturnValue({ session: draft, nonce: 'nonce' }),
    consumeModalNonce: vi.fn().mockResolvedValue(draft),
  };
  const host: SettingsPanelHost = {
    guildSettings: service as unknown as GuildSettingsService,
    translator: { ...echoTranslator(), t: (key) => key.split('.').pop() ?? key },
    logger: undefined,
  };
  return { host, service };
};
describe('settings interaction ownership and save workflow', () => {
  it('opens an ephemeral draft and binds the returned panel message', async () => {
    const interaction = interactionFixture();
    delete (interaction as Partial<typeof interaction>).message;
    const { host, service } = hostFixture();
    await openSettingsPanel(interaction as unknown as ChatInputCommandInteraction, host);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(service.open).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: actor.botId,
        guildId: actor.guildId,
        userId: actor.userId,
        manager: true,
      }),
    );
    expect(service.bindMessage).toHaveBeenCalledWith(
      'opaque_session',
      expect.anything(),
      actor.messageId,
    );
  });
  it('fetches current membership before saving and retains the panel on conflict', async () => {
    const interaction = interactionFixture();
    const { host, service } = hostFixture();
    service.save.mockRejectedValue(new GuildSettingsError('conflict'));
    await handleSettingsInteraction(interaction as unknown as ButtonInteraction, host);
    expect(interaction.guild.members.fetch).toHaveBeenCalledWith({
      user: actor.userId,
      force: true,
    });
    expect(service.getSession).toHaveBeenCalledWith(
      'opaque_session',
      expect.objectContaining({ messageId: actor.messageId }),
    );
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'conflict' }),
    );
    expect(interaction.editReply).not.toHaveBeenCalled();
  });
  it('opens a nonce-bound modal without deferring the interaction', async () => {
    const interaction = interactionFixture();
    interaction.customId = panelId('opaque_session', 'edit', 'auto_reply');
    const { host, service } = hostFixture();
    await handleSettingsInteraction(interaction as unknown as ButtonInteraction, host);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
    expect(service.beginModal).toHaveBeenCalled();
    expect(service.getSession).not.toHaveBeenCalled();
    expect(interaction.showModal).toHaveBeenCalled();
  });
  it('denies expired sessions without staging or saving', async () => {
    const interaction = interactionFixture();
    const { host, service } = hostFixture();
    service.getSession.mockRejectedValue(new GuildSettingsError('expired'));
    await handleSettingsInteraction(interaction as unknown as ButtonInteraction, host);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.stage).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'expired' }),
    );
  });
});

describe('settings resource and delegated boundaries', () => {
  it('rejects a foreign-guild destination without staging', async () => {
    const base = interactionFixture();
    const interaction = Object.assign(base, {
      customId: panelId('opaque_session', 'modal', 'channels', 'nonce'),
      values: ['555555555555555555'],
      fields: actualFields({ debug: ['555555555555555555'], event: [], giveaway: [] }),
      isButton: () => false,
      isModalSubmit: () => true,
    });
    Object.assign(interaction.guild.channels, {
      fetch: vi.fn().mockResolvedValue({ guildId: '777777777777777777', type: 0 }),
    });
    const { host, service } = hostFixture();
    await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
    expect(service.stage).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'invalid' }),
    );
  });
  it('rejects a category channel as an output destination', async () => {
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'modal', 'channels', 'nonce'),
      values: ['555555555555555555'],
      fields: actualFields({ debug: ['555555555555555555'], event: [], giveaway: [] }),
      isButton: () => false,
      isModalSubmit: () => true,
    });
    Object.assign(interaction.guild.channels, {
      fetch: vi.fn().mockResolvedValue({ guildId: actor.guildId, type: 4 }),
    });
    const { host, service } = hostFixture();
    await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
    expect(service.stage).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'invalid' }),
    );
  });
  it('validates channel visibility before staging', async () => {
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'modal', 'scope_auto_reply', 'nonce'),
      values: ['555555555555555555'],
      fields: actualFields({ mode: ['all'], allowed: ['555555555555555555'], excluded: [] }),
      isButton: () => false,
      isModalSubmit: () => true,
    });
    Object.assign(interaction.guild.channels, {
      fetch: vi.fn().mockResolvedValue({
        guildId: actor.guildId,
        type: 0,
        permissionsFor: () => ({ has: () => true }),
      }),
    });
    const { host, service } = hostFixture();
    await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
    expect(service.stage).toHaveBeenCalledWith(
      'opaque_session',
      expect.anything(),
      expect.objectContaining({
        features: expect.objectContaining({
          auto_reply: expect.objectContaining({ channelIds: interaction.values }),
        }),
      }),
    );
  });
  it('rejects managed and everyone roles', async () => {
    for (const role of [
      { id: actor.guildId, managed: false },
      { id: '555555555555555555', managed: true },
    ]) {
      const interaction = Object.assign(interactionFixture(), {
        customId: panelId('opaque_session', 'modal', 'access', 'nonce'),
        values: [role.id],
        fields: actualFields({ audience: ['managers'], roles: [role.id], grants: [] }),
        isButton: () => false,
        isModalSubmit: () => true,
      });
      Object.assign(interaction.guild, {
        roles: { fetch: vi.fn().mockResolvedValue({ ...role, guild: { id: actor.guildId } }) },
      });
      const { host, service } = hostFixture();
      await handleSettingsInteraction(interaction as unknown as RoleSelectMenuInteraction, host);
      expect(service.stage).not.toHaveBeenCalled();
    }
  });
  it('does not allow a revoked editor to save an older draft', async () => {
    const interaction = interactionFixture();
    const { host, service } = hostFixture();
    service.getSession.mockRejectedValue(new GuildSettingsError('forbidden'));
    await handleSettingsInteraction(interaction as unknown as ButtonInteraction, host);
    expect(service.save).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'forbidden' }),
    );
  });
  it('keeps preference draft when switching to the separate access editor', async () => {
    const draft = session();
    draft.draft.autoReply.probability = 0.1;
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'category'),
      values: ['access'],
      isButton: () => false,
      isStringSelectMenu: () => true,
    });
    const { host, service } = hostFixture(draft);
    await handleSettingsInteraction(interaction as unknown as StringSelectMenuInteraction, host);
    expect(service.stage).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain('access_separate');
    expect(draft.draft.autoReply.probability).toBe(0.1);
  });
});

describe('settings parameter presentation', () => {
  it.each([
    ['auto_reply', true],
    ['auto_reply', false],
    ['social', true],
    ['social', false],
  ] as const)('keeps %s modal selects valid for manager=%s', (category, manager) => {
    const modal = buildPanelModal(session(), category, 'nonce', manager, caps, t).toJSON();
    const selects = modal.components.flatMap((component) =>
      component.type === ComponentType.Label &&
      component.component.type === ComponentType.StringSelect
        ? [component.component]
        : [],
    );
    expect(selects.some((select) => select.min_values === 0)).toBe(true);
    for (const select of selects) {
      if (select.min_values === 0) expect(select.required).toBe(false);
      else expect(select.required).toBe(true);
    }
  });
  it('accepts empty optional behavior and provider selections', () => {
    const draft = session().draft;
    const fields = {
      getTextInputValue: (key: string) => (key === 'probability' ? '0.5' : '5'),
      getStringSelectValues: (key: string) =>
        key === 'video' ? ['off'] : key === 'strategy' ? ['leave'] : [],
    } as unknown as ModalSubmitInteraction['fields'];
    applyPanelModal(draft, { fields }, 'auto_reply', false, caps);
    for (const key of ['keywords', 'random', 'dice', 'reactions'] as const)
      expect(draft.autoReply[key]).toBe(false);
    applyPanelModal(draft, { fields }, 'social', false, caps);
    expect(draft.socialPreview.providers).toEqual([]);
    expect(draft.socialPreview.videoEnabled).toBe(false);
  });
  it('shows percentage values and converts them back to fractions', () => {
    const draft = session();
    draft.draft.autoReply.probability = 0.005;
    const serialized = buildPanelModal(draft, 'auto_reply', 'nonce', true, caps, t).toJSON();
    expect(JSON.stringify(serialized)).toContain('"value":"0.5"');
    const fields = {
      getTextInputValue: (key: string) => (key === 'probability' ? '0.5' : '5'),
      getStringSelectValues: () => ['random'],
    } as unknown as ModalSubmitInteraction['fields'];
    applyPanelModal(draft.draft, { fields }, 'auto_reply', true, caps);
    expect(draft.draft.autoReply.probability).toBe(0.005);
    const panel = JSON.stringify(renderSettingsPanel(draft, actor, caps, t, 'auto_reply'));
    expect(panel).toContain('0.5%');
  });
  it('permits delegated embedding preferences while rejecting deletion', () => {
    const draft = session().draft;
    const fields = {
      getStringSelectValues: (key: string) =>
        key === 'strategy' ? ['leave'] : key === 'providers' ? ['twitter'] : ['on'],
    } as unknown as ModalSubmitInteraction['fields'];
    applyPanelModal(draft, { fields }, 'social', false, caps);
    expect(draft.socialPreview.originalMessageStrategy).toBe('leave');
    fields.getStringSelectValues = (key: string) =>
      key === 'strategy' ? ['delete'] : key === 'providers' ? ['twitter'] : ['on'];
    expect(() => applyPanelModal(draft, { fields }, 'social', false, caps)).toThrow(
      GuildSettingsError,
    );
  });
  it('preserves manager deletion policy while delegated users edit other preferences', () => {
    const draft = session();
    draft.draft.socialPreview.originalMessageStrategy = 'delete';
    const modal = buildPanelModal(draft, 'social', 'nonce', false, caps, t).toJSON();
    expect(JSON.stringify(modal)).not.toContain('strategy');
    const fields = {
      getStringSelectValues: (key: string) => (key === 'providers' ? ['twitter'] : ['off']),
    } as unknown as ModalSubmitInteraction['fields'];
    applyPanelModal(draft.draft, { fields }, 'social', false, caps);
    expect(draft.draft.socialPreview.originalMessageStrategy).toBe('delete');
    expect(draft.draft.socialPreview.videoEnabled).toBe(false);
  });
});

describe('delegated channel scope resource preservation', () => {
  const hidden = '555555555555555555';
  const previousVisible = '666666666666666666';
  const selectedVisible = '777777777777777777';
  const fixture = (action: 'allowed' | 'excluded', selected: string[], manager = false) => {
    const draft = session();
    draft.base.access = { mode: 'everyone', roleIds: [], categories: ['auto_reply'] };
    draft.draft.access = cloneSettings(draft.base).access;
    const key = action === 'allowed' ? 'channelIds' : 'excludedChannelIds';
    draft.draft.features.auto_reply[key] = [hidden, previousVisible];
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'modal', 'scope_auto_reply', 'nonce'),
      values: selected,
      fields: actualFields({
        mode: ['all'],
        allowed: action === 'allowed' ? selected : [],
        excluded: action === 'excluded' ? selected : [],
      }),
      isButton: () => false,
      isModalSubmit: () => true,
    });
    interaction.guild.ownerId = manager ? actor.userId : '888888888888888888';
    interaction.guild.channels.cache.filter.mockReturnValue(
      new Map([
        [previousVisible, {}],
        [selectedVisible, {}],
      ]),
    );
    Object.assign(interaction.guild.channels, {
      fetch: vi.fn().mockImplementation(async (id: string) => ({
        guildId: actor.guildId,
        type: 0,
        permissionsFor: () => ({ has: () => id === previousVisible || id === selectedVisible }),
      })),
    });
    return { interaction, ...hostFixture(draft), key };
  };
  it.each(['allowed', 'excluded'] as const)(
    'preserves hidden previous %s IDs while removing visible deselections',
    async (action) => {
      const { interaction, host, service, key } = fixture(action, [selectedVisible]);
      await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
      expect(service.stage).toHaveBeenCalledWith(
        'opaque_session',
        expect.objectContaining({ manager: false }),
        expect.objectContaining({
          features: expect.objectContaining({
            auto_reply: expect.objectContaining({ [key]: [hidden, selectedVisible] }),
          }),
        }),
      );
    },
  );
  it('deduplicates selected IDs when combining the retained scope', async () => {
    const { interaction, host, service } = fixture('excluded', [selectedVisible, selectedVisible]);
    await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
    expect(service.stage).toHaveBeenCalledWith(
      'opaque_session',
      expect.anything(),
      expect.objectContaining({
        features: expect.objectContaining({
          auto_reply: expect.objectContaining({ excludedChannelIds: [hidden, selectedVisible] }),
        }),
      }),
    );
  });
  it('rejects newly forged inaccessible IDs without modifying the scope', async () => {
    const { interaction, host, service } = fixture('excluded', ['999999999999999999']);
    await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
    expect(service.stage).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'invalid' }),
    );
  });
  it('allows managers to remove hidden or stale scope entries explicitly', async () => {
    const { interaction, host, service } = fixture('excluded', [selectedVisible], true);
    await handleSettingsInteraction(interaction as unknown as ChannelSelectMenuInteraction, host);
    expect(service.stage).toHaveBeenCalledWith(
      'opaque_session',
      expect.objectContaining({ manager: true }),
      expect.objectContaining({
        features: expect.objectContaining({
          auto_reply: expect.objectContaining({ excludedChannelIds: [selectedVisible] }),
        }),
      }),
    );
  });
});

describe('v2 settings modal contracts', () => {
  it.each(['general', 'moderation', 'entertainment'] as const)(
    'keeps %s overview within Discord limits',
    (category) => {
      expect(
        renderSettingsPanel(session(), actor, caps, t, category).components?.length,
      ).toBeLessThanOrEqual(5);
    },
  );
  it.each([
    'access',
    'channels',
    'general',
    'moderation',
    'scope_auto_reply',
    'entertainment_menu_author_avatar',
  ] as const)('serializes %s with an exact context and optional native selectors', (context) => {
    const modal = buildPanelModal(session(), context, 'nonce', true, caps, t).toJSON();
    expect(parsePanelId(modal.custom_id)).toEqual({
      sessionId: 'opaque_session',
      action: 'modal',
      detail: context,
      nonce: 'nonce',
    });
    expect(modal.components.length).toBeLessThanOrEqual(5);
    for (const label of modal.components)
      if (
        'component' in label &&
        'min_values' in label.component &&
        label.component.min_values === 0
      )
        expect(label.component.required).toBe(false);
  });
  it('uses native SDK channel/role fields, accepts clearing them and rejects type substitution', () => {
    const fields = actualFields({ roles: [], allowed: ['555555555555555555'] });
    expect(modalResourceValues({ fields }, 'roles', ComponentType.RoleSelect)).toEqual([]);
    expect(modalResourceValues({ fields }, 'allowed', ComponentType.ChannelSelect)).toEqual([
      '555555555555555555',
    ]);
    expect(() => modalResourceValues({ fields }, 'roles', ComponentType.ChannelSelect)).toThrow(
      GuildSettingsError,
    );
  });
  it('parses only known modal contexts and rejects malformed nonce envelopes', () => {
    for (const command of ENTERTAINMENT_COMMANDS)
      expect(parseModalContext(`entertainment_${command}`)).toBe(`entertainment_${command}`);
    expect(parseModalContext('scope_cross_guild')).toBeUndefined();
    expect(parseModalContext('entertainment_eval')).toBeUndefined();
    expect(parsePanelId('settings|session|modal|general')).toBeUndefined();
    expect(parsePanelId('settings|session|save|general|nonce')).toBeUndefined();
    expect(parsePanelId('settings|session|modal|general|nonce|extra')).toBeUndefined();
  });
  it('applies language overrides and turns a blank timezone into inheritance', () => {
    const settings = session().draft;
    applyPanelModal(
      settings,
      { fields: actualFields({ language: ['en'] }, { time_zone: '   ' }) },
      'general',
      true,
      caps,
    );
    expect(settings.general).toEqual({ language: 'en', timeZone: null });
    applyPanelModal(
      settings,
      { fields: actualFields({ language: ['zh-TW'] }, { time_zone: ' Asia/Taipei ' }) },
      'general',
      true,
      caps,
    );
    expect(settings.general).toEqual({ language: 'zh-TW', timeZone: 'Asia/Taipei' });
    applyPanelModal(
      settings,
      { fields: actualFields({ language: ['inherit'] }, { time_zone: 'Invalid/Zone' }) },
      'general',
      true,
      caps,
    );
    expect(guildSettingsDraftSchema.safeParse(settings).success).toBe(false);
  });
  it('updates one entertainment command without changing another', () => {
    const settings = session().draft;
    applyPanelModal(
      settings,
      { fields: actualFields({ enabled: ['off'] }, { cooldown: '30' }) },
      'entertainment_give_score',
      false,
      caps,
    );
    expect(settings.entertainment.give_score).toEqual({ enabled: false, cooldownSeconds: 30 });
    expect(settings.entertainment.gay).toEqual({ enabled: true, cooldownSeconds: 0 });
    applyPanelModal(
      settings,
      { fields: actualFields({ enabled: ['on'] }, { cooldown: '86401' }) },
      'entertainment_give_score',
      false,
      caps,
    );
    expect(guildSettingsDraftSchema.safeParse(settings).success).toBe(false);
  });
  it('applies bounded moderation settings and optional voter roles', () => {
    const settings = session().draft;
    applyPanelModal(
      settings,
      {
        fields: actualFields({ voter_roles: [] }, { threshold: '2', window: '10', duration: '5' }),
      },
      'moderation',
      true,
      caps,
    );
    expect(settings.moderationVote).toEqual({
      threshold: 2,
      voteWindowSeconds: 10,
      durationMinutes: 5,
      voterRoleIds: [],
    });
    expect(guildSettingsDraftSchema.safeParse(settings).success).toBe(true);
    applyPanelModal(
      settings,
      {
        fields: actualFields(
          { voter_roles: [] },
          { threshold: '51', window: '601', duration: '6' },
        ),
      },
      'moderation',
      true,
      caps,
    );
    expect(guildSettingsDraftSchema.safeParse(settings).success).toBe(false);
  });
  it.each(['access', 'channels', 'general', 'moderation'] as const)(
    'denies delegated writes to %s before reading fields',
    (context) => {
      expect(() =>
        applyPanelModal(session().draft, { fields: actualFields() }, context, false, caps),
      ).toThrow(GuildSettingsError);
    },
  );
  it('caps social previews to both the deployment limit and five, with an explicit range', () => {
    const translate = vi.fn(t);
    buildPanelModal(
      session(),
      'social',
      'nonce',
      true,
      { ...caps, maxPreviewUrls: 3 },
      translate,
    ).toJSON();
    expect(translate).toHaveBeenCalledWith('max_urls_range', { max: 3 });
    const fields = actualFields(
      { video: ['on'], providers: [], strategy: ['leave'] },
      { max_urls: '6' },
    );
    expect(() => applyPanelModal(session().draft, { fields }, 'social', true, caps)).toThrow(
      GuildSettingsError,
    );
    expect(() =>
      applyPanelModal(
        session().draft,
        {
          fields: actualFields(
            { video: ['on'], providers: [], strategy: ['leave'] },
            { max_urls: '4' },
          ),
        },
        'social',
        true,
        { ...caps, maxPreviewUrls: 3 },
      ),
    ).toThrow(GuildSettingsError);
  });
  it('submits complete access edits together and preserves separate-save semantics', async () => {
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'modal', 'access', 'nonce'),
      isButton: () => false,
      isModalSubmit: () => true,
      fields: actualFields({ audience: ['everyone'], roles: [], grants: ['entertainment'] }),
    });
    const { host, service } = hostFixture();
    await handleSettingsInteraction(interaction as unknown as ModalSubmitInteraction, host);
    expect(service.consumeModalNonce).toHaveBeenCalledWith(
      'opaque_session',
      expect.anything(),
      'nonce',
      'access',
    );
    expect(service.stage).toHaveBeenCalledWith(
      'opaque_session',
      expect.anything(),
      expect.objectContaining({
        access: { mode: 'everyone', roleIds: [], categories: ['entertainment'] },
      }),
    );
    expect(service.save).not.toHaveBeenCalled();
  });
  it('rejects nonce context substitution before applying submitted fields', async () => {
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'modal', 'entertainment_give_score', 'nonce'),
      isButton: () => false,
      isModalSubmit: () => true,
      fields: actualFields({ enabled: ['off'] }, { cooldown: '30' }),
    });
    const { host, service } = hostFixture();
    service.consumeModalNonce.mockRejectedValue(new GuildSettingsError('forbidden'));
    await handleSettingsInteraction(interaction as unknown as ModalSubmitInteraction, host);
    expect(service.consumeModalNonce).toHaveBeenCalledWith(
      'opaque_session',
      expect.anything(),
      'nonce',
      'entertainment_give_score',
    );
    expect(service.stage).not.toHaveBeenCalled();
  });
  it('blocks an open form after the editor loses permission', async () => {
    const interaction = Object.assign(interactionFixture(), {
      customId: panelId('opaque_session', 'modal', 'general', 'nonce'),
      isButton: () => false,
      isModalSubmit: () => true,
      fields: actualFields({ language: ['en'] }, { time_zone: '' }),
    });
    const { host, service } = hostFixture();
    service.getSession.mockRejectedValue(new GuildSettingsError('forbidden'));
    await handleSettingsInteraction(interaction as unknown as ModalSubmitInteraction, host);
    expect(service.stage).not.toHaveBeenCalled();
    expect(service.consumeModalNonce).not.toHaveBeenCalled();
  });
});

describe('earthquake settings panel', () => {
  const available: OperatorCapabilities = { ...caps, earthquake: { alerts: true, reports: true } };
  it('offers the page only to managers on bots with earthquake capabilities', () => {
    expect(panelCategories(actor, session(), undefined, available)).toContain('earthquake');
    expect(
      panelCategories({ ...actor, manager: false }, session(), undefined, available),
    ).not.toContain('earthquake');
    expect(panelCategories(actor, session(), undefined, caps)).not.toContain('earthquake');
    expect(
      renderSettingsPanel(session(), actor, available, t, 'earthquake').components?.length,
    ).toBeLessThanOrEqual(5);
  });
  it('uses an optional single role and accepts clearing it while enabling a feed', () => {
    const edit = session();
    edit.draft.earthquake.roleId = '555555555555555555';
    const modal = buildPanelModal(edit, 'earthquake', 'nonce', true, available, t).toJSON();
    expect(modal.components).toHaveLength(4);
    const role = modal.components.find(
      (label) => 'component' in label && label.component.custom_id === 'earthquake_role',
    );
    expect(role).toMatchObject({
      component: { type: ComponentType.RoleSelect, min_values: 0, max_values: 1, required: false },
    });
    const fields = actualFields({
      alerts: ['on'],
      reports: ['off'],
      earthquake_channel: ['666666666666666666'],
      earthquake_role: [],
    });
    applyPanelModal(edit.draft, { fields }, 'earthquake', true, available);
    expect(edit.draft.earthquake).toEqual({
      alertsEnabled: true,
      reportsEnabled: false,
      channelId: '666666666666666666',
      roleId: null,
    });
    expect(() => applyPanelModal(edit.draft, { fields }, 'earthquake', false, available)).toThrow(
      GuildSettingsError,
    );
    expect(() =>
      applyPanelModal(edit.draft, { fields }, 'earthquake', true, {
        ...caps,
        earthquake: { alerts: false, reports: true },
      }),
    ).toThrow(GuildSettingsError);
  });
});
