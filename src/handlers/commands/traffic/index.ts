import { GroupedCommand } from '../grouped-command';
import TrafficAction from './action';
import TrafficAppsAction from '../traffic_apps/action';
import TrafficChannelAction from '../traffic_channel/action';
import TrafficEmojiAction from '../traffic_emoji/action';
import TrafficMeAction from '../traffic_me/action';
import TrafficStickerAction from '../traffic_sticker/action';
import TrafficUserAction from '../traffic_user/action';

export default class Traffic extends GroupedCommand {
  constructor() {
    super({
      name: 'traffic',
      category: 'server_activity',
      guildOnly: true,
      routes: [
        { name: 'overview', command: new TrafficAction() },
        { name: 'channel', command: new TrafficChannelAction() },
        { name: 'me', command: new TrafficMeAction() },
        { name: 'user', command: new TrafficUserAction() },
        { name: 'apps', command: new TrafficAppsAction() },
        { name: 'emoji', command: new TrafficEmojiAction() },
        { name: 'sticker', command: new TrafficStickerAction() },
      ],
    });
  }
}
