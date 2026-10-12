function isPersonalViewCommand(name, args = []) {
  if (['SET_NODE_EXPAND', 'EXPAND_ALL', 'UNEXPAND_ALL', 'UNEXPAND_TO_LEVEL'].includes(name)) return true
  const patch = args[1]
  return name === 'SET_NODE_DATA' && patch && typeof patch === 'object' &&
    Object.keys(patch).length > 0 &&
    Object.keys(patch).every(key => key === 'expand' || key === 'isActive')
}
module.exports = { isPersonalViewCommand }
