export type Cloud = {supabaseUrl:string; supabaseAnonKey:string};
export type Profile = {self:string;relationship:string;user:string;revision:number};
export const blank:Profile = {self:'',relationship:'',user:'',revision:0};
export const labels = {self:'自我认知',relationship:'关系认知',user:'用户印象'} as const;
export const fields = Object.keys(labels) as (keyof typeof labels)[];
export function valid(p:any):p is Profile {
  return !!p && Number.isSafeInteger(p.revision) && p.revision>=0 && fields.every(k=>typeof p[k]==='string' && p[k].length<=240);
}
export function profileKey(c:Cloud,id:string) {
  return 'cognition:v1:'+JSON.stringify([c.supabaseUrl.trim().replace(/\/+$/,''),id]);
}
export function cached(c:Cloud,id:string):Profile {
  try {const p=JSON.parse(localStorage.getItem(profileKey(c,id)) || 'null'); if(valid(p)) return p;} catch {}
  return blank;
}
export async function exchange(c:Cloud,id:string,draft?:Profile):Promise<Profile> {
  if (!c.supabaseUrl || !c.supabaseAnonKey || !id) throw Error('请先配置个人云端记忆库和角色 ID');
  const response=await fetch(c.supabaseUrl.trim().replace(/\/+$/,'')+'/memory/cognition?char_id='+encodeURIComponent(id),{
    method:draft?'POST':'GET',headers:{'Content-Type':'application/json',apikey:c.supabaseAnonKey,Authorization:'Bearer '+c.supabaseAnonKey},
    body:draft?JSON.stringify(draft):undefined,signal:AbortSignal.timeout(20000),cache:'no-store'
  });
  if(!response.ok) throw Error(response.status===409?'云端已有新版，请先接收，再合并你的修改。':'读取或保存失败（'+response.status+'），请检查配置并更新记忆 Worker。');
  const p=await response.json();
  if(!valid(p)) throw Error('云端认知档案格式无效');
  const previous=cached(c,id);
  if(previous.revision>p.revision && p.revision>0) return previous;
  localStorage.setItem(profileKey(c,id),JSON.stringify(p));
  return p;
}
export function cognitionText(p:Profile) {
  const lines=fields.filter(k=>p[k]).map(k=>labels[k]+'：'+p[k]);
  return lines.length ? ['【当前认知 · 角色第一人称，作为背景理解】',...lines].join('\n') : '';
}
