const external = require('../hrmsExternalApi')

const ENDPOINT = '/api/v1/hrms/external/directory/hrbp'
const HEAD_ENDPOINT = '/api/v1/hrms/external/directory/head'
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
  // 新系统走换票（Bearer），不再用 token key:secret；凭据由 hrmsExternalApi 校验，
  // 这里只要求地址、公司、企业三件套齐全。
  return {base,apiKey,apiSecret,company,corpId,ready:!!base && !!company && !!corpId}
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
/** 解析「职务：X」「部门成员：人事组」「职务：VP@季翔」；@ 后面是多人时的姓名限定。 */
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
/**
 * 新系统统一封装 {code, success, msg, data}；错误优先取人话 msg。
 * 保留老 Frappe 的 _server_messages 解析，过渡期仍可能收到。
 */
function apiMessage(payload) {
  try {
    if (payload && typeof payload.msg === 'string' && payload.msg) return payload.msg
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
/**
 * 调用 directory 接口。新系统只认员工ID/工号/企微userid，不认中文姓名；
 * 外部 Token 默认只能查本人（查他人需要 HR 辖区授权，否则返回 403）。
 */
async function callPerson(pathname, employeeRef, cfg, options = {}) {
  const response = await external.callApi(pathname, {
    env: options.env,
    user: options.user,
    fetchImpl: options.fetchImpl,
    searchParams: {company: cfg.company, employee_ref: employeeRef}
  })
  const body = response && response.data
  if (!body || body.success === false)
    throw new Error(apiMessage(body) || '人事组织查询失败，请检查只读账号和组织权限')
  if (!body.data) throw new Error('人事组织未返回有效的成员信息')
  return body.data
}
async function resolveDirectory(spec, corpId, options = {}) {
  const cfg = config(options.env)
  if (!cfg.ready) throw new Error('人事组织架构只读接口尚未配置')
  if (cfg.corpId !== corpId) throw new Error('人事组织架构与当前企业不匹配')
  if (!spec || !spec.query) throw new Error('请填写要查询的职务或部门名称')
  // 新系统（YR-HRMS）不提供「按职务/部门反查成员」的对外端点：
  // README 明确没有可指定任意公司的公开目录端点。给出可操作的替代写法。
  throw new Error(
    `人事系统不再提供按「${spec.query}」反查成员的接口；` +
    `请把该节点改成具体人员，或写成「部门负责人」「对应HRBP」由组织架构解析`
  )
}
async function resolveHrbp(employeeRef, corpId, options = {}) {
  const cfg = config(options.env)
  if (!cfg.ready) throw new Error('人事组织架构只读接口尚未配置')
  if (cfg.corpId !== corpId) throw new Error('人事组织架构与当前企业不匹配')
  const ref = String(employeeRef || '').trim()
  if (!ref || ref.length > 160) throw new Error('请先在提交要求中填写唯一的员工姓名或员工编号')
  const result = await callPerson(ENDPOINT, ref, cfg, options)
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
  const result = await callPerson(HEAD_ENDPOINT, ref, cfg, options)
  const head = result && result.head
  if (!result || result.company !== cfg.company || !result.employee || !result.department ||
      !head || head.status !== 'Active' || !head.name ||
      !/^[A-Za-z0-9_.@-]{1,64}$/.test(head.wecomUserId || ''))
    throw new Error('人事组织未返回唯一、在职且绑定企微账号的部门负责人')
  return result
}
module.exports = {config,role,directorySpec,resolveHrbp,resolveDepartmentHead,resolveDirectory}
