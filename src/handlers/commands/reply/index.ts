import AddReply from '../add_reply/action';
import DeleteReply from '../delete_reply/action';
import ListReply from '../list_reply/action';
import { GroupedCommand } from '../grouped-command';

export default class reply extends GroupedCommand {
  constructor() {
    super({
      name: 'reply',
      category: 'auto_reply',
      routes: [
        { name: 'add', command: new AddReply() },
        { name: 'delete', command: new DeleteReply() },
        { name: 'list', command: new ListReply() },
      ],
    });
  }
}
