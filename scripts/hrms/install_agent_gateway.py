"""Install the personal Agent gateway in an explicitly selected HRMS source checkout."""
import pathlib
import shutil
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
directory = root / "integrations"
external = directory / "external_api.py"
source = external.read_text(encoding="utf-8-sig")
old = 'os.environ.get("EXTERNAL_API_ENABLED", "false")'
if old in source:
    shutil.copyfile(external, external.with_suffix(".py.before-agent-gateway"))
    source = source.replace(old, 'str(os.environ.get("EXTERNAL_API_ENABLED") or frappe.conf.get("external_api_enabled", "false"))')
    source = source.replace('configured = os.environ.get("EXTERNAL_API_EXCHANGE_KEY", "")', 'configured = os.environ.get("EXTERNAL_API_EXCHANGE_KEY") or frappe.conf.get("external_api_exchange_key", "")')
    external.write_text(source, encoding="utf-8")
if "frappe.conf.get(\"external_api_enabled\"" not in source:
    raise RuntimeError("External API config loader differs; inspect before installing")
for name in ("agent_api.py", "agent_api_catalog.json", "agent_api_own_reads.json"):
    target = directory / name
    if target.exists():
        shutil.copyfile(target, directory / (name + ".before-" + str(int(time.time()))))
shutil.copyfile(pathlib.Path(__file__).with_name("agent_api.py"), directory / "agent_api.py")
shutil.copyfile(pathlib.Path(__file__).parents[2] / "simple-mind-map" / "bin" / "hrmsAgent" / "catalog.json", directory / "agent_api_catalog.json")
shutil.copyfile(pathlib.Path(__file__).parents[2] / "simple-mind-map" / "bin" / "hrmsAgent" / "ownReads.json", directory / "agent_api_own_reads.json")
print("Installed scoped personal HRMS Agent gateway; no user roles changed")
