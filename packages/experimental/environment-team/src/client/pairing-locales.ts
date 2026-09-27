/** Invitation creation, transfer, import, and revocation copy. */
export const pairingEn = {
  publicUrl: 'This machine’s reachable HTTPS URL', invitationLifetimeMs: 'Invitation lifetime (ms)', maxInvitations: 'Retained pairing invitations',
  pairingTitle: 'Pair machines with an invitation',
  pairingHelp: 'Save this machine’s reachable URL first. Create an invitation for the intended machine, then privately paste it into that machine’s Plugins page. Each machine chooses its own access grants.',
  pairingTargetId: 'Invited machine ID', pairingTargetUrl: 'Invited machine URL', pairingPermissions: 'Access to grant on this machine',
  pairingWorkspaces: 'Directories to grant', pairingNoWorkspaces: 'Save at least one directory alias to grant workspace access.',
  pairingCreate: 'Create invitation', pairingOutput: 'Private invitation — shown once', pairingHide: 'Hide private invitation',
  pairingInput: 'Paste an invitation for this machine', pairingAccept: 'Accept invitation', pairingRetryHelp: 'If completion cannot be confirmed, keep the same invitation and grants and retry. Existing connections are never replaced.',
  pairingRefresh: 'Refresh invitations', pairingRevoke: 'Revoke invitation', pairingEmpty: 'No invitations have been issued.',
  pairingForget: 'Discard unfinished pairing',
  pairingLoadingFailed: 'Could not load invitations. Refresh to try again.', pairingInvalidId: 'Enter the invited machine’s complete ID.',
  pairingChanged: 'Pairing updated.', pairingFailed: 'Could not complete pairing. Check the invitation, machine addresses, and access settings.',
  pairingPending: 'Waiting for acceptance', pairingRedeeming: 'Acceptance in progress', pairingConsumed: 'Accepted', pairingRevoked: 'Revoked', pairingExpired: 'Expired',
  pairingWorkspaceManagement: 'Grant workspace browsing and creation', pairingSessionAccess: 'Grant session access',
  pairingAttachmentAccess: 'Grant attachment access', pairingApprovalAccess: 'Grant approval responses', pairingTerminalAccess: 'Grant terminal access',
  pairingTeamAccess: 'Grant team dashboard access', pairingTeamOperate: 'Grant team controls',
}

/** Chinese invitation lifecycle copy. */
export const pairingZh: typeof pairingEn = {
  publicUrl: '本机可访问的 HTTPS 地址', invitationLifetimeMs: '邀请有效期（毫秒）', maxInvitations: '保留的配对邀请数量',
  pairingTitle: '通过邀请配对机器',
  pairingHelp: '先保存本机可访问的地址。为目标机器创建邀请，再私下将邀请粘贴到该机器的插件页面。每台机器分别选择授予对方的权限',
  pairingTargetId: '受邀机器 ID', pairingTargetUrl: '受邀机器地址', pairingPermissions: '授予对方的本机权限',
  pairingWorkspaces: '授权目录', pairingNoWorkspaces: '请先保存至少一个目录别名，以授予工作区访问权限',
  pairingCreate: '创建邀请', pairingOutput: '私密邀请 — 仅显示一次', pairingHide: '隐藏私密邀请',
  pairingInput: '粘贴发给本机的邀请', pairingAccept: '接受邀请', pairingRetryHelp: '如果无法确认配对完成，请保留相同的邀请和权限后重试。已有连接不会被替换',
  pairingRefresh: '刷新邀请', pairingRevoke: '撤销邀请', pairingEmpty: '尚未发出邀请',
  pairingForget: '丢弃未完成的配对',
  pairingLoadingFailed: '无法加载邀请，请刷新重试', pairingInvalidId: '请输入受邀机器的完整 ID',
  pairingChanged: '配对已更新', pairingFailed: '无法完成配对，请检查邀请、机器地址和权限设置',
  pairingPending: '等待接受', pairingRedeeming: '正在接受', pairingConsumed: '已接受', pairingRevoked: '已撤销', pairingExpired: '已过期',
  pairingWorkspaceManagement: '授予工作区浏览和创建权限', pairingSessionAccess: '授予会话访问权限',
  pairingAttachmentAccess: '授予附件访问权限', pairingApprovalAccess: '授予审批响应权限', pairingTerminalAccess: '授予终端访问权限',
  pairingTeamAccess: '授予团队面板访问权限', pairingTeamOperate: '授予团队控制权限',
}
