// Match a complete Chinese name with an optional English suffix and trailing emoji.
// Never use substring matching; multiple directory matches must be disambiguated.
function chineseName(value){
 const text=String(value||'').trim()
 const withoutEmoji=text.replace(/(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D]\s*)+$/u,'').trimEnd()
 const match=withoutEmoji.match(/^([\p{Script=Han}·]{2,})(?:\s*[A-Za-z][A-Za-z0-9 ._-]*|\s*[（(][A-Za-z][A-Za-z0-9 ._-]*[）)])?$/u)
 return match?match[1]:''
}
async function findMembers(db,corp,name){
 const exact=(await db.query('select user_id,name from wecom_users where corp_id=$1 and name=$2 order by user_id limit 2',[corp,name])).rows
 if(exact.length)return exact
 const key=chineseName(name)
 if(!key)return []
 const candidates=(await db.query('select user_id,name from wecom_users where corp_id=$1 and left(name,char_length($2))=$2 order by user_id',[corp,key])).rows
 return candidates.filter(person=>chineseName(person.name)===key)
}
module.exports={findMembers,chineseName}
