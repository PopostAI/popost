/** Rebase a portable package to its final draft folder and register it without replacing existing projects. */
export const INSTALLER = `#!/usr/bin/env python3
import json,os,sys,shutil,uuid,time
from pathlib import Path
bundle=Path(__file__).resolve().parent
manifest=json.loads((bundle/'popost-draft.json').read_text())
app='JianyingPro' if manifest['target']=='jianying' else 'CapCut'
home=Path.home()
base=Path(os.environ.get('LOCALAPPDATA',str(home/'AppData/Local'))) if sys.platform=='win32' else home/'Movies'
root=base/app/'User Data/Projects/com.lveditor.draft'
if (root/'root_meta_info.json').exists():
 configured=json.loads((root/'root_meta_info.json').read_text()).get('root_path')
 if configured: root=Path(configured)
if len(sys.argv)>1: root=Path(sys.argv[1]).expanduser().resolve()
root.mkdir(parents=True,exist_ok=True)
draft_id=str(uuid.uuid4()).upper()
dest=root/draft_id
shutil.copytree(bundle/'draft',dest)
def rebase(value):
 if isinstance(value,dict): return {k:rebase(v) for k,v in value.items()}
 if isinstance(value,list): return [rebase(v) for v in value]
 if isinstance(value,str) and value.startswith('media/'): return str(dest/value)
 return value
content=rebase(json.loads((dest/'draft_content.json').read_text()))
content['id']=draft_id
for name in ['draft_content.json','draft_info.json','template-2.tmp']:
 (dest/name).write_text(json.dumps(content,ensure_ascii=False),encoding='utf-8')
now=int(time.time()*1000000)
meta=rebase(json.loads((dest/'draft_meta_info.json').read_text()))
meta.update(draft_id=draft_id,draft_fold_path=str(dest),draft_root_path=str(root),draft_cover=str(dest/'draft_cover.jpg'),tm_draft_create=now,tm_draft_modified=now)
(dest/'draft_meta_info.json').write_text(json.dumps(meta,ensure_ascii=False),encoding='utf-8')
registry=root/'root_meta_info.json'
state=json.loads(registry.read_text()) if registry.exists() else {'draft_ids':0,'all_draft_store':[]}
if registry.exists(): shutil.copy2(registry,root/('root_meta_info.popost-backup-'+draft_id+'.json'))
state.setdefault('all_draft_store',[]).insert(0,meta)
state['draft_ids']=len(state['all_draft_store'])
state.setdefault('root_path',str(root))
temp=root/('root_meta_info-'+draft_id+'.tmp')
temp.write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
os.replace(temp,registry)
print('Imported '+manifest['name']+' into '+app+': '+str(dest))
print('Open '+app+' and find the project on its home page. Keep its media folder in place.')
`;
