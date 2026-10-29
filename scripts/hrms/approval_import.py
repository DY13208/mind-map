"""Import only completed WCPD probation documents; no employee-master changes."""
import base64
import hashlib
import json
import re
from datetime import date

import frappe
from frappe.utils import get_datetime, now_datetime

ROLE = "WCPD Approval Importer"


def build_process_snapshot(snapshot):
    """Display external approval as a completed flow without inventing human approvals."""
    return {"nodes": [
        {"id": "start", "type": "start", "label": "脑图申请发起", "props": {}},
        {"id": "end", "type": "end", "label": "脑图审批已通过", "props": {}},
    ], "source": "wcpd", "externalApproval": snapshot}


def _employee(ref, company):
    ref = str(ref or "").strip()
    if not ref or len(ref) > 160:
        frappe.throw("员工标识无效")
    for field in ("name", "hr_wecom_id", "employee_number", "employee_name"):
        rows = frappe.get_all("Employee", filters={field: ref, "company": company, "status": "Active"}, fields=["name", "employee_name", "user_id"], limit_page_length=2)
        if len(rows) > 1:
            frappe.throw("员工匹配不唯一，请使用员工编号或企微账号")
        if rows:
            return rows[0]
    frappe.throw("未找到本公司唯一在职员工")


@frappe.whitelist(methods=["POST"])
def import_approved(payload: dict):
    frappe.only_for(ROLE)
    if isinstance(payload, str):
        payload = json.loads(payload)
    company = payload.get("company")
    allowed = frappe.get_all("User Permission", filters={"user": frappe.session.user, "allow": "Company"}, pluck="for_value")
    if not company or company not in allowed:
        frappe.throw("未授权同步该公司的审批单", frappe.PermissionError)
    expected_corp = frappe.conf.get("wcpd_approval_corp_id")
    if not expected_corp or payload.get("corpId") != expected_corp:
        frappe.throw("审批来源企业不匹配", frappe.PermissionError)
    request_id = str(payload.get("requestId") or "")
    round_no = payload.get("round")
    if not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", request_id) or type(round_no) is not int or not 1 <= round_no <= 10000:
        frappe.throw("审批来源编号或轮次无效")
    if payload.get("version") != 1 or payload.get("status") != "approved" or payload.get("title") != "转正申请表":
        frappe.throw("仅允许同步已通过的转正申请表")
    source_key = f"{request_id}:{round_no}"
    name = "wcpd-" + hashlib.sha256(source_key.encode()).hexdigest()[:32]
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    fields = payload.get("fields") or {}
    employee = _employee(fields.get("员工") or fields.get("员工姓名") or fields.get("员工编号") or fields.get("申请员工"), company)
    # Serialize imports for an employee, including simultaneous retries with the same source key.
    frappe.db.sql("select name from `tabEmployee` where name=%s for update", (employee.name,))
    if frappe.db.exists("Approval Instance", name):
        existing = frappe.get_doc("Approval Instance", name)
        evidence = json.loads(existing.hook_result_json or "{}")
        if evidence.get("wcpd_digest") != digest or existing.status != "已通过":
            frappe.throw("来源单据已同步但内容不同，请人工核对，不能覆盖")
        old_process = json.loads(existing.process_snapshot_json or "{}")
        if old_process.get("source") == "wcpd" and not old_process.get("nodes"):
            existing.process_snapshot_json = json.dumps(build_process_snapshot(evidence.get("source")), ensure_ascii=False)
            existing.save(ignore_permissions=True)
        return {"name": name, "applicationNo": existing.application_no, "status": existing.status, "sourceKey": source_key, "duplicate": True}
    requester = _employee((payload.get("requester") or {}).get("wecom_userid"), company)
    if not requester.user_id or not frappe.db.get_value("User", requester.user_id, "enabled"):
        frappe.throw("发起员工未绑定有效的人事系统账号")
    try:
        start = date.fromisoformat(str(fields.get("试用期开始日") or "").replace("/", "-"))
        end = date.fromisoformat(str(fields.get("试用期结束日") or "").replace("/", "-"))
        if end < start:
            raise ValueError()
    except ValueError:
        frappe.throw("试用期开始日或结束日无效")
    attachments = payload.get("attachments") or []
    if not isinstance(attachments, list) or len(attachments) > 10:
        frappe.throw("附件数量无效")
    from employee_roster.hr_roster.approval_engine.schema import DEFAULT_ATTACHMENT_EXTENSIONS
    decoded = []
    total = 0
    for item in attachments:
        filename = str(item.get("fileName") or "").replace("\\", "/").split("/")[-1]
        if not filename or len(filename) > 200 or filename.rsplit(".", 1)[-1].lower() not in DEFAULT_ATTACHMENT_EXTENSIONS:
            frappe.throw("附件文件名或类型不允许")
        encoded = item.get("contentBase64") or ""
        if len(encoded) > 28 * 1024 * 1024:
            frappe.throw("附件过大")
        content = base64.b64decode(encoded, validate=True)
        total += len(content)
        if total > 20 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != item.get("hash"):
            frappe.throw("附件过大或内容校验失败")
        decoded.append((filename, content))
    forms = frappe.get_all("Approval Form", filters={"form_name": "转正申请表", "status": "使用中"}, pluck="name", limit_page_length=2)
    if len(forms) != 1:
        frappe.throw("人事系统转正申请表未启用或存在多个同名模板")
    schema = {"fields": [
        {"key": "employee", "label": "员工", "type": "employee", "required": 1},
        {"key": "probation_start", "label": "试用期开始日", "type": "date", "required": 1},
        {"key": "probation_end", "label": "试用期结束日", "type": "date", "required": 1},
        {"key": "self_summary", "label": "审批来源说明", "type": "textarea"},
        {"key": "attachment", "label": "转正评分表及附件", "type": "attachment"},
    ]}
    data = {"employee": employee.name, "probation_start": start.isoformat(), "probation_end": end.isoformat(), "self_summary": "由WCPD脑图审批通过后同步。实际转正日期仍由人事确认。", "attachment": []}
    evidence = {"wcpd_source_key": source_key, "wcpd_digest": digest, "company": company, "source": payload.get("snapshot"), "source_fields": fields}
    instance = frappe.get_doc({"doctype": "Approval Instance", "application_no": f"WCPD-{request_id}-{round_no}", "approval_form": forms[0], "form_title": "转正申请表", "status": "已通过", "applicant_user": requester.user_id, "applicant_employee": employee.name, "current_node_id": "end", "current_node_label": "脑图审批已通过", "finished_on": get_datetime(payload.get("approvedAt")) if payload.get("approvedAt") else now_datetime(), "submitted_at": now_datetime(), "form_schema_json": json.dumps(schema, ensure_ascii=False), "form_data_json": json.dumps(data, ensure_ascii=False), "process_snapshot_json": json.dumps(build_process_snapshot(payload.get("snapshot")), ensure_ascii=False), "hook_result_json": json.dumps(evidence, ensure_ascii=False)})
    instance.insert(ignore_permissions=True, set_name=name)
    from frappe.utils.file_manager import save_file
    for filename, content in decoded:
        file_doc = save_file(filename, content, "Approval Instance", name, is_private=1)
        data["attachment"].append({"url": file_doc.file_url, "name": file_doc.file_name})
    instance.form_data_json = json.dumps(data, ensure_ascii=False)
    instance.save(ignore_permissions=True)
    # No runtime start/complete call: preserve the external approval evidence, do not fabricate human tasks.
    return {"name": name, "applicationNo": instance.application_no, "status": instance.status, "sourceKey": source_key}
