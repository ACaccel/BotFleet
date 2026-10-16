import { ComponentType, MessageFlags } from 'discord.js';
import type { BaseBot } from '@bot';

import { createCustomIdDispatcher, createHandlerRegistrar, type HandlerBarrelSpec } from 'handlers';
// `./ssm-handler` is imported BEFORE `./registry.generated` so the
// abstract class is on `module.exports` by the time the generated
// registry pulls in handler subclasses. See `ssm-handler.ts`.
import { SSMHandler, type SelectMenuInteraction } from './ssm-handler';
import { SSM_REGISTRY } from './registry.generated';

export { SSMHandler, type SelectMenuInteraction };

const SSM_BARREL: HandlerBarrelSpec<SSMHandler<SelectMenuInteraction>> = {
  registry: SSM_REGISTRY,
  label: 'string select menu',
  assign: (bot: BaseBot, handlers) => {
    bot.ssmHandlers = handlers;
  },
  read: (bot: BaseBot) => bot.ssmHandlers,
};

export const registerSSMs = createHandlerRegistrar(SSM_BARREL);
const dispatchSelect = createCustomIdDispatcher<
  SelectMenuInteraction,
  SSMHandler<SelectMenuInteraction>
>(SSM_BARREL);

export const executeSSM = async (
  interaction: SelectMenuInteraction,
  bot: BaseBot,
): Promise<void> => {
  const handler = bot.ssmHandlers.get(interaction.customId.split('|')[0] ?? '');
  if (
    handler &&
    !(handler.componentTypes ?? [ComponentType.StringSelect]).includes(
      interaction.componentType ?? ComponentType.StringSelect,
    )
  ) {
    await interaction.reply({
      content: bot.translator?.t('errors:command.unsupported_interaction_type') ?? '',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await dispatchSelect(interaction, bot);
};
