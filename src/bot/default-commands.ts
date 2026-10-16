/** Keep registration and runtime command defaults aligned. */
export const commandsForBot = (botName: string, commands: readonly string[] = []): string[] =>
  botName === 'tomori' || botName === 'nijika'
    ? [...new Set([...commands, 'settings'])]
    : [...commands];
