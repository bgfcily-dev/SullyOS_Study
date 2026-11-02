import {useState} from 'react';
import {cached, exchange, fields,labels,type Profile,type Cloud} from './cognition';
export function CognitionPanel({cloud,id,generate}:{cloud:Cloud;id:string;generate?:(p:Profile)=>Promise<Profile>}) {
  const [draft,setDraft]=useState(()=>cached(cloud,id));
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  async function run(action:'receive'|'generate'|'save') {
    setBusy(true);
    try {
      const next=action==='generate' && generate ? await generate(draft) : await exchange(cloud,id,action==='save'?draft:undefined);
      setDraft(next);
      setNotice(action==='generate'?'草稿已生成，检查后可保存到云端。':action==='save'?'已保存并用于后续对话。': next.revision?'已接收云端认知。':'云端还没有这位角色的认知档案。');
    } catch(e){setNotice(e instanceof Error?e.message:String(e));} finally {setBusy(false);}
  }
  return <fieldset disabled={busy} style={{width:'100%',padding:12}}><legend>当前认知</legend><p>每栏一到两句话，可留空。保存后会随角色对话发送。</p>
    {fields.map(k=><label key={k} style={{display:'block',marginTop:10}}>{labels[k]}<textarea style={{display:'block',width:'100%',border:'1px solid #aaa',borderRadius:6,padding:6}} rows={2} maxLength={240} value={draft[k]} onChange={e=>setDraft({...draft,[k]:e.target.value})}/></label>)}
    <div style={{display:'flex',gap:12,marginTop:12,flexWrap:'wrap'}}>{generate && <button type="button" onClick={()=>run('generate')}>生成草稿</button>}<button type="button" onClick={()=>run('receive')}>接收云端版本</button><button type="button" onClick={()=>run('save')}>保存到云端</button></div><p role="status">{busy?'处理中…':notice}</p>
  </fieldset>;
}
