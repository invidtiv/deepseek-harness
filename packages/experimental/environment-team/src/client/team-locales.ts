/** Localized coordinator dashboard labels. */
export const teamEn = {
  teamDashboard: 'Distributed teams', teamDashboardHelp: 'View teams coordinated by the selected machine. Tasks and queued deliveries remain owned by that coordinator.',
  teamCatalog: 'Teams', noDistributedTeams: 'No distributed teams on this machine.', openTeam: 'Open team',
  teamWorkspace: 'Coordinator workspace', teamRoster: 'Members', teamTasks: 'Tasks', teamOutbox: 'Queued deliveries',
  teamNoTasks: 'No tasks yet.', teamNoDeliveries: 'No deliveries waiting for acceptance.',
  teamInterrupt: 'Interrupt member', teamInterrupted: 'Member interruption requested.', teamInterruptFailed: 'Could not confirm member interruption.',
  teamReadFailed: 'Could not refresh this coordinator. Check team access in Plugins, then refresh.',
  teamPending: 'Pending', teamInProgress: 'In progress', teamCompleted: 'Completed', teamRevision: 'Revision',
  teamOwner: 'Owner', teamSender: 'From', teamTarget: 'To',
}
/** Chinese dashboard labels with the same keys as English. */
export const teamZh: Record<keyof typeof teamEn, string> = {
  teamDashboard: '分布式团队', teamDashboardHelp: '查看所选机器协调的团队。任务与排队投递由该协调器持有。',
  teamCatalog: '团队', noDistributedTeams: '此机器上没有分布式团队。', openTeam: '打开团队',
  teamWorkspace: '协调器工作区', teamRoster: '成员', teamTasks: '任务', teamOutbox: '排队投递',
  teamNoTasks: '尚无任务。', teamNoDeliveries: '没有等待接收的投递。',
  teamInterrupt: '中断成员', teamInterrupted: '已请求中断成员', teamInterruptFailed: '无法确认成员中断',
  teamReadFailed: '无法刷新此协调器。请在插件中检查团队访问权限，然后刷新',
  teamPending: '待处理', teamInProgress: '进行中', teamCompleted: '已完成', teamRevision: '修订号',
  teamOwner: '负责人', teamSender: '发送者', teamTarget: '接收者',
}
