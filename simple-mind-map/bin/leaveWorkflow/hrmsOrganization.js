const ENDPOINT = '/api/method/employee_roster.integrations.approval_directory.resolve_hrbp'
const HEAD_ENDPOINT = '/api/method/employee_roster.integrations.approval_directory.resolve_department_head'
const DIRECTORY_ENDPOINT = '/api/method/employee_roster.integrations.approval_directory.resolve_directory'
// 职责/部门反查：只在节点写明前缀时才启用，避免把真实姓名误当职位。
const DIRECTORY_SPEC = /^(职务|职位|岗位|部门成员|部门人员|部门)[:：](.+)$/
const DIRECTORY_KIND = {职务:'designation',职位:'designation',岗位:'designation',部门成员:'department',部门人员:'department',部门:'department'}
function config(env = process.env) {
  let base = ''
  try {
    const url = new URL(env.HRMS_ORG_API_BASE || '')
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) base = url.origin
  } catch (_) { /* explicitly configured connection only */ }
  const apiKey = String(env.HRMS_ORG_API_KEY || '')
  const apiSecret = String(env.HRMS_ORG_API_SECRET || '')
  const company = String(env.HRMS_ORG_COMPANY || '').trim()
  const corpId = String(env.HRMS_ORG_CORP_ID || '').trim()
  return {base,apiKey,apiSecret,company,corpId,ready:!!base && !!company && !!corpId && /^[A-Za-z0-9]{8,128}$/.test(apiKey) && /^[A-Za-z0-9]{8,128}$/.test(apiSecret)}
}
// 节点文本可能带「·」「-」等分隔前缀（例如「抄送·总经理」剥掉「抄送」后剩「·总经理」）。
function clean(value) {
  return String(value || '').replace(/\s+/g,'').replace(/^[·・\-—_:：]+/,'')
}
function role(value) {
  const text = clean(value)
  if (/^(?:对应(?:的)?|部门|本部门|员工对应的)?hrbp$/i.test(text)) return 'hrbp'
  if (/^(?:默认|对应(?:的)?)?it$/i.test(text)) return 'it'
  // 部门负责人：沿组织往上找第一个登记了负责人的单元（由 resolve_department_head 解析）
  if (/^(?:部门|本部门|直属)?(?:负责人|主管)$/.test(text)) return 'head'
  if (/^部门经理$/.test(text)) return 'head'
  // 职务/部门反查：如「职务：总经理」「部门成员：人事组」「职务：VP@季翔」
  if (DIRECTORY_SPEC.test(text)) return 'directory'
  return ''
}
/** 解析「职务：X」「部门成员：X」「职务：VP@季翔」；@ 后面是多人时的姓名限定。 */
function directorySpec(value) {
  const text = clean(value)
  const matched = text.match(DIRECTORY_SPEC)
  if (!matched) return null
  const kind = DIRECTORY_KIND[matched[1]] || 'designation'
  const body = matched[2]
  const at = body.indexOf('@')
  const query = (at === -1 ? body : body.slice(0, at)).trim()
  const names = (at === -1 ? '' : body.slice(at + 1)).split(/[、,，]/).map(x => x.trim()).filter(Boolean)
  if (!query) return null
  return {kind,query,names}
}
/** Frappe 把业务错误放在 _server_messages 里，状态码是 417；抽出来给用户看人话。 */
function frappeMessage(payload) {
  try {
    const raw = payload && payload._server_messages
    if (!raw) return ''
    const first = JSON.parse(raw)[0]
    return String((JSON.parse(first) || {}).message || '')
      .replace(/<[^>]*>/g, '')
      .trim()
  } catch (_) {
    return ''
  }
}
async function callDirectory(cfg, spec, options = {}) {
  const url = new URL(DIRECTORY_ENDPOINT, cfg.base)
  url.searchParams.set('query', spec.query)
  url.searchParams.set('kind', spec.kind)
  url.searchParams.set('company', cfg.company)
  const response = await (options.fetchImpl || fetch)(url, {
    method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Accept:'application/json',Authorization:`token ${cfg.apiKey}:${cfg.apiSecret}`}
  })
  if (!response.ok) {
    let payload = null
    try { payload = await response.json() } catch (_) { /* 非 JSON 就走通用提示 */ }
    throw new Error(frappeMessage(payload) || `人事组织查询失败（HTTP ${response.status}），请检查只读账号和组织权限`)
  }
  return await response.json()
}
/**
 * 职务/部门反查成员（抄送「总经理」「人事组」这类角色名用）。
 * 返回全部命中成员；是否唯一由调用方判断——审核人必须唯一，抄送可以多个。
 */
async function resolveDirectory(spec, corpId, options = {}) {
  const cfg = config(options.env)
  if (!cfg.ready) throw new Error('人事组织架构只读接口尚未配置')
  if (cfg.corpId !== corpId) throw new Error('人事组织架构与当前企业不匹配')
  if (!spec || !spec.query) throw new Error('请填写要查询的职务或部门名称')
  const payload = await callDirectory(cfg, spec, options)
  const result = payload && payload.message
  if (!result || result.company !== cfg.company || !Array.isArray(result.members))
    throw new Error('人事组织未返回有效的成员列表')
  let members = result.members.filter(
    m => m && m.status === 'Active' && m.name && /^[A-Za-z0-9_.@-]{1,64}$/.test(m.wecomUserId || '')
  )
  if (!members.length) throw new Error(`「${spec.query}」未找到在职且绑定企微账号的成员`)
  if (spec.names && spec.names.length) {
    const wanted = new Set(spec.names)
    members = members.filter(m => wanted.has(m.name))
    if (!members.length)
      throw new Error(`「${spec.query}」里没有登记为 ${spec.names.join('、')} 的成员`)
  }
  return {company:result.company,query:result.query,kind:result.kind,members}
}
async function resolveHrbp(employeeRef, corpId, options = {}) {
  const cfg = config(options.env)
  if (!cfg.ready) throw new Error('人事组织架构只读接口尚未配置')
  if (cfg.corpId !== corpId) throw new Error('人事组织架构与当前企业不匹配')
  const ref = String(employeeRef || '').trim()
  if (!ref || ref.length > 160) throw new Error('请先在提交要求中填写唯一的员工姓名或员工编号')
  const url = new URL(ENDPOINT,cfg.base)
  url.searchParams.set('employee_ref',ref)
  url.searchParams.set('company',cfg.company)
  const response = await (options.fetchImpl || fetch)(url, {
    method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Accept:'application/json',Authorization:`token ${cfg.apiKey}:${cfg.apiSecret}`}
  })
  if (!response.ok) throw new Error(`人事组织查询失败（HTTP ${response.status}），请检查只读账号和组织权限`)
  const payload = await response.json()
  const result = payload && payload.message
  if (!result || result.company !== cfg.company || !result.employee || !result.department ||
      !result.hrbp || result.hrbp.status !== 'Active' || !result.hrbp.name ||
      !/^[A-Za-z0-9_.@-]{1,64}$/.test(result.hrbp.wecomUserId || ''))
    throw new Error('人事组织未返回唯一、在职且绑定企微账号的HRBP')
  return result
}

/** 部门负责人：与 resolveHrbp 对称，返回 result.head（含企微账号）。 */
async function resolveDepartmentHead(employeeRef, corpId, options = {}) {
  const cfg = config(options.env)
  if (!cfg.ready) throw new Error('人事组织架构只读接口尚未配置')
  if (cfg.corpId !== corpId) throw new Error('人事组织架构与当前企业不匹配')
  const ref = String(employeeRef || '').trim()
  if (!ref || ref.length > 160) throw new Error('请先在提交要求中填写唯一的员工姓名或员工编号')
  const url = new URL(HEAD_ENDPOINT,cfg.base)
  url.searchParams.set('employee_ref',ref)
  url.searchParams.set('company',cfg.company)
  const response = await (options.fetchImpl || fetch)(url, {
    method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Accept:'application/json',Authorization:`token ${cfg.apiKey}:${cfg.apiSecret}`}
  })
  if (!response.ok) throw new Error(`人事组织查询失败（HTTP ${response.status}），请检查只读账号和组织权限`)
  const payload = await response.json()
  const result = payload && payload.message
  const head = result && result.head
  if (!result || result.company !== cfg.company || !result.employee || !result.department ||
      !head || head.status !== 'Active' || !head.name ||
      !/^[A-Za-z0-9_.@-]{1,64}$/.test(head.wecomUserId || ''))
    throw new Error('人事组织未返回唯一、在职且绑定企微账号的部门负责人')
  return result
}
module.exports = {config,role,directorySpec,resolveHrbp,resolveDepartmentHead,resolveDirectory}
