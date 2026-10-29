"""Self reads, authorized same-company admin delegation, page-authorized writes."""
import base64
import hashlib
import hmac
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import frappe
from frappe.utils import getdate


def _catalog():
    return {item["id"]: item for item in json.loads(Path(__file__).with_name("agent_api_catalog.json").read_text(encoding="utf-8"))}


def _own_reads():
    return set(json.loads(Path(__file__).with_name("agent_api_own_reads.json").read_text(encoding="utf-8")))


def _read_employee(target, own_id, company):
    target = str(target or own_id)
    if target == own_id:
        return target
    # Never accept an admin flag from the caller. Both role and document scope apply.
    if not {"HR Manager", "System Manager", "Enterprise Admin"}.intersection(frappe.get_roles(frappe.session.user)):
        frappe.throw("普通用户只能查询本人信息，代查需要人事管理权限", frappe.PermissionError)
    doc = frappe.get_doc("Employee", target)
    if doc.get("company") != company or not frappe.has_permission("Employee", "read", doc=doc):
        frappe.throw("无权读取该员工或员工不属于当前公司", frappe.PermissionError)
    return target


def _write_authorization(value, operation, params, own_id):
    if os.environ.get("HRMS_AGENT_WRITES_ENABLED") != "true":
        frappe.throw("人事Agent写入默认关闭", frappe.PermissionError)
    key = os.environ.get("EXTERNAL_API_EXCHANGE_KEY") or frappe.conf.get("external_api_exchange_key", "")
    try:
        payload, signature = value.split(".")
        expected = hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not key or not hmac.compare_digest(expected, signature):
            raise ValueError()
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        wecom_id = frappe.db.get_value("Employee", own_id, "hr_wecom_id")
        if not wecom_id or claims["wecom_userid"] != wecom_id or claims["operation"] != operation or claims["params"] != params:
            raise ValueError()
        remaining = claims["expires"] - time.time()
        if not 0 < remaining <= 120 or not claims.get("plan_id"):
            raise ValueError()
        if not frappe.cache().set("hrms-agent-once:" + hashlib.sha256(claims["plan_id"].encode()).hexdigest(), "1", nx=True, ex=300):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        frappe.throw("缺少有效、未使用的本人页面授权", frappe.PermissionError)


def _own_attendance(employee, start, end):
    # Filter at the database, never fetch the whole-company dashboard.
    from employee_roster.hr_roster.api.employee_checkin_dashboard import _summarize_employee_day
    logs = frappe.get_all("Employee Checkin", filters={"employee": employee, "wecom_record_id": ["is", "set"], "time": ["between", [str(start) + " 00:00:00", str(end) + " 23:59:59.999999"]]}, fields=["name", "employee", "employee_name", "time", "log_type", "checkin_type", "wecom_record_id", "wecom_exception_type"], order_by="time asc", limit_page_length=10001)
    if len(logs) > 10000:
        frappe.throw("记录过多，请缩小日期范围")
    daily = []
    if frappe.db.exists("DocType", "WeCom Attendance Daily"):
        daily = frappe.get_all("WeCom Attendance Daily", filters={"employee": employee, "attendance_date": ["between", [start, end]]}, fields=["employee", "employee_name", "attendance_date", "regular_work_seconds", "attendance_result", "exception_codes", "group_name", "schedule_name", "raw_data"], limit_page_length=1001)
        if len(daily) > 1000:
            frappe.throw("日报记录过多，请缩小日期范围")
    grouped = defaultdict(list)
    for row in logs:
        grouped[(employee, str(getdate(row.time)))].append(row)
    days = {(employee, str(row.attendance_date)): row for row in daily}
    summaries = {"|".join(key): _summarize_employee_day(key, grouped.get(key, []), days.get(key)) for key in sorted(set(grouped) | set(days))}
    return {"source": "企业微信", "range": {"from_date": str(start), "to_date": str(end)}, "employee": employee, "summaries": summaries, "note": "仅本次授权员工考勤；last_out为当天最后一次打卡，不单独证明加班真实性"}


@frappe.whitelist(methods=["POST"])
def invoke(operation: str, params: dict | None = None, mode: str = "read", company: str | None = None, authorization: str | None = None):
    if frappe.session.user == "Guest":
        frappe.throw("请使用本人的人事身份", frappe.PermissionError)
    params = json.loads(params) if isinstance(params, str) else dict(params or {})
    item = _catalog().get(operation)
    if not item or item["policy"] not in {"read", "write"}:
        frappe.throw("该接口不允许Agent直接执行", frappe.PermissionError)
    if mode not in {"read", "write", "preview"} or (mode == "read" and item["policy"] != "read") or (mode in {"write", "preview"} and item["policy"] != "write"):
        frappe.throw("接口用途不匹配", frappe.PermissionError)
    allowed = set(item["params"]) | ({"employee"} if operation in _own_reads() else set())
    if set(params) - allowed:
        frappe.throw("包含未登记参数")
    own = frappe.get_all("Employee", filters={"user_id": frappe.session.user, "status": "Active", "company": company}, fields=["name", "company"], limit_page_length=2)
    if len(own) != 1 or not company or own[0].company != company:
        frappe.throw("当前用户未唯一绑定本公司在职员工", frappe.PermissionError)
    own_id = own[0].name
    if "company" in params and params["company"] != company:
        frappe.throw("不得跨公司调用", frappe.PermissionError)
    if mode == "preview":
        if os.environ.get("HRMS_AGENT_WRITES_ENABLED") != "true":
            frappe.throw("人事Agent写入默认关闭", frappe.PermissionError)
        return {"operation": operation, "params": params, "acting_user": frappe.session.user, "company": company, "effect": item["reason"], "business_write_executed": False}
    if mode == "write":
        _write_authorization(authorization, operation, params, own_id)
        return frappe.call(operation, **params)
    if operation not in _own_reads():
        frappe.throw("该接口未实现员工范围权限校验，不能查询", frappe.PermissionError)
    target = _read_employee(params.get("employee"), own_id, company)
    if item["name"] == "get_context":
        doc = frappe.get_doc("Employee", target)
        fields = ("name", "employee_name", "employee_number", "status", "company", "department", "designation", "date_of_joining", "cell_number", "personal_email", "company_email")
        return {"scope": "self_only" if target == own_id else "authorized_employee", "employee": {field: doc.get(field) for field in fields}}
    if item["name"] == "get_checkin_dashboard":
        if not params.get("from_date") or not params.get("to_date"):
            frappe.throw("考勤查询须明确from_date和to_date，范围不超过31天")
        start, end = getdate(params["from_date"]), getdate(params["to_date"])
        if end < start or (end - start).days > 30:
            frappe.throw("考勤查询范围须为1至31天")
        return _own_attendance(target, start, end)
    frappe.throw("未实现本人范围处理器", frappe.PermissionError)
