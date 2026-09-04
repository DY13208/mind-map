import { rooms } from '../mocks/rooms'
import { folders } from '../mocks/folders'
import { versions } from '../mocks/history'
import { teams } from '../mocks/teams'
import { members } from '../mocks/members'
const clone = value =>
  value === undefined ? null : JSON.parse(JSON.stringify(value))
export const mockStore = {
  rooms: clone(rooms),
  folders: clone(folders),
  teams: clone(teams),
  versions: rooms.flatMap(room =>
    versions.map(version => ({
      ...clone(version),
      id: room.id + '-' + version.id,
      roomId: room.id
    }))
  ),
  roomMembers: Object.fromEntries(
    rooms.map(room => [
      room.id,
      [
        {
          ...clone(members.find(member => member.id === room.owner.id)),
          role: 'Owner'
        },
        ...room.collaborators.map(person => ({
          ...clone(members.find(member => member.id === person.id)),
          role: person.id === 'u1' ? room.role : 'Editor'
        }))
      ]
    ])
  ),
  teamMembers: Object.fromEntries(
    teams.map(team => [
      team.id,
      clone(members).map(member => ({
        ...member,
        role:
          member.name === team.owner
            ? 'Owner'
            : member.role === 'Owner'
            ? 'Editor'
            : member.role
      }))
    ])
  )
}
let sequence = 0
let failure = ''
let latency = 120
// Isolated mock diagnostics, never production API or collaboration state.
export const mockControl = {
  failNext(message = '演示列表加载失败') {
    failure = message
  },
  setLatency(ms) {
    latency = Math.max(0, ms)
  }
}
export const mockRequest = work =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        if (failure) {
          const message = failure
          failure = ''
          throw new Error(message)
        }
        resolve(clone(work()))
      } catch (error) {
        reject(error)
      }
    }, latency)
  )
export const makeId = prefix =>
  prefix + '-' + Date.now().toString(36) + '-' + ++sequence
export const requiredItem = (items, id, label) => {
  const item = items.find(row => row.id === id)
  if (!item) throw new Error(label + '不存在或已删除')
  return item
}
export const validName = value => {
  const name = String(value || '').trim()
  if (!name || name.length > 60) throw new Error('名称需为 1 至 60 个字符')
  return name
}
