"""Provision a dedicated company-scoped API identity; never prints credentials."""
import json
import os
import frappe

ROLE = "WCPD Approval Importer"
USER = "wcpd-approval-importer@integration.local"
COMPANY = "深圳市依然电商科技有限公司"
frappe.init(site="hrms.localhost", sites_path="/home/frappe/frappe-bench/sites")
frappe.connect()
frappe.set_user("Administrator")
try:
    if not frappe.db.exists("Company", COMPANY):
        raise RuntimeError("Configured company does not exist")
    if frappe.get_all("DocPerm", filters={"role": ROLE}, limit_page_length=1):
        raise RuntimeError("Organization role unexpectedly has document CRUD permissions")
    if not frappe.db.exists("Role", ROLE):
        frappe.get_doc({"doctype": "Role", "role_name": ROLE, "desk_access": 0}).insert()
    if not frappe.db.exists("User", USER):
        frappe.get_doc({"doctype": "User", "email": USER, "first_name": "WCPD审批同步", "user_type": "Website User", "enabled": 1, "send_welcome_email": 0, "roles": [{"role": ROLE}]}).insert()
    user = frappe.get_doc("User", USER)
    if {r.role for r in user.roles} - {ROLE} or not user.enabled:
        raise RuntimeError("Existing integration account has unexpected roles or is disabled")
    other = frappe.get_all("User Permission", filters={"user": USER, "allow": "Company"}, pluck="for_value")
    if any(company != COMPANY for company in other):
        raise RuntimeError("Integration account already has an unexpected company scope")
    if COMPANY not in other:
        frappe.get_doc({"doctype": "User Permission", "user": USER, "allow": "Company", "for_value": COMPANY, "apply_to_all_doctypes": 1}).insert()
    if not user.api_key or not user.get_password("api_secret", raise_exception=False):
        from frappe.core.doctype.user.user import generate_keys
        credentials = generate_keys(USER)
    else:
        credentials = {"api_key": user.api_key, "api_secret": user.get_password("api_secret")}
    payload = {"HRMS_SYNC_API_BASE": "http://host.docker.internal:8080", "HRMS_SYNC_API_KEY": credentials["api_key"], "HRMS_SYNC_API_SECRET": credentials["api_secret"], "HRMS_SYNC_COMPANY": COMPANY, "HRMS_SYNC_CORP_ID": "ww9e7f94090845f6ab"}
    filename = "/tmp/wcpd-approval-connection.json"
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(payload, file, ensure_ascii=False)
    frappe.db.commit()
    frappe.clear_cache(user=USER)
    print(json.dumps({"user": USER, "role": ROLE, "company": COMPANY, "documentPermissions": 0, "credentialFileCreated": True}, ensure_ascii=False))
except Exception:
    frappe.db.rollback()
    raise
finally:
    frappe.destroy()
