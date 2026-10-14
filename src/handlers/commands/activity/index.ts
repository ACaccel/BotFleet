import { GroupedCommand } from '../grouped-command';
import ActivityCreate from '../activity_create/action';
import ActivityList from '../activity_list/action';
import ActivityCancel from '../activity_cancel/action';

export default class activity extends GroupedCommand {
  constructor() {
    super({
      name: 'activity',
      category: 'events',
      guildOnly: true,
      routes: [
        { name: 'create', command: new ActivityCreate() },
        { name: 'list', command: new ActivityList() },
        { name: 'cancel', command: new ActivityCancel() },
      ],
    });
  }
}
