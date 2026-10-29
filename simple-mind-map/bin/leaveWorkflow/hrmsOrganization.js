const ENDPOINT = '/api/method/employee_roster.integrations.approval_directory.resolve_hrbp'
const HEAD_ENDPOINT = '/api/method/employee_roster.integrations.approval_directory.resolve_department_head'
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
function role(value) {
  const text = String(value || '').replace(/\s+/g,'')
  if (/^(?:对应(?:的)?|部门|本部门|员工对应的)?hrbp$/i.test(text)) return 'hrbp'
  if (/^(?:默认|对应(?:的)?)?it$/i.test(text)) return 'it'
  // 部门负责人：沿组织往上找第一个登记了负责人的单元（由 resolve_department_head 解析）
  if (/^(?:部门|本部门|直属)?(?:负责人|主管)$/.test(text)) return 'head'
  if (/^部门经理$/.test(text)) return 'head'
  return ''
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
module.exports = {config,role,resolveHrbp,resolveDepartmentHead}
