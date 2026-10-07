import FeedSubscribe from '../feed_subscribe/action';
import FeedUnsubscribe from '../feed_unsubscribe/action';
import FeedList from '../feed_list/action';
import { GroupedCommand } from '../grouped-command';

export default class feed extends GroupedCommand {
  constructor() {
    super({
      name: 'feed',
      category: 'utility',
      routes: [
        { name: 'subscribe', command: new FeedSubscribe() },
        { name: 'unsubscribe', command: new FeedUnsubscribe() },
        { name: 'list', command: new FeedList() },
      ],
    });
  }
}
