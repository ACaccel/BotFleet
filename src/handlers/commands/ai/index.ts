import { GroupedCommand } from '../grouped-command';
import { parseAiPolicy } from '../../../application/ai/policy';
import AiSettingsAction from '../ai_settings/action';
import AiStatusAction from '../ai_status/action';
import AiWhitelistAddAction from '../ai_whitelist_add/action';
import AiWhitelistRemoveAction from '../ai_whitelist_remove/action';
import AiWhitelistListAction from '../ai_whitelist_list/action';

export default class Ai extends GroupedCommand {
  /** A malformed `ai` block disables the command instead of failing at first use. */
  public override validateBotConfig(config: unknown): void {
    super.validateBotConfig(config);
    parseAiPolicy(config);
  }

  constructor() {
    super({
      name: 'ai',
      category: 'ai',
      guildOnly: true,
      routes: [
        { name: 'settings', command: new AiSettingsAction() },
        { name: 'status', command: new AiStatusAction() },
        { group: 'whitelist', name: 'add', command: new AiWhitelistAddAction(), adminOnly: true },
        {
          group: 'whitelist',
          name: 'remove',
          command: new AiWhitelistRemoveAction(),
          adminOnly: true,
        },
        { group: 'whitelist', name: 'list', command: new AiWhitelistListAction(), adminOnly: true },
      ],
    });
  }
}
