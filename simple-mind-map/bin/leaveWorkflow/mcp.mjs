// Keep MCP responses within a bounded context; full audit history stays in the UI.
export function compactLeaveResult(result) {
  const row = (result && result.item) || result
  if (!row || !row.id || !row.template) return result
  const {
    id,
    revision,
    round,
    status,
    fields,
    current_step,
    steps,
    cc,
    report,
    template
  } = row
  const out = {
    request_id: id,
    revision,
    round,
    status,
    fields,
    current_step,
    steps,
    cc,
    source: template.source,
    required_fields: template.fields,
    leave_types: template.types,
    calendar: template.calendar,
    validation: {
      nodeInputHash: report.nodeInputHash,
      missing: report.missing,
      blockers: report.blockers,
      warnings: report.warnings,
      configurationRequired: report.configurationRequired,
      publication: report.publication,
      minutes: report.minutes,
      hours: report.hours,
      days: report.days,
      attachments: report.attachments
    },
    attachmentEvidence: row.attachmentEvidence,
    recent_events: (row.history || []).slice(-5).map(e => ({
      action: e.action,
      actor: e.actor_id,
      at: e.created_at,
      detail: {
        ...e.detail,
        content: e.detail.content && e.detail.content.slice(0, 800)
      }
    }))
  }
  if (Buffer.byteLength(JSON.stringify(out)) <= 48000) return out
  return {
    request_id: id,
    revision,
    round,
    status,
    fields,
    current_step,
    source: template.source,
    validation: out.validation,
    steps: steps.map(s => ({
      role: s.role,
      uid: s.uid,
      assigneeId: s.assigneeId,
      criterion_count: s.criteria.length
    })),
    truncated: true,
    next:
      '请用定向节点读取工具按source和步骤uid读取原文；审批历史在消息中心查看'
  }
}
export function registerLeaveTools(server, { api, z, ok, fail }) {
  server.tool(
    'leave_request',
    '脑图请假闭环。遇到“我要请假/申请年假”等意图，先prepare读取公司登记的请假制度、必要条件、审批要点与人员配置，提示缺失信息。prepare会在自己的申请节点下生成“申请资料→字段→待填写”，用户或获授权AI只能编辑这些脑图节点，再import读取校验；不要另建填写表单。save仅兼容为import核对，不向独立字段副本写入。人员须先members查询真实账号；缺少流程/人员配置时展示configurationRequired，不能猜人或跳过。准备好后核对最终数据，获得用户明确提交指令再submit并携带validation.nodeInputHash，节点变化必须重新核对。AI可analysis写入针对当前步骤/原文依据的建议，建议不等于正式审批；审核人只能登录页面办理。所有写入使用个人MCP令牌，不能使用共享服务令牌。不要把私密材料正文写入公共图。status返回正式状态，编辑“已通过”文字不会审批。',
    {
      action: z.enum([
        'prepare',
        'save',
        'import',
        'submit',
        'status',
        'analysis',
        'members'
      ]),
      room_key: z
        .string()
        .optional()
        .describe('prepare时：用户自己的申请节点所在房间'),
      node_uid: z
        .string()
        .optional()
        .describe('prepare时：我要请假节点UID，禁止使用制度节点'),
      request_id: z
        .string()
        .uuid()
        .optional(),
      fields: z
        .object({
          leaveType: z.string().optional(),
          start: z
            .string()
            .optional()
            .describe('明确日期时间，例如2026-10-20T09:00'),
          end: z.string().optional(),
          replacementId: z
            .string()
            .optional()
            .describe('members返回的真实user_id'),
          reason: z.string().optional(),
          attachmentIds: z
            .array(z.string())
            .max(10)
            .optional()
        })
        .optional(),
      expected_revision: z
        .number()
        .int()
        .optional(),
      operation_id: z
        .string()
        .uuid()
        .optional(),
      expected_node_hash: z
        .string()
        .optional()
        .describe(
          'import/status返回的validation.nodeInputHash，submit必须与已核对节点一致'
        ),
      confirm_submission: z
        .boolean()
        .optional()
        .describe('仅在用户已核对材料并明确要求提交后为true'),
      analysis: z
        .string()
        .max(10000)
        .optional()
        .describe(
          'AI辅助建议，逐项引用实际审核要点与本次资料，不编造余额/证明或审批结论'
        ),
      query: z
        .string()
        .max(80)
        .optional()
    },
    async input => {
      try {
        if (input.action === 'members')
          return ok(
            await api(
              '/api/leave-members?q=' + encodeURIComponent(input.query || '')
            )
          )
        if (input.action === 'prepare')
          return ok(
            compactLeaveResult(
              await api('/api/leave-requests', {
                method: 'POST',
                body: JSON.stringify({
                  roomKey: input.room_key,
                  nodeUid: input.node_uid
                })
              })
            )
          )
        if (!input.request_id) throw new Error('请先prepare取得request_id')
        const path =
          '/api/leave-requests/' + encodeURIComponent(input.request_id)
        if (input.action === 'status')
          return ok(compactLeaveResult(await api(path)))
        if (!input.operation_id || input.expected_revision == null)
          throw new Error(
            '写入必须提供operation_id与expected_revision，超时后先status查询，不盲目重建'
          )
        return ok(
          compactLeaveResult(
            await api(
              path + '/' + (input.action === 'save' ? 'import' : input.action),
              {
                method: 'POST',
                body: JSON.stringify({
                  expectedFields: input.fields,
                  nodeSource: input.action === 'submit',
                  expectedNodeHash: input.expected_node_hash,
                  operationId: input.operation_id,
                  expectedRevision: input.expected_revision,
                  confirmSubmission: input.confirm_submission === true,
                  content: input.analysis
                })
              }
            )
          )
        )
      } catch (error) {
        return {
          ...fail(error),
          structuredContent: {
            code: error.code || 'LEAVE_ERROR',
            message: error.message,
            statusCode: error.statusCode || 400
          }
        }
      }
    }
  )
}
