import { GroupedCommand } from '../grouped-command';
import AiSettingsAction from '../ai_settings/action';
import AiStatusAction from '../ai_status/action';
import AiWhitelistAddAction from '../ai_whitelist_add/action';
import AiWhitelistRemoveAction from '../ai_whitelist_remove/action';
import AiWhitelistListAction from '../ai_whitelist_list/action';

export default class Ai extends GroupedCommand {
  constructor() {
    super({
      name: 'ai',
      category: 'ai',
      routes: [
        { name: 'settings', command: new AiSettingsAction() },
        { name: 'status', command: new AiStatusAction() },
        { group: 'whitelist', name: 'add', command: new AiWhitelistAddAction() },
        { group: 'whitelist', name: 'remove', command: new AiWhitelistRemoveAction() },
        { group: 'whitelist', name: 'list', command: new AiWhitelistListAction() },
      ],
    });
  }
}
