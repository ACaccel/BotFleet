/**
 * Refusals, notices and errors of a `/traffic` report reach only the invoker,
 * even when the report itself is public: Discord fixes a reply's ephemerality
 * when it is deferred, so a public placeholder is deleted and replaced by an
 * ephemeral follow-up.
 */
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';

/**
 * An answer only the invoker sees: an ephemeral reply before the defer, an edit of
 * an ephemeral deferral, or, after a public deferral, an ephemeral follow-up that
 * replaces the deleted public placeholder.
 */
export const answerPrivately = async (
  interaction: ChatInputCommandInteraction,
  content: string,
  deferredPublicly: boolean,
): Promise<void> => {
  if (!interaction.deferred) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!deferredPublicly) {
    await interaction.editReply({ content });
    return;
  }
  await interaction.deleteReply();
  await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
};
