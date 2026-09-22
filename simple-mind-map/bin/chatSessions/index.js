const store = require('./store')
const http = require('./http')

module.exports = {
  initSchema: store.initSchema,
  handleApi: http.handleApi,
  listConversations: store.listConversations,
  replaceConversations: store.replaceConversations,
  actorFromReq: store.actorFromReq
}
