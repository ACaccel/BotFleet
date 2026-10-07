import ActivityCreate from '../activity_create/action';
import ActivityDelete from '../activity_delete/action';
import { GroupedCommand } from '../grouped-command';

export default class activity extends GroupedCommand {
  constructor() {
    super({
      name: 'activity',
      category: 'server_activity',
      routes: [
        { name: 'create', command: new ActivityCreate() },
        { name: 'delete', command: new ActivityDelete() },
      ],
    });
  }
}
