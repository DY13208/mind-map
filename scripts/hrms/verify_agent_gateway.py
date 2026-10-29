"""Offline permission/attendance regression: no HRMS connection or writes."""
import importlib.util
import json
import sys
import types
import os
import base64
import hashlib
import hmac
import time
from datetime import date
from pathlib import Path


class Denied(Exception):
    pass


calls = []
expected_employee = "EMP-ONE"
roles = ["Employee"]
employee_read_allowed = False
frappe = types.ModuleType("frappe")
frappe.PermissionError = Denied
frappe.session = types.SimpleNamespace(user="personal@example.test")
frappe.whitelist = lambda **kw: lambda f: f
frappe.throw = lambda message, kind=ValueError: (_ for _ in ()).throw(kind(message))
def get_all(table, **kw):
    if table == "Employee":
        return [types.SimpleNamespace(name="EMP-ONE", company="测试公司")]
    assert kw["filters"]["employee"] == expected_employee, "Attendance must be filtered before reading"
    return [types.SimpleNamespace(employee=expected_employee, attendance_date="2026-10-28", time="2026-10-28", last_out="21:00")]
frappe.get_all = get_all
frappe.db = types.SimpleNamespace(get_value=lambda *a, **kw: "wecom-one", exists=lambda *a: True)
frappe.get_doc = lambda table, name: {"name": name, "company": "其他公司" if name == "EMP-FOREIGN" else "测试公司", "employee_name": "合成员工", "manager": "must-not-return", "bank_account": "must-not-return"}
frappe.has_permission = lambda *a, **kw: employee_read_allowed
frappe.get_roles = lambda *a: roles
frappe.conf = {}
used = set()
def reserve(key, value, **kw):
    if key in used:
        return False
    used.add(key)
    return True
frappe.cache = lambda: types.SimpleNamespace(set=reserve)
def invoke_native(operation, **params):
    calls.append((operation, params))
    return {"source": "企业微信", "range": {}, "summaries": {"EMP-ONE|2026-10-28": {"employee": "EMP-ONE", "last_out": "21:00"}, "EMP-OTHER|2026-10-28": {"employee": "EMP-OTHER", "last_out": "22:00"}}}
frappe.call = invoke_native
utils = types.ModuleType("frappe.utils")
utils.getdate = date.fromisoformat
sys.modules["frappe"] = frappe
sys.modules["frappe.utils"] = utils
native = types.ModuleType("employee_roster.hr_roster.api.employee_checkin_dashboard")
native._summarize_employee_day = lambda key, logs, daily: {"employee": key[0], "last_out": "21:00"}
sys.modules[native.__name__] = native
spec = importlib.util.spec_from_file_location("agent_api", Path(__file__).with_name("agent_api.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
catalog = json.loads((Path(__file__).parents[2] / "simple-mind-map/bin/hrmsAgent/catalog.json").read_text(encoding="utf-8"))
gateway._catalog = lambda: {item["id"]: item for item in catalog}
gateway._own_reads = lambda: set(json.loads((Path(__file__).parents[2] / "simple-mind-map/bin/hrmsAgent/ownReads.json").read_text(encoding="utf-8")))

def denied(call):
    try:
        call()
        raise AssertionError("Unauthorized call accepted")
    except (Denied, ValueError):
        pass

checkin = "employee_roster.hr_roster.api.employee_checkin_dashboard.get_checkin_dashboard"
dates = {"from_date": "2026-10-28", "to_date": "2026-10-28"}
result = gateway.invoke(checkin, dates, company="测试公司")
assert list(result["summaries"]) == ["EMP-ONE|2026-10-28"]
assert "stats" not in result
before = len(calls)
denied(lambda: gateway.invoke(checkin, {**dates, "employee": "EMP-OTHER"}, company="测试公司"))
roles = ["HR Manager"]
denied(lambda: gateway.invoke(checkin, {**dates, "employee": "EMP-OTHER"}, company="测试公司"))
employee_read_allowed = True
expected_employee = "EMP-OTHER"
delegated = gateway.invoke(checkin, {**dates, "employee": "EMP-OTHER"}, company="测试公司")
assert delegated["employee"] == "EMP-OTHER" and all(row["employee"] == "EMP-OTHER" for row in delegated["summaries"].values())
delegated_profile = gateway.invoke("employee_roster.hr_roster.api.employee_center.get_context", {"employee": "EMP-OTHER"}, company="测试公司")
assert delegated_profile["scope"] == "authorized_employee" and delegated_profile["employee"]["name"] == "EMP-OTHER"
denied(lambda: gateway.invoke(checkin, {**dates, "employee": "EMP-FOREIGN"}, company="测试公司"))
roles = ["Employee"]
denied(lambda: gateway.invoke(checkin, {**dates, "employee": "EMP-OTHER"}, company="测试公司"))
expected_employee = "EMP-ONE"
denied(lambda: gateway.invoke(checkin, {**dates, "to_date": "2027-01-01"}, company="测试公司"))
denied(lambda: gateway.invoke(checkin, dates, company="其他公司"))
denied(lambda: gateway.invoke(checkin, {**dates, "user": "other"}, company="测试公司"))
denied(lambda: gateway.invoke("employee_roster.hr_roster.page.roster.roster.get_roster_data", {}, company="测试公司"))
denied(lambda: gateway.invoke("employee_roster.hr_roster.approval_runtime.complete_approval_task", {}, mode="write", company="测试公司"))
assert len(calls) == before
operation = "employee_roster.hr_roster.api.employee_center.save_application"
os.environ.pop("HRMS_AGENT_WRITES_ENABLED", None)
denied(lambda: gateway.invoke(operation, {}, mode="preview", company="测试公司"))
denied(lambda: gateway.invoke(operation, {}, mode="write", company="测试公司"))
os.environ["HRMS_AGENT_WRITES_ENABLED"] = "true"
preview = gateway.invoke(operation, {"application_type": "subsidy", "payload": {}, "submit": False}, mode="preview", company="测试公司")
assert not preview["business_write_executed"] and len(calls) == before
denied(lambda: gateway.invoke(operation, {}, mode="read", company="测试公司"))
profile = gateway.invoke("employee_roster.hr_roster.api.personal_center.get_context", {}, company="测试公司")
assert profile["employee"]["name"] == "EMP-ONE" and "manager" not in profile["employee"] and "bank_account" not in profile["employee"]
denied(lambda: gateway.invoke(operation, {}, mode="write", company="测试公司"))
key = "synthetic-local-test-exchange-key-only"
os.environ["EXTERNAL_API_EXCHANGE_KEY"] = key
def proof(**changes):
    claims = {"operation": operation, "params": {}, "wecom_userid": "wecom-one", "plan_id": "synthetic-plan", "expires": int(time.time()) + 120, **changes}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return payload + "." + hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()
denied(lambda: gateway.invoke(operation, {}, mode="write", company="测试公司", authorization=proof(wecom_userid="other")))
denied(lambda: gateway.invoke(operation, {}, mode="write", company="测试公司", authorization=proof(params={"tampered": 1})))
denied(lambda: gateway.invoke(operation, {}, mode="write", company="测试公司", authorization=proof(expires=int(time.time()) - 1)))
gateway.invoke(operation, {}, mode="write", company="测试公司", authorization=proof())
denied(lambda: gateway.invoke(operation, {}, mode="write", company="测试公司", authorization=proof()))
assert len(calls) == before + 1
print(json.dumps({"ok": True, "employeeScopedAtDatabase": True, "regularUsersSelfOnly": True, "authorizedAdminDelegation": True, "adminDocumentPermissionRequired": True, "crossCompanyDenied": True, "profileFieldAllowlist": True, "writesDefaultDisabled": True, "signedPageAuthorizationRequired": True, "replayBlocked": True, "offline": True}))
