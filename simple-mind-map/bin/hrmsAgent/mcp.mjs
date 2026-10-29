export function registerHrmsTools(server,{api,z,ok,fail}){
 server.tool('hrms_api',
 '人事系统个人接口。先catalog分页查目录，describe查看available及限制。普通用户只能查询本人；管理员可在资料和考勤接口params中指定employee档案ID代查同公司员工，由HRMS实际管理角色和员工文档读取权限判定，不能传入自称管理员的参数。当前仅开放已核验的资料和考勤接口，其余查询拦截。考勤须from_date/to_date最多31天；last_out不能单独证明加班真实性。大结果complete=false须read_page续读。写入默认关闭，不能由工具开启。以后经管理员启用后，prepare创建固定参数计划；将confirmation_url（相对脑图服务地址）交本人在已登录浏览器打开、核对并点击确认，然后execute只传plan_id。Agent传confirmed=true或口头确认不能替代页面授权；不能由Agent代开页面确认。prepare无业务写入。超时或unknown/running用status核对，禁止换ID重试。manual/internal接口须到页面办理。脑图审批仍用approval_request。凭据不返回Agent。',
 {action:z.enum(['catalog','describe','query','read_page','prepare','execute','status']),operation:z.string().optional(),params:z.record(z.unknown()).optional(),keyword:z.string().max(200).optional(),cursor:z.string().optional(),operation_id:z.string().uuid().optional(),plan_id:z.string().uuid().optional()},
 async input=>{try{
  const response=await api('/api/integrations/hrms/agent',{method:'POST',body:JSON.stringify(input)})
  return ok(response.item || response)
 }catch(e){return {...fail(e),structuredContent:{code:e.code || 'HRMS_ERROR',message:e.message,statusCode:e.statusCode || 400}}}})
}
