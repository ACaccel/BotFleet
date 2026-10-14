import { GroupedCommand } from '../grouped-command';
import RolePanelAction from '../role_message/action';
import TempRoleCreateAction from '../temp_role/action';
import TempRoleListAction from '../temp_role_list/action';
import TempRoleDeleteAction from '../temp_role_delete/action';
import LevelRoleSyncAction from '../update_role/action';

/** `/role`: ways for members to get roles. Each action keeps its own authorization. */
export default class Role extends GroupedCommand {
  constructor() {
    super({
      name: 'role',
      category: 'community',
      guildOnly: true,
      routes: [
        { name: 'panel', command: new RolePanelAction() },
        { name: 'sync', command: new LevelRoleSyncAction() },
        { group: 'temp', name: 'create', command: new TempRoleCreateAction() },
        { group: 'temp', name: 'list', command: new TempRoleListAction() },
        { group: 'temp', name: 'delete', command: new TempRoleDeleteAction() },
      ],
    });
  }
}
