"""Company-scoped, read-only organization lookup for WCPD approvals."""
import frappe

ROLE = "WCPD Organization Reader"


@frappe.whitelist(methods=["GET"])
def resolve_hrbp(employee_ref: str, company: str):
    frappe.only_for(ROLE)
    allowed = frappe.get_all("User Permission", filters={"user": frappe.session.user, "allow": "Company"}, pluck="for_value")
    if not company or company not in allowed:
        frappe.throw("未授权查询该公司的组织架构", frappe.PermissionError)
    ref = (employee_ref or "").strip()
    if not ref or len(ref) > 160:
        frappe.throw("请填写唯一的员工姓名、员工编号或企微账号")
    employee = None
    for field in ("name", "hr_wecom_id", "employee_number", "employee_name"):
        matches = frappe.get_all("Employee", filters={field: ref, "company": company, "status": "Active"}, fields=["name", "employee_name", "department"], limit_page_length=2)
        if len(matches) > 1:
            frappe.throw("员工姓名或编号重复，请指定唯一员工编号或企微账号")
        if matches:
            employee = matches[0]
            break
    if not employee or not employee.department:
        frappe.throw("未找到该公司唯一在职员工及其主部门")
    department = employee.department
    seen = set()
    for _ in range(20):
        if not department or department in seen:
            break
        seen.add(department)
        unit = frappe.db.get_value("Department", department, ["name", "company", "disabled", "parent_department", "department_hrbp"], as_dict=True)
        if not unit or unit.disabled or (unit.company and unit.company != company):
            break
        if unit.department_hrbp:
            hrbp = frappe.db.get_value("Employee", unit.department_hrbp, ["name", "employee_name", "status", "hr_wecom_id"], as_dict=True)
            if not hrbp or hrbp.status != "Active" or not hrbp.hr_wecom_id:
                frappe.throw("组织登记的HRBP不是在职员工，或尚未绑定企微账号")
            return {
                "company": company,
                "employee": employee.name,
                "employeeName": employee.employee_name,
                "department": employee.department,
                "assignmentDepartment": unit.name,
                "hrbp": {"employee": hrbp.name, "name": hrbp.employee_name, "wecomUserId": hrbp.hr_wecom_id, "status": hrbp.status},
            }
        department = unit.parent_department
    frappe.throw("该员工所属组织及上级组织尚未登记HRBP")


@frappe.whitelist(methods=["GET"])
def resolve_department_head(employee_ref: str, company: str):
    """沿组织往上找第一个登记了部门负责人的单元，返回其负责人及企微账号。

    与 resolve_hrbp 完全对称，只是把 department_hrbp 换成 department_head；
    申请人本人就是负责人时跳过本级继续往上，避免自己审自己。
    """
    frappe.only_for(ROLE)
    allowed = frappe.get_all("User Permission", filters={"user": frappe.session.user, "allow": "Company"}, pluck="for_value")
    if not company or company not in allowed:
        frappe.throw("未授权查询该公司的组织架构", frappe.PermissionError)
    ref = (employee_ref or "").strip()
    if not ref or len(ref) > 160:
        frappe.throw("请填写唯一的员工姓名、员工编号或企微账号")
    employee = None
    for field in ("name", "hr_wecom_id", "employee_number", "employee_name"):
        matches = frappe.get_all("Employee", filters={field: ref, "company": company, "status": "Active"}, fields=["name", "employee_name", "department"], limit_page_length=2)
        if len(matches) > 1:
            frappe.throw("员工姓名或编号重复，请指定唯一员工编号或企微账号")
        if matches:
            employee = matches[0]
            break
    if not employee or not employee.department:
        frappe.throw("未找到该公司唯一在职员工及其主部门")
    department = employee.department
    seen = set()
    for _ in range(20):
        if not department or department in seen:
            break
        seen.add(department)
        unit = frappe.db.get_value("Department", department, ["name", "company", "disabled", "parent_department", "department_head"], as_dict=True)
        if not unit or unit.disabled or (unit.company and unit.company != company):
            break
        if unit.department_head:
            head = frappe.db.get_value("Employee", unit.department_head, ["name", "employee_name", "status", "hr_wecom_id"], as_dict=True)
            if not head or head.status != "Active" or not head.hr_wecom_id:
                frappe.throw("组织登记的部门负责人不是在职员工，或尚未绑定企微账号")
            if head.name == employee.name:
                department = unit.parent_department
                continue
            return {
                "company": company,
                "employee": employee.name,
                "employeeName": employee.employee_name,
                "department": employee.department,
                "assignmentDepartment": unit.name,
                "head": {"employee": head.name, "name": head.employee_name, "wecomUserId": head.hr_wecom_id, "status": head.status},
            }
        department = unit.parent_department
    frappe.throw("该员工所属组织及上级组织尚未登记部门负责人")
