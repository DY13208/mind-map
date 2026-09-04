import {
  mockRequest,
  mockStore,
  makeId,
  requiredItem,
  validName
} from './mockStore'
export default {
  listFolders: () =>
    mockRequest(() =>
      mockStore.folders.map(folder => ({
        ...folder,
        roomCount: mockStore.rooms.filter(
          room => room.folderId === folder.id && !room.deletedAt
        ).length
      }))
    ),
  createFolder: name =>
    mockRequest(() => {
      const folder = {
        id: makeId('folder'),
        name: validName(name),
        parentId: null,
        roomCount: 0,
        updatedAt: new Date().toISOString()
      }
      mockStore.folders.unshift(folder)
      return folder
    }),
  renameFolder: (id, value) =>
    mockRequest(() => {
      const folder = requiredItem(mockStore.folders, id, '文件夹')
      const name = validName(value)
      Object.assign(folder, { name, updatedAt: new Date().toISOString() })
      mockStore.rooms
        .filter(room => room.folderId === id)
        .forEach(room => {
          room.folderName = name
        })
      return folder
    }),
  deleteFolder: id =>
    mockRequest(() => {
      requiredItem(mockStore.folders, id, '文件夹')
      mockStore.rooms
        .filter(room => room.folderId === id)
        .forEach(room => {
          room.folderId = null
          room.folderName = '根目录'
        })
      mockStore.folders.splice(
        mockStore.folders.findIndex(folder => folder.id === id),
        1
      )
      return { ok: true }
    }),
  moveRoom: (roomId, folderId) =>
    mockRequest(() => {
      const room = requiredItem(mockStore.rooms, roomId, '脑图')
      const folder = folderId
        ? requiredItem(mockStore.folders, folderId, '文件夹')
        : null
      Object.assign(room, {
        folderId: folderId || null,
        folderName: folder ? folder.name : '根目录',
        updatedAt: new Date().toISOString()
      })
      return room
    })
}
