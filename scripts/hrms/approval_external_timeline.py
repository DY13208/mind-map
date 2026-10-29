"""Read-only timeline projection of authenticated WCPD import evidence.

These rows are display records, not Frappe approval tasks or notification receipts.
"""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

import frappe


def _local_time(value):
    if not value:
        return value
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if isinstance(parsed, datetime) and parsed.tzinfo:
        return parsed.astimezone(ZoneInfo(frappe.utils.get_system_timezone())).replace(tzinfo=None)
    return parsed


def external_timeline(instance):
    process = json.loads(instance.process_snapshot_json or "{}")
    evidence = json.loads(instance.hook_result_json or "{}")
    if process.get("source") != "wcpd" or not evidence.get("wcpd_source_key") or not evidence.get("wcpd_digest"):
        return []
    snapshot = evidence.get("source") or {}
    audit = snapshot.get("audit") or []
    submit = next((event for event in reversed(audit) if event.get("action") == "submit"), {})
    submitted = (submit.get("detail") or {}).get("snapshot") or {}
    resolved = snapshot.get("ccResolved") or (submitted.get("report") or {}).get("ccResolved") or []
    names = {person["account"]: person.get("name") or person["account"] for person in snapshot.get("people", []) if person.get("account")}
    names.update({person["account"]: person.get("name") or person["account"] for person in resolved if person.get("account")})
    company = evidence.get("company")

    def display(account):
        if account in names:
            return names[account]
        # Legacy imports stored the WeCom ID directly. Resolve only in this company's directory.
        rows = frappe.get_all("Employee", filters={"hr_wecom_id": account, "company": company}, fields=["employee_name"], limit_page_length=2) if account and company else []
        return rows[0].employee_name if len(rows) == 1 else (account or "未记录账号")

    rows = []

    def add(label, assignee, status, comment, when, kind):
        rows.append({"name": f"{instance.name}-external-{len(rows)}", "node_id": f"external-{len(rows)}", "node_label": label, "task_type": kind, "assignee": assignee, "status": status, "action": "外部审批记录", "comment": comment, "acted_on": _local_time(when), "creation": _local_time(when), "external": True})

    if submit:
        add("脑图申请发起", display(submit.get("actor_id")), "已提交", "来自脑图已提交材料及审批记录", submit.get("created_at") or instance.submitted_at, "external")
    completed_at = instance.finished_on
    for event in audit:
        detail = event.get("detail") or {}
        when = event.get("created_at") or instance.finished_on
        if event.get("action") == "submit" and (detail.get("automaticDecision") or {}).get("decision") == "approve":
            rule = (detail["automaticDecision"].get("rule") or {}).get("text") or "原节点自动同意规则"
            add("脑图规则自动通过", "系统（自动同意，无人工审批人）", "已通过", rule, when, "external")
            completed_at = when
        elif event.get("action") == "decide":
            status = {"approve": "已同意", "reject": "已驳回", "return": "已退回"}.get(detail.get("decision"))
            if status:
                add(detail.get("role") or "脑图人工审批", display(event.get("actor_id")), status, detail.get("reason") or "", when, "external")
                completed_at = when
    cc = list(dict.fromkeys(snapshot.get("cc") or submitted.get("cc") or []))
    for account in cc:
        binding = next((person for person in resolved if person.get("account") == account), {})
        origin = binding.get("source") or "脑图审批快照"
        role = binding.get("role") or "抄送"
        add(f"抄送：{role}", display(account), "已登记", f"来源：{origin}。此处同步原审批抄送名单，不代表人事系统已另行发送通知。", completed_at, "external_cc")
    return rows
