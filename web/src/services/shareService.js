import { mockRequest, mockStore, makeId, requiredItem } from './mockStore'
const membersFor = roomId => {
  requiredItem(mockStore.rooms, roomId, '脑图')
  return mockStore.roomMembers[roomId]
}
const syncCollaborators = roomId => {
  const room = requiredItem(mockStore.rooms, roomId, '脑图')
  room.collaborators = membersFor(roomId)
    .filter(member => member.id !== room.owner.id)
    .map(({ id, name, avatar }) => ({ id, name, avatar }))
}
export default {
  getMembers: roomId => mockRequest(() => membersFor(roomId)),
  addMember: (roomId, emailOrUserId, role = 'Viewer') =>
    mockRequest(() => {
      const email = String(emailOrUserId || '').trim()
      if (!['Editor', 'Viewer'].includes(role))
        throw new Error('请选择 Editor 或 Viewer')
      if (!email || email.length > 128)
        throw new Error('请输入有效的邮箱或 userid')
      const members = membersFor(roomId)
      if (members.some(member => member.email === email))
        throw new Error('该成员已在共享列表中')
      const member = {
        id: makeId('member'),
        name: email.split('@')[0],
        avatar: email[0].toUpperCase(),
        email,
        role,
        joinedAt: new Date().toISOString().slice(0, 10)
      }
      members.push(member)
      syncCollaborators(roomId)
      return member
    }),
  updateMemberRole: (roomId, id, role) =>
    mockRequest(() => {
      if (!['Editor', 'Viewer'].includes(role))
        throw new Error('请选择 Editor 或 Viewer')
      const member = requiredItem(membersFor(roomId), id, '成员')
      member.role = role
      return member
    }),
  removeMember: (roomId, id) =>
    mockRequest(() => {
      const members = membersFor(roomId)
      requiredItem(members, id, '成员')
      members.splice(
        members.findIndex(item => item.id === id),
        1
      )
      syncCollaborators(roomId)
      return { ok: true }
    })
}
