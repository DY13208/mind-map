import { mockRequest, mockStore, requiredItem } from './mockStore'
import { C3_SERVICE_STATUS_MATRIX } from './serviceStatus'
const membersFor = id => {
  requiredItem(mockStore.teams, id, '团队空间')
  return mockStore.teamMembers[id]
}
const roomsFor = id => {
  requiredItem(mockStore.teams, id, '团队空间')
  return mockStore.rooms.filter(room => !room.deletedAt && room.spaceId === id)
}
export default {
  backendStatus: C3_SERVICE_STATUS_MATRIX.Team,
  listSpaces: () =>
    mockRequest(() =>
      mockStore.teams.map(team => ({
        ...team,
        memberCount: membersFor(team.id).length,
        roomCount: roomsFor(team.id).length
      }))
    ),
  getSpace: id =>
    mockRequest(() => requiredItem(mockStore.teams, id, '团队空间')),
  listMembers: id => mockRequest(() => membersFor(id)),
  listRooms: id => mockRequest(() => roomsFor(id)),
  listFolders: id =>
    mockRequest(() =>
      mockStore.folders
        .filter(folder =>
          roomsFor(id).some(room => room.folderId === folder.id)
        )
        .map(folder => ({
          ...folder,
          roomCount: roomsFor(id).filter(room => room.folderId === folder.id)
            .length
        }))
    ),
  updateMemberRole: (spaceId, id, role) =>
    mockRequest(() => {
      if (!['Editor', 'Viewer'].includes(role))
        throw new Error('请选择 Editor 或 Viewer')
      const member = requiredItem(membersFor(spaceId), id, '成员')
      member.role = role
      return member
    }),
  removeMember: (spaceId, id) =>
    mockRequest(() => {
      const members = membersFor(spaceId)
      requiredItem(members, id, '成员')
      members.splice(
        members.findIndex(item => item.id === id),
        1
      )
      return { ok: true }
    })
}
