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
export async function requestCognitionCloud(c:Cloud, path:string, purpose:string, body?:unknown) {
  let base: URL;
  try { base = new URL(c.supabaseUrl.trim()); } catch { throw Error('记忆库地址必须是包含 https:// 的完整网址。'); }
  if (!['http:', 'https:'].includes(base.protocol)) throw Error('记忆库地址必须使用 https:// 或 http://。');
  const signal = AbortSignal.timeout(60000);
  try {
    const response = await fetch(c.supabaseUrl.trim().replace(/\/+$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type':'application/json', apikey:c.supabaseAnonKey.trim(), Authorization:'Bearer '+c.supabaseAnonKey.trim()},
      body: body === undefined ? undefined : JSON.stringify(body), signal, cache:'no-store',
    });
    if (!response.ok) {
      if (response.status === 409) throw Error('云端已有新版，请先备份当前草稿，再接收并合并修改。');
      throw Error(`${purpose}失败（HTTP ${response.status}）。请检查记忆 Worker 的部署和日志。`);
    }
    return await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted || /abort|timeout/i.test(message)) {
      const saveHint = body === undefined ? '' : '当前草稿仍保留；云端可能已保存，请先备份草稿，再接收云端核对。';
      throw Error(`${purpose}${signal.aborted ? '等待 60 秒后超时' : '请求被浏览器或网络取消'}。${saveHint}请保持页面在前台，并检查网络及 Worker 日志。`);
    }
    if (error instanceof TypeError) throw Error(`${purpose}网络连接失败，请检查记忆库地址、网络和 Worker 的跨域响应。`);
    throw error;
  }
}
export async function exchange(c:Cloud,id:string,draft?:Profile):Promise<Profile> {
  if (!c.supabaseUrl || !c.supabaseAnonKey || !id) throw Error('请先配置个人云端记忆库和角色 ID');
  const p=await requestCognitionCloud(c, '/memory/cognition?char_id='+encodeURIComponent(id), draft ? '保存认知档案' : '读取认知档案', draft);
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
