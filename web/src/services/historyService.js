import { mockRequest, mockStore, requiredItem } from './mockStore'
export default {
  listVersions: roomId =>
    mockRequest(() =>
      mockStore.versions.filter(item => item.roomId === roomId)
    ),
  getVersion: (roomId, id) =>
    mockRequest(() =>
      requiredItem(
        mockStore.versions.filter(item => item.roomId === roomId),
        id,
        '版本'
      )
    ),
  restoreVersion: (roomId, id) =>
    mockRequest(() => {
      requiredItem(
        mockStore.versions.filter(item => item.roomId === roomId),
        id,
        '版本'
      )
      return { ok: true, versionId: id, mock: true }
    })
}
