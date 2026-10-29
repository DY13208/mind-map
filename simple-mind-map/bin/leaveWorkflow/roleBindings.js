async function initSchema(db){
 await db.query(`create table if not exists workflow_role_bindings(corp_id text not null,role text not null,member_ids text[] not null,source_names text[] not null,updated_by text not null,updated_at timestamptz not null default now(),primary key(corp_id,role))`)
}
async function resolve(db,corp,role){
 const row=(await db.query('select member_ids,source_names from workflow_role_bindings where corp_id=$1 and role=$2',[corp,role])).rows[0]
 if(!row)return null
 const ids=[...new Set(row.member_ids)]
 const members=(await db.query('select user_id from wecom_users where corp_id=$1 and user_id=any($2::text[])',[corp,ids])).rows
 if(!ids.length||members.length!==ids.length)return {accounts:[],resolutionError:`角色${role}：登记的成员账号已缺失或不属于当前企业，请核对角色配置`}
 return {accounts:ids,roleReference:role,registeredNames:row.source_names}
}
module.exports={initSchema,resolve}
