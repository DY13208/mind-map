"""Run in the local bench: regression tests roll back all database changes."""
import json
import uuid
import frappe

frappe.init(site="hrms.localhost", sites_path="/home/frappe/frappe-bench/sites")
frappe.connect()
try:
    from employee_roster.integrations.approval_import import build_process_snapshot, import_approved
    from employee_roster.hr_roster.approval_runtime import get_workspace_detail
    from employee_roster.hr_roster.approval_engine.process_schema import normalize_process
    source = frappe.get_doc("Approval Instance", "wcpd-f8a490bcb2f17c0f35511ef91a1e31ac")
    evidence = json.loads(source.hook_result_json)
    source.process_snapshot_json = json.dumps(build_process_snapshot(evidence["source"]), ensure_ascii=False)
    source.save(ignore_permissions=True)
    frappe.set_user(source.applicant_user)
    detail = get_workspace_detail(instance_name=source.name)
    assert [node["type"] for node in detail["instance"]["process"]["nodes"]] == ["start", "end"]
    assert detail["instance"]["status"] == "已通过" and not detail["can_cancel"]
    assert not detail["task"]
    assert any(row["node_label"] == "脑图规则自动通过" and "无人工审批人" in row["assignee"] for row in detail["timeline"])
    assert any(row["assignee"].startswith("范麟祥") and row["task_type"] == "external_cc" for row in detail["timeline"])
    assert any(row["assignee"].startswith("李吉兵") and row["task_type"] == "external_cc" for row in detail["timeline"])
    assert not frappe.db.exists("Approval Task", {"instance": source.name})
    assert detail["instance"]["hook_result"] == evidence
    from employee_roster.integrations.approval_external_timeline import external_timeline
    from copy import deepcopy
    sample = deepcopy(evidence)
    sample["source"]["audit"] = [
        {"action": "submit", "actor_id": "subject", "created_at": "2026-10-28T01:00:00Z", "detail": {}},
        {"action": "decide", "actor_id": "reviewer", "created_at": "2026-10-28T02:00:00Z", "detail": {"role": "财务审核", "decision": "approve", "reason": "已核对原始附件"}},
    ]
    sample["source"]["people"] = [{"account": "subject", "name": "测试发起人"}, {"account": "reviewer", "name": "测试实际审核人"}]
    projected = frappe._dict(name="test-display", process_snapshot_json=source.process_snapshot_json, hook_result_json=json.dumps(sample), submitted_at=source.submitted_at, finished_on=source.finished_on)
    manual = external_timeline(projected)
    assert any(row["assignee"] == "测试实际审核人" and row["comment"] == "已核对原始附件" and row["status"] == "已同意" for row in manual)
    assert not any("自动通过" in row["node_label"] for row in manual)
    assert manual[0]["acted_on"].hour == 9
    projected.process_snapshot_json = json.dumps({"nodes": [{"id": "end", "type": "end"}]})
    assert external_timeline(projected) == []
    frappe.set_user("wcpd-approval-importer@integration.local")
    payload = {"version": 1, "requestId": str(uuid.uuid4()), "round": 1, "company": evidence["company"], "corpId": frappe.conf.wcpd_approval_corp_id, "title": "转正申请表", "status": "approved", "requester": {"wecom_userid": "liangzhenxing"}, "fields": evidence["source_fields"], "attachments": [], "snapshot": evidence["source"]}
    result = import_approved(payload)
    created = frappe.get_doc("Approval Instance", result["name"])
    assert len(normalize_process(created.process_snapshot_json)["nodes"]) == 2
    # Regression: a previously imported empty display flow is repaired on an idempotent replay.
    created.process_snapshot_json = json.dumps({"nodes": [], "source": "wcpd"})
    created.save(ignore_permissions=True)
    repeat = import_approved(payload)
    assert repeat["duplicate"] and repeat["name"] == result["name"]
    frappe.set_user(source.applicant_user)
    new_detail = get_workspace_detail(instance_name=created.name)
    assert len(new_detail["instance"]["process"]["nodes"]) == 2
    print(json.dumps({"ok": True, "existingDetailOpens": True, "newImportDetailOpens": True, "duplicateRepairsEmptyProcess": True, "approvalEvidenceUnchanged": True, "noHumanTasksCreated": True, "rolledBack": True}))
finally:
    frappe.db.rollback()
    frappe.destroy()
