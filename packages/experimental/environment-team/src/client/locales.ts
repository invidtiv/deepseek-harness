/** English and Chinese copy for environment deployment configuration. */
export const en = {
  'read-only': 'Read only', 'workspace-write': 'Workspace write', 'danger-full-access': 'Full access', ask: 'Ask for approval', never: 'Never ask',
  title: 'Environment teams', description: 'Connect Harness installations and configure where remote teammates work.',
  coordinator: 'Start a team on the machine that should coordinate it. Every paired machine can coordinate its own teams.',
  identity: 'Environment ID', label: 'Machine label', provider: 'Model provider', model: 'Model', agentPreset: 'Agent preset',
  sandboxMode: 'Sandbox mode', approvalPolicy: 'Approval policy', workspaces: 'Local checkouts', alias: 'Project alias', path: 'Local directory',
  peers: 'Paired machines', environmentId: 'Peer environment ID', url: 'Tailscale HTTPS URL', grants: 'Allowed project aliases (comma separated)',
  secret: 'Pairing secret', secretHelp: 'Use the same secret on both machines, with at least 32 bytes. A blank field keeps the saved secret. Secret changes take effect even if saving the configuration fails.',
  addWorkspace: 'Add checkout', addPeer: 'Add machine', remove: 'Remove', save: 'Save configuration', reload: 'Reload',
  loadingFailed: 'Could not load configuration.', saveFailed: 'Could not save configuration.', saved: 'Configuration saved.',
  changed: 'Saving reloads the team runtime and stops its active workers. Queued messages remain saved.',
  limits: 'Limits', requestTimeoutMs: 'Request timeout (ms)', retryIntervalMs: 'Delivery retry interval (ms)',
  maxBytes: 'Message and record limit (bytes)', maxTeams: 'Retained teams', maxMembers: 'Members per team', maxTasks: 'Tasks per team', maxOperations: 'Retained operations per team',
  invalidWorkspace: 'Checkout aliases must be unique and non-empty.', invalidNumber: 'Limits must be positive whole numbers.',
}
/** Keys available to this page's typed locale binding. */
export type EnvironmentSettingsKey = keyof typeof en
/** Chinese translation of the configuration page. */
export const zh: Record<EnvironmentSettingsKey, string> = {
  'read-only': '只读', 'workspace-write': '工作区写入', 'danger-full-access': '完全访问', ask: '请求审批', never: '从不请求',
  title: '跨环境团队', description: '连接 Harness 实例，配置远程队友的工作位置。',
  coordinator: '在需要担任协调端的机器上启动团队。每台已配对的机器都可以协调自己的团队。',
  identity: '环境 ID', label: '机器名称', provider: '模型提供方', model: '模型', agentPreset: '智能体预设',
  sandboxMode: '沙箱模式', approvalPolicy: '审批策略', workspaces: '本地检出目录', alias: '项目别名', path: '本地目录',
  peers: '已配对机器', environmentId: '对端环境 ID', url: 'Tailscale HTTPS 地址', grants: '允许的项目别名（逗号分隔）',
  secret: '配对密钥', secretHelp: '两台机器使用相同密钥，至少 32 字节。留空可保留已保存的密钥。即使配置保存失败，密钥修改仍会生效。',
  addWorkspace: '添加检出目录', addPeer: '添加机器', remove: '移除', save: '保存配置', reload: '重新加载',
  loadingFailed: '无法加载配置', saveFailed: '无法保存配置', saved: '配置已保存',
  changed: '保存会重新加载团队运行时并停止其活动队友。排队消息仍会保留。',
  limits: '限制', requestTimeoutMs: '请求超时（毫秒）', retryIntervalMs: '投递重试间隔（毫秒）',
  maxBytes: '消息和记录上限（字节）', maxTeams: '保留团队数', maxMembers: '每个团队的成员数', maxTasks: '每个团队的任务数', maxOperations: '每个团队保留的操作数',
  invalidWorkspace: '检出目录别名必须唯一且非空', invalidNumber: '限制必须为正整数',
}
