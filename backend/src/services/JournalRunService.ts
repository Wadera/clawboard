import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const KEY = /^[0-9a-f]{32}$/;
const STATES = new Set(['drafted','validating','validation_failed','review_ready','approved','rejected','publishing','published','publication_unknown','rollback_pending','rolled_back','rollback_unknown']);

export class JournalRunError extends Error { constructor(message: string, public status = 400) { super(message); } }
export interface SafeRun { key:string; entryId:string|null; date:string|null; entryType:string|null; operation:string|null; contentAuthor:string|null; executor:string|null; state:string; updatedAt:string|null; requestedMedia:string[]; validationOk:boolean|null; availableActions:string[]; }

function str(v: unknown, max=120): string|null { return typeof v === 'string' ? v.slice(0,max) : null; }
function actions(state:string): string[] {
  if (state === 'review_ready') return ['approve','reject'];
  if (state === 'approved') return ['reject'];
  if (state === 'validation_failed') return ['retry'];
  if (['publishing','publication_unknown','rollback_pending','rollback_unknown'].includes(state)) return ['reconcile'];
  return [];
}
function safeManifest(key:string, raw:any): SafeRun {
  const state = str(raw?.state,40) || 'unknown';
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const last = events.length ? events[events.length-1] : null;
  const requested = Array.isArray(raw?.requested_media) ? raw.requested_media.filter((x:unknown)=>['image','audio','song'].includes(String(x))).slice(0,3) : [];
  return {
    key, entryId:str(raw?.immutable_inputs?.entry_id,80), date:str(raw?.immutable_inputs?.date,20),
    entryType:str(raw?.immutable_inputs?.entry_type,24), operation:str(raw?.operation,40),
    contentAuthor:str(raw?.content_author,40), executor:str(raw?.executor,40), state:STATES.has(state)?state:'unknown',
    updatedAt:str(last?.at || raw?.updated_at || raw?.created_at,40), requestedMedia:requested,
    validationOk:raw?.validation && typeof raw.validation.ok === 'boolean' ? raw.validation.ok : null,
    availableActions:actions(state),
  };
}

export class JournalRunService {
  private readonly root:string;
  private readonly python:string;
  private readonly pythonPath:string;
  constructor(root=process.env.CLAW_JOURNAL_RUN_ROOT || '/claw-journal-runs', python=process.env.CLAW_JOURNAL_PYTHON || 'python3', pythonPath=process.env.CLAW_JOURNAL_PYTHONPATH || '/claw-journal-src') {
    this.root=path.resolve(root); this.python=python; this.pythonPath=pythonPath;
  }
  private valid(key:string):void { if(!KEY.test(key)) throw new JournalRunError('invalid run key'); }
  private async loadRaw(key:string):Promise<any> {
    this.valid(key); const dir=path.join(this.root,key); const file=path.join(dir,'manifest.json');
    let st; try { st=await fs.lstat(file); } catch { throw new JournalRunError('run not found',404); }
    if(!st.isFile() || st.isSymbolicLink() || st.size>2_000_000) throw new JournalRunError('unsafe run manifest',409);
    const realRoot=await fs.realpath(this.root), real=await fs.realpath(file);
    if(!real.startsWith(realRoot+path.sep)) throw new JournalRunError('unsafe run manifest',409);
    try { return JSON.parse(await fs.readFile(real,'utf8')); } catch { throw new JournalRunError('malformed run manifest',409); }
  }
  async list(limit=20):Promise<SafeRun[]> {
    limit=Math.max(1,Math.min(100,limit)); let names:string[];
    try { names=await fs.readdir(this.root); } catch { return []; }
    const runs:SafeRun[]=[];
    for(const name of names.slice(0,500)) { if(!KEY.test(name)) continue; try { runs.push(safeManifest(name,await this.loadRaw(name))); } catch {} }
    return runs.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')).slice(0,limit);
  }
  async get(key:string):Promise<SafeRun> { return safeManifest(key,await this.loadRaw(key)); }
  async history(key:string):Promise<Array<{at:string|null;state:string;reasonCode:string|null}>> {
    const raw=await this.loadRaw(key); const events=Array.isArray(raw?.events)?raw.events:[];
    return events.slice(-200).map((e:any)=>({at:str(e?.at,40),state:STATES.has(String(e?.state))?String(e.state):'unknown',reasonCode:str(e?.reason_code,60)}));
  }
  private run(args:string[]):Promise<void> {
    return new Promise((resolve,reject)=>{
      const child=spawn(this.python,['-m','claw_journal.cli','--root',this.root,...args],{shell:false,env:{...process.env,PYTHONPATH:this.pythonPath}});
      let out=0, err=''; const timer=setTimeout(()=>{child.kill('SIGKILL'); reject(new JournalRunError('journal operation timed out',504));},120_000);
      child.stdout.on('data',b=>{out+=b.length;if(out>2_000_000) child.kill('SIGKILL');});
      child.stderr.on('data',b=>{if(err.length<4096) err+=String(b);});
      child.on('error',()=>{clearTimeout(timer);reject(new JournalRunError('journal operation unavailable',503));});
      child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new JournalRunError(/lock|state|approval/i.test(err)?'journal run conflict':'journal operation failed',409));});
    });
  }
  async review(key:string,actor:string,decision:'approve'|'reject',note=''):Promise<SafeRun> {
    const current=await this.get(key); if(!current.availableActions.includes(decision)) throw new JournalRunError('review action is not available',409);
    if(decision==='reject' && (!note.trim() || note.length>500)) throw new JournalRunError('bounded rejection note required');
    const args=[decision,key,'--by',actor]; if(decision==='approve'){args.push('--note',note.slice(0,500));}else{args.push('--note',note.trim());}
    await this.run(args); return this.get(key);
  }
  async retry(key:string):Promise<SafeRun> {
    const current=await this.get(key); let command:string;
    if(current.state==='validation_failed')command='validate'; else if(current.availableActions.includes('reconcile'))command='reconcile'; else throw new JournalRunError('run is not retryable',409);
    await this.run([command,key]); return this.get(key);
  }
}
export const journalRunService=new JournalRunService();
