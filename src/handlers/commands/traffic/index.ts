import { GroupedCommand } from '../grouped-command';
import TrafficAction from '../traffic/action';
import TrafficMeAction from '../traffic_me/action';
import TrafficUserAction from '../traffic_user/action';

export default class Traffic extends GroupedCommand {
  constructor() {
    super({
      name: 'traffic',
      category: 'server_activity',
      routes: [
        { name: 'overview', command: new TrafficAction() },
        { name: 'me', command: new TrafficMeAction() },
        { name: 'user', command: new TrafficUserAction() },
      ],
    });
  }
}
