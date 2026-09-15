import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, json } from './db.js';
import { ROOT } from './config.js';
db.exec(`CREATE TABLE IF NOT EXISTS qa_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,passed INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,summary TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_settings(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL);`);
const settings=()=>({enabled:true,intervalMinutes:15,...json(db.prepare('SELECT config FROM qa_settings WHERE id=1').get()?.config,{})});
let active=null,timer=null,watchers=[],debounce=null;
function stopChild(child, signal = 'SIGTERM') { if (!child?.pid) return; try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {} }
export function getQaStatus(){return{...settings(),running:Boolean(active),last:db.prepare('SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,passed,failed,summary FROM qa_runs ORDER BY id DESC LIMIT 1').get()||null,history:db.prepare('SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,passed,failed,summary FROM qa_runs ORDER BY id DESC LIMIT 12').all()};}
export function saveQaSettings(body={}){const next=settings();if(body.enabled!==undefined){if(typeof body.enabled!=='boolean')throw new Error('Choose whether automatic checks are enabled.');next.enabled=body.enabled;}if(body.intervalMinutes!==undefined){if(!Number.isInteger(body.intervalMinutes)||body.intervalMinutes<5||body.intervalMinutes>240)throw new Error('Choose a check interval from 5 to 240 minutes.');next.intervalMinutes=body.intervalMinutes;}db.prepare('INSERT INTO qa_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(JSON.stringify(next));return getQaStatus();}
function testFiles(){return['server','client/src/lib','public-relay/test'].filter(dir=>fs.existsSync(path.join(ROOT,dir))).flatMap(dir=>fs.readdirSync(path.join(ROOT,dir)).filter(name=>/\.test\.(m?js)$/.test(name)).map(name=>path.join(dir,name)));}
export function createQaEnvironment(source = process.env) {
  const clean = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot']) if (source[key]) clean[key] = source[key];
  return { ...clean, DB_PATH: ':memory:', GOOGLE_PLACES_API_KEY: '', EMAIL_KEY_PATH: '', LOCAL_GENI_QA_DISABLED: '1', LOCAL_GENI_QA_ISOLATED: '1', NODE_ENV: 'test' };
}
export function runQaChecks(){
  if(active)return getQaStatus();const id=db.prepare("INSERT INTO qa_runs(started_at,status,summary) VALUES(?,'running','Checking the application with isolated test data.')").run(Date.now()).lastInsertRowid;
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',path.join(ROOT,'scripts/qa-isolation.mjs'),'--test','--test-reporter=tap',...testFiles()],{cwd:ROOT,env:createQaEnvironment(),detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  active=child;let output='',timedOut=false;const collect=chunk=>{if(output.length<240000)output+=String(chunk).slice(0,240000-output.length);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timeout=setTimeout(()=>{timedOut=true;stopChild(child);setTimeout(()=>stopChild(child,'SIGKILL'),1000).unref();},120000);timeout.unref();
  function finish(code){if(active!==child)return;clearTimeout(timeout);active=null;const passed=Number(output.match(/^# pass (\d+)/m)?.[1]||0),failed=Number(output.match(/^# fail (\d+)/m)?.[1]||0);const ok=code===0&&!timedOut&&passed>0;const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1].slice(0,180)).slice(0,8);
    const summary=ok?`${passed} checks passed. No business records or real messages were used.`:timedOut?'Checks took too long and were stopped.':failures.length?failures.join('; '):'The checks could not complete. Review the application before starting new outreach.';
    db.prepare('UPDATE qa_runs SET finished_at=?,status=?,passed=?,failed=?,summary=? WHERE id=?').run(Date.now(),ok?'passed':'failed',passed,failed,summary,id);
    db.prepare('DELETE FROM qa_runs WHERE id NOT IN (SELECT id FROM qa_runs ORDER BY id DESC LIMIT 100)').run();
  }
  child.once('error',()=>finish(1));child.once('close',finish);return getQaStatus();
}
export function startQaAgent(){
  if(timer||process.env.LOCAL_GENI_QA_DISABLED==='1')return()=>{};
  db.prepare("UPDATE qa_runs SET status='interrupted',finished_at=?,summary='The app restarted before this check finished.' WHERE status='running'").run(Date.now());
  const due=()=>{const config=settings(),last=db.prepare('SELECT started_at FROM qa_runs ORDER BY id DESC LIMIT 1').get();if(config.enabled&&!active&&(!last||Date.now()-last.started_at>=config.intervalMinutes*60000))runQaChecks();};
  timer=setInterval(due,30000);timer.unref();
  for(const dir of ['server','client/src'])try{const watcher=fs.watch(path.join(ROOT,dir),{recursive:true},()=>{if(!settings().enabled)return;clearTimeout(debounce);debounce=setTimeout(()=>{if(!active)runQaChecks();},5000);debounce.unref();});watchers.push(watcher);}catch{}
  return()=>{clearInterval(timer);timer=null;clearTimeout(debounce);watchers.forEach(w=>w.close());watchers=[];stopChild(active);};
}
