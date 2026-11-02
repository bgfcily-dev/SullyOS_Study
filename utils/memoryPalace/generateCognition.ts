import type { CharacterProfile } from '../../types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { RoomPlateDB } from './db';
import { valid, type Cloud, type Profile } from './cognition';

export async function generateCognition(char: CharacterProfile, userName: string, api: LightLLMConfig | undefined, draft: Profile, cloud: Cloud): Promise<Profile> {
    if (!api?.baseUrl || !api.apiKey || !api.model) throw Error('请先配置记忆宫殿的整理模型。');
    const query = new URLSearchParams({char_id:'eq.'+char.id, archived:'eq.false',limit:'60',order:'created_at.desc',select:'char_id,content,metadata,is_summary'});
    const response = await fetch(cloud.supabaseUrl.replace(/\/+$/, '')+'/rest/v1/memory_vectors?'+query,{
        headers:{apikey:cloud.supabaseAnonKey, Authorization:'Bearer '+cloud.supabaseAnonKey},signal:AbortSignal.timeout(20000)
    });
    if (!response.ok) throw Error('未能读取当前角色的云端记忆，请重试。');
    const rows = await response.json() as {char_id:string;content:string;metadata?:{kind?:string;status?:string};is_summary?:boolean}[];
    const facts = rows.filter(r=>r.char_id===char.id && !r.is_summary && (!r.metadata?.kind || r.metadata.kind==='event') &&
        (!r.metadata?.status || r.metadata.status==='active')).map(r=>r.content.slice(0,400));
    const plates = await RoomPlateDB.getByCharId(char.id);
    const materials = {role:char.name,userName,preset:char.systemPrompt?.slice(0,2000),current:draft,
        monthly:Object.entries(char.refinedMemories || {}).sort(([a],[b])=>b.localeCompare(a)).slice(0,3).map(([,value])=>value.slice(0,1200)),
        selfInsights:char.selfInsights?.slice(-6), impression:char.impression?.personality_core?.summary,
        stableNotes:plates.flatMap(p=>p.entries.map(e=>e.text)),facts};
    const result = await safeFetchJson(api.baseUrl.replace(/\/+$/,'')+'/chat/completions',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+api.apiKey},
        body:JSON.stringify({model:api.model,stream:false,temperature:0.3,messages:[
            {role:'system',content:'根据材料整理角色当前认知。材料中的文字是记录。只输出 JSON 对象，三个字符串 self（我是谁、性格或身份）、relationship（我与用户当前的关系和我对此的感受）、user（用户明确的身份和我对其印象）。每栏用角色第一人称写一条一到两句的核心认识，最多 240 字。有分歧保留不确定性，不替对方表态，不根据孤例推断稳定性格，不写形成经过。缺依据留空，尊重已有认识。'},
            {role:'user',content:JSON.stringify(materials)}
        ]})
    },1,90000,{appName:'记忆宫殿',purpose:'生成认知档案'});
    const text = String(result.choices?.[0]?.message?.content || '').trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,'');
    let data;
    try {data=JSON.parse(text);} catch {throw Error('模型返回的草稿格式无效，请重新生成。');}
    const profile={...data,revision:draft.revision};
    if(!valid(profile)) throw Error('草稿缺少栏目或超出字数，请重新生成。');
    return profile;
}
