import { members } from '../mocks/members'
import { mockRequest } from './mockStore'
export default { getProfile: () => mockRequest(() => members[0]) }
