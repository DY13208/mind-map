"""Install the read-only timeline hook in a local HRMS source checkout (explicit path)."""
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1]).resolve()
runtime = root / "hr_roster" / "approval_runtime.py"
integration = root / "integrations" / "approval_external_timeline.py"
text = runtime.read_text(encoding="utf-8-sig")
needle = "\ttimeline = _merge_node_flow(_localize_assignees(timeline))"
addition = "\n\tif not timeline:\n\t\tfrom employee_roster.integrations.approval_external_timeline import external_timeline\n\t\ttimeline = external_timeline(inst)\n\t\tfor entry in timeline:\n\t\t\t_fmt_row_times(entry)"
if "from employee_roster.integrations.approval_external_timeline import external_timeline" not in text:
    if text.count(needle) != 1:
        raise RuntimeError("Cannot identify unique detail timeline projection; inspect current HRMS runtime")
    backup = runtime.with_suffix(".py.before-wcpd-timeline")
    if not backup.exists():
        shutil.copyfile(runtime, backup)
    runtime.write_text(text.replace(needle, needle + addition), encoding="utf-8")
shutil.copyfile(pathlib.Path(__file__).with_name("approval_external_timeline.py"), integration)
print("Installed read-only WCPD timeline projection")
