export const rooms = [
  {
    id: 'growth-plan',
    roomKey: 'growth-plan',
    title: '2026 增长策略脑图',
    folderId: 'strategy',
    folderName: '战略规划',
    owner: { id: 'u1', name: '李依然', avatar: '依' },
    collaborators: [
      { id: 'u2', name: '陈晨', avatar: '陈' },
      { id: 'u3', name: '周舟', avatar: '周' }
    ],
    role: 'Owner',
    favorite: true,
    sharedWithMe: false,
    createdAt: '2026-08-12T09:20:00+08:00',
    updatedAt: '2026-09-04T10:30:00+08:00',
    lastOpenedAt: '2026-09-04T11:05:00+08:00',
    deletedAt: null
  },
  {
    id: 'product-roadmap',
    roomKey: 'product-roadmap',
    title: '产品路线图',
    folderId: 'product',
    folderName: '产品研发',
    owner: { id: 'u2', name: '陈晨', avatar: '陈' },
    collaborators: [
      { id: 'u1', name: '李依然', avatar: '依' },
      { id: 'u4', name: '王玥', avatar: '王' }
    ],
    role: 'Editor',
    favorite: false,
    sharedWithMe: true,
    createdAt: '2026-07-02T13:00:00+08:00',
    updatedAt: '2026-09-03T16:42:00+08:00',
    lastOpenedAt: '2026-09-03T17:02:00+08:00',
    deletedAt: null
  },
  {
    id: 'client-workshop',
    roomKey: 'client-workshop',
    title: '客户共创工作坊',
    folderId: 'customers',
    folderName: '客户项目',
    owner: { id: 'u3', name: '周舟', avatar: '周' },
    collaborators: [{ id: 'u1', name: '李依然', avatar: '依' }],
    role: 'Viewer',
    favorite: true,
    sharedWithMe: true,
    createdAt: '2026-06-18T10:00:00+08:00',
    updatedAt: '2026-09-01T14:18:00+08:00',
    lastOpenedAt: '2026-09-02T09:15:00+08:00',
    deletedAt: null
  },
  {
    id: 'team-weekly',
    roomKey: 'team-weekly',
    title: '团队周会纪要',
    folderId: null,
    folderName: '根目录',
    owner: { id: 'u1', name: '李依然', avatar: '依' },
    collaborators: [{ id: 'u2', name: '陈晨', avatar: '陈' }],
    role: 'Owner',
    favorite: false,
    sharedWithMe: false,
    createdAt: '2026-08-22T09:00:00+08:00',
    updatedAt: '2026-08-30T18:06:00+08:00',
    lastOpenedAt: '2026-08-30T18:06:00+08:00',
    deletedAt: null
  },
  {
    id: 'old-campaign',
    roomKey: 'old-campaign',
    title: '旧活动复盘',
    folderId: 'marketing',
    folderName: '市场营销',
    owner: { id: 'u1', name: '李依然', avatar: '依' },
    collaborators: [],
    role: 'Owner',
    favorite: false,
    sharedWithMe: false,
    createdAt: '2026-04-11T12:00:00+08:00',
    updatedAt: '2026-07-20T10:00:00+08:00',
    lastOpenedAt: '2026-07-20T10:00:00+08:00',
    deletedAt: '2026-08-29T15:10:00+08:00'
  }
].map(room => ({
  ...room,
  spaceId: room.id === 'client-workshop' ? 'brand-center' : 'still-product'
}))
