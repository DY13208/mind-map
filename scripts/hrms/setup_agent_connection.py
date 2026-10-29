"""Enable the local personal-token bridge; preserve roles and never print credentials."""
import json
import os
import secrets
from pathlib import Path

import frappe

frappe.init(site="hrms.localhost", sites_path="/home/frappe/frappe-bench/sites")
frappe.connect()
try:
    filename = Path(frappe.get_site_path("site_config.json"))
    config = json.loads(filename.read_text())
    if os.environ.get("HRMS_AGENT_WRITES_ENABLED") == "true":
        raise RuntimeError("Refusing activation: HRMS Agent writes must remain disabled")
    backup = filename.with_name("site_config.before-agent-connection.json")
    if not backup.exists():
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(config, output, ensure_ascii=False, indent=2)
    key = config.get("external_api_exchange_key") or secrets.token_urlsafe(48)
    config["external_api_enabled"] = True
    config["external_api_exchange_key"] = key
    company = "深圳市依然电商科技有限公司"
    if not frappe.db.exists("Company", company) or not frappe.db.exists("DocType", "External API Token"):
        raise RuntimeError("HRMS company or personal-token schema missing")
    staged = filename.with_suffix(".agent-tmp")
    staged.write_text(json.dumps(config, ensure_ascii=False, indent=2))
    os.chmod(staged, 0o600)
    staged.replace(filename)
    payload = {"HRMS_API_BASE": "http://host.docker.internal:8080", "EXTERNAL_API_EXCHANGE_KEY": key, "HRMS_CLIENT_NAME": "WCPD-Agent", "HRMS_AGENT_CORP_ID": "ww9e7f94090845f6ab", "HRMS_AGENT_COMPANY": company, "HRMS_AGENT_WRITES_ENABLED": "false"}
    target = "/tmp/hrms-agent-connection.json"
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(payload, output, ensure_ascii=False)
    print(json.dumps({"configured": True, "personalIdentity": True, "rolesChanged": False, "credentialFileCreated": True}))
finally:
    frappe.destroy()
