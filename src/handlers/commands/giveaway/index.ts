import GiveawayCreate from '../giveaway_create/action';
import GiveawayDelete from '../giveaway_delete/action';
import { GroupedCommand } from '../grouped-command';

export default class giveaway extends GroupedCommand {
  constructor() {
    super({
      name: 'giveaway',
      category: 'events',
      guildOnly: true,
      routes: [
        { name: 'create', command: new GiveawayCreate() },
        { name: 'delete', command: new GiveawayDelete() },
      ],
    });
  }
}
