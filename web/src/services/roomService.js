import {
  mockRequest,
  mockStore,
  makeId,
  requiredItem,
  validName
} from './mockStore'
const find = id => requiredItem(mockStore.rooms, id, '脑图')
const update = (id, changes) => Object.assign(find(id), changes)
/** Product metadata only; no snapshots or collaboration operations. */
export default {
  listRooms: (filters = {}) =>
    mockRequest(() =>
      mockStore.rooms.filter(
        room =>
          (filters.trash ? !!room.deletedAt : !room.deletedAt) &&
          (!filters.favorite || room.favorite) &&
          (!filters.shared || room.sharedWithMe) &&
          (!filters.recent || !!room.lastOpenedAt) &&
          (!filters.role || room.role === filters.role) &&
          (filters.folderId === undefined || room.folderId === filters.folderId)
      )
    ),
  getRoom: id => mockRequest(() => find(id)),
  createRoom: (title, folderId = null) =>
    mockRequest(() => {
      const folder = folderId
        ? requiredItem(mockStore.folders, folderId, '文件夹')
        : null
      const id = makeId('room')
      const now = new Date().toISOString()
      const room = {
        id,
        roomKey: id,
        title: validName(title),
        folderId,
        folderName: folder ? folder.name : '根目录',
        owner: { id: 'u1', name: '李依然', avatar: '依' },
        collaborators: [],
        role: 'Owner',
        favorite: false,
        sharedWithMe: false,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: null,
        deletedAt: null
      }
      mockStore.rooms.unshift(room)
      mockStore.roomMembers[id] = [
        {
          ...room.owner,
          role: 'Owner',
          email: 'yiran@stillgroup.net',
          joinedAt: now.slice(0, 10)
        }
      ]
      return room
    }),
  renameRoom: (id, title) =>
    mockRequest(() =>
      update(id, {
        title: validName(title),
        updatedAt: new Date().toISOString()
      })
    ),
  markOpened: id =>
    mockRequest(() => update(id, { lastOpenedAt: new Date().toISOString() })),
  deleteRoom: id =>
    mockRequest(() => update(id, { deletedAt: new Date().toISOString() })),
  restoreRoom: id => mockRequest(() => update(id, { deletedAt: null })),
  permanentDelete: id =>
    mockRequest(() => {
      if (!find(id).deletedAt) throw new Error('只能永久删除回收站中的脑图')
      mockStore.rooms.splice(
        mockStore.rooms.findIndex(room => room.id === id),
        1
      )
      delete mockStore.roomMembers[id]
      mockStore.versions = mockStore.versions.filter(
        version => version.roomId !== id
      )
      return { ok: true }
    }),
  toggleFavorite: id =>
    mockRequest(() => update(id, { favorite: !find(id).favorite }))
}
