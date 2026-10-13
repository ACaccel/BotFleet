import { GroupedCommand } from '../grouped-command';
import ThreadBanAction from '../thread_ban/action';
import ThreadAllowAction from '../thread_allow/action';
import ThreadListAction from '../thread_list/action';
import ThreadClaimAction from '../thread_claim/action';
import ThreadManagerAction from '../thread_manager/action';

export default class Thread extends GroupedCommand {
  constructor() {
    const manager = new ThreadManagerAction();
    super({
      name: 'thread',
      category: 'admin',
      guildOnly: true,
      routes: [
        { name: 'ban', command: new ThreadBanAction() },
        { name: 'allow', command: new ThreadAllowAction() },
        { name: 'list', command: new ThreadListAction() },
        { name: 'claim', command: new ThreadClaimAction() },
        { group: 'manager', name: 'add', command: manager, adminOnly: true },
        { group: 'manager', name: 'remove', command: manager, adminOnly: true },
        { group: 'manager', name: 'list', command: manager, adminOnly: true },
      ],
    });
  }
}
