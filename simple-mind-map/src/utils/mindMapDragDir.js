/* global module:readonly */

function resolveMindMapDropDir({
  layout,
  overlapIsRoot,
  siblingIsFirstLevel,
  siblingDir,
  pointerX,
  rootCenterX
} = {}) {
  if (layout !== 'mindMap') return null
  if (overlapIsRoot) {
    if (typeof pointerX === 'number' && typeof rootCenterX === 'number') {
      return pointerX < rootCenterX ? 'left' : 'right'
    }
    return 'right'
  }
  if (siblingIsFirstLevel) {
    if (siblingDir === 'left' || siblingDir === 'right') return siblingDir
    if (typeof pointerX === 'number' && typeof rootCenterX === 'number') {
      return pointerX < rootCenterX ? 'left' : 'right'
    }
  }
  return null
}

const api = {
  resolveMindMapDropDir
}

module.exports = api
module.exports.default = api
