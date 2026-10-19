// Permission rules for the file knowledge base.
//
// 1. Roles, high to low: owner > manager > editor > viewer.
// 2. A direct grant for a subject replaces every inherited grant for that same subject,
//    even when the direct role is lower.
// 3. With no direct grant, walk folder ancestors from nearest to farthest.
//    The first grant found for that subject wins.
// 4. inherit=false on a file ignores its folder. inherit=false on a folder keeps that
//    folder's own grants and blocks grants from its parent.
// 5. A person gets the highest role among their user grant and every team they belong to.
// 6. owner_user_id is always owner. An ACL row cannot downgrade that anchor.
// 7. Token scope can only narrow access. It never adds a role the user does not have now.
// 8. Nothing is cached. Revocation is visible on the next query.

const ROLE_RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 }
const ACTION_ROLE = {
  view: 'viewer',
  download: 'viewer',
  reparse: 'editor',
  upload: 'editor',
  create: 'editor',
  rename: 'editor',
  remove: 'manager',
  grant: 'manager',
  inherit: 'manager',
  transfer: 'owner'
}

function rank(role) {
  return ROLE_RANK[role] || 0
}

function nameFromRank(value) {
  if (value >= 4) return 'owner'
  if (value === 3) return 'manager'
  if (value === 2) return 'editor'
  if (value === 1) return 'viewer'
  return null
}

function allows(role, action) {
  return rank(role) >= rank(ACTION_ROLE[action])
}

function findGrant(grants, resourceType, resourceId, subjectType, subjectId) {
  return (grants || []).find(grant =>
    grant.resourceType === resourceType &&
    grant.resourceId === resourceId &&
    grant.subjectType === subjectType &&
    grant.subjectId === subjectId
  )
}

function subjectRole(resource, ancestors, grants, subjectType, subjectId) {
  const direct = findGrant(grants, resource.type, resource.id, subjectType, subjectId)
  if (direct) return direct.role
  if (!resource.inherit) return null
  for (const folder of ancestors || []) {
    const grant = findGrant(grants, 'folder', folder.id, subjectType, subjectId)
    if (grant) return grant.role
    if (!folder.inherit) return null
  }
  return null
}

function effectiveRole(resource, ancestors, grants, userId, teamIds) {
  if (!resource || resource.ownerUserId === userId) return resource && resource.ownerUserId === userId ? 'owner' : null
  const subjects = [['user', userId]].concat((teamIds || []).map(id => ['team', id]))
  let best = 0
  subjects.forEach(([type, id]) => {
    best = Math.max(best, rank(subjectRole(resource, ancestors, grants, type, id)))
  })
  return nameFromRank(best)
}

module.exports = {
  ROLE_RANK,
  ACTION_ROLE,
  rank,
  allows,
  subjectRole,
  effectiveRole
}
