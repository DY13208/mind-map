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
  const brief = {
    request_id: id,
    revision,
    round,
    status,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.slice(0, 80) : value
      ])
    ),
    current_step,
    source: template.source,
    validation: {
      ...out.validation,
      missing: (out.validation.missing || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64)),
      blockers: (out.validation.blockers || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64)),
      warnings: (out.validation.warnings || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64)),
      configurationRequired: (out.validation.configurationRequired || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64))
    },
    steps: steps.map(s => ({
      role: s.role.slice(0, 80),
      uid: s.uid,
      assigneeId: String(s.assigneeId || '').slice(0, 200),
      criterion_count: s.criteria.length
    })),
    truncated: true,
    next:
      '请用定向节点读取工具按source和步骤uid读取原文；审批历史在消息中心查看'
  }
  if (Buffer.byteLength(JSON.stringify(brief)) <= 48000) return brief
  return {
    request_id: id,
    revision,
    round,
    status,
    current_step,
    source: template.source,
    truncated: true,
    field_count: Object.keys(fields).length,
    validation: {
      nodeInputHash: report.nodeInputHash,
      blocker_count: (report.blockers || []).length,
      configuration_count: (report.configurationRequired || []).length,
      publication: report.publication
    },
    next: '材料体积过大，请在审批页核对完整材料；当前脑图文字不能替代已提交快照'
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

function compactTemplate(tpl) {
  const result = {
    title: tpl.title,
    kind: tpl.kind,
    source: tpl.source,
    fingerprint: tpl.fingerprint,
    fields: tpl.fields,
    steps: tpl.steps,
    ccBindings: tpl.ccBindings,
    configurationErrors: tpl.configurationErrors,
    publication: tpl.publication,
    canPublish: tpl.canPublish
  }
  if (Buffer.byteLength(JSON.stringify(result)) <= 48000) return result
  return {
    title: tpl.title,
    kind: tpl.kind,
    source: tpl.source,
    fingerprint: tpl.fingerprint,
    fields: tpl.fields.map(f => ({
      uid: f.uid,
      key: f.key,
      label: f.label.slice(0, 120),
      type: f.type,
      required: f.required
    })),
    steps: tpl.steps.map(s => ({
      uid: s.uid,
      role: s.role.slice(0, 120),
      criterion_count: s.criteria.length
    })),
    truncated: true,
    next: '使用定向节点读取按source及步骤uid分页获取原文，不要读取整张脑图'
  }
}
export function registerApprovalTools(server, { api, z, ok, fail }) {
  server.tool(
    'approval_request',
    '通用脑图原生审批，不限定模板所在目录。先resolve匹配用户意图或catalog分页发现当前身份可访问的模板（hasMore必须继续nextCursor）；模板以直属子节点“流程标识：名称或编号”登记，并在该模板内写申请字段、审批流程、审核要点和审批配置。多个候选必须展示来源供用户选择，不擅自选第一个；没有模板或人员缺失必须提示待配置。template读取实际字段和稳定key；prepare必须传所选template_source，仅生成草稿与申请资料子节点，不通知审批人。用户或获授权AI只编辑脑图字段和值，随后import读取权威节点并校验；不另建表单。submit前展示本次字段、附件及流程，获得用户明确提交指令，使用当前revision、validation.nodeInputHash、唯一operation_id；结果未知先status查询，不能换ID盲重试。analysis仅为辅助建议，正式决定由当前审核人登录页面办理。本版通用流程执行顺序审批，不把条件分支或会签默认为顺序。',
    {
      action: z.enum([
        'catalog',
        'resolve',
        'template',
        'prepare',
        'import',
        'submit',
        'status',
        'analysis',
        'members'
      ]),
      text: z
        .string()
        .max(500)
        .optional()
        .describe('resolve时的用户明确申请意图'),
      cursor: z.string().optional(),
      template_source: z
        .object({ room_key: z.string(), node_uid: z.string() })
        .optional()
        .describe('resolve/catalog返回的source；多候选须先由用户确定'),
      room_key: z
        .string()
        .optional()
        .describe('prepare时用户自己的申请节点所在房间'),
      node_uid: z
        .string()
        .optional()
        .describe('prepare时申请节点，不能用制度模板节点'),
      request_id: z
        .string()
        .uuid()
        .optional(),
      expected_revision: z
        .number()
        .int()
        .optional(),
      expected_node_hash: z.string().optional(),
      operation_id: z
        .string()
        .uuid()
        .optional(),
      confirm_submission: z.boolean().optional(),
      analysis: z
        .string()
        .max(10000)
        .optional()
    },
    async input => {
      try {
        let result
        const source = input.template_source && {
          roomKey: input.template_source.room_key,
          nodeUid: input.template_source.node_uid
        }
        if (input.action === 'catalog')
          result = await api(
            '/api/workflow-catalog?limit=20' +
              (input.cursor
                ? '&cursor=' + encodeURIComponent(input.cursor)
                : '')
          )
        else if (input.action === 'resolve')
          result = await api('/api/workflow-resolve', {
            method: 'POST',
            body: JSON.stringify({ text: input.text })
          })
        else if (input.action === 'members')
          result = await api(
            '/api/leave-members?q=' + encodeURIComponent(input.text || '')
          )
        else if (input.action === 'template') {
          if (!source) throw new Error('请先resolve/catalog确定template_source')
          const out = await api(
            '/api/workflow-template?' +
              new URLSearchParams({
                source_room: source.roomKey,
                source_node: source.nodeUid
              })
          )
          return ok(compactTemplate(out.item || out))
        } else if (input.action === 'prepare') {
          if (!source)
            throw new Error(
              'prepare须明确提供template_source，不能默认路由到请假'
            )
          result = await api('/api/workflow-requests', {
            method: 'POST',
            body: JSON.stringify({
              roomKey: input.room_key,
              nodeUid: input.node_uid,
              source
            })
          })
        } else {
          if (!input.request_id) throw new Error('请先prepare取得request_id')
          const path =
            '/api/workflow-requests/' + encodeURIComponent(input.request_id)
          if (input.action === 'status') result = await api(path)
          else {
            if (!input.operation_id || input.expected_revision == null)
              throw new Error(
                '写入须带operation_id和expected_revision；结果未知先status查询'
              )
            result = await api(path + '/' + input.action, {
              method: 'POST',
              body: JSON.stringify({
                expectedRevision: input.expected_revision,
                operationId: input.operation_id,
                nodeSource: input.action === 'submit',
                expectedNodeHash: input.expected_node_hash,
                confirmSubmission: input.confirm_submission === true,
                content: input.analysis
              })
            })
          }
        }
        return ok(
          input.action === 'catalog' ||
            input.action === 'resolve' ||
            input.action === 'members'
            ? result
            : compactLeaveResult(result)
        )
      } catch (error) {
        return {
          ...fail(error),
          structuredContent: {
            code: error.code || 'WORKFLOW_ERROR',
            message: error.message,
            statusCode: error.statusCode || 400
          }
        }
      }
    }
  )
}
