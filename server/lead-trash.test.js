import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';
const {db}=await import('./db.js');
const repo=await import('./repo.js');
const previews=await import('./previewRepo.js');
const {emailService}=await import('./emailService.js');
await import('./emailCampaigns.js');
let next=0;
function lead(){const id=`trash-test-${++next}`;db.prepare(`INSERT INTO businesses(place_id,name,name_key,category,country_code,lat,lng,notes,emails,site_status,follow_up_at,first_seen,last_seen) VALUES(?,?,?,'CCTV installers','US',10,10,'Retain these notes','["owner@example.com"]','none',1,1,1)`).run(id,`Security ${next}`,`security ${next}`);return id;}
function scan(id){const sid=db.prepare("INSERT INTO scans(created_at,updated_at,status,config) VALUES(1,1,'completed',?)").run(JSON.stringify({categoryLabel:'CCTV installers'})).lastInsertRowid;db.prepare('INSERT INTO scan_businesses(scan_id,place_id,found_at) VALUES(?,?,1)').run(sid,id);return Number(sid);}

test('deleting hides a lead from active lists, exports, maps, counts, previews and reminders without erasing its data',()=>{
 const id=lead(),sid=scan(id);previews.savePreview(id,{brief:'Keep design brief'});previews.recordActivity(id,{kind:'draft_opened',channel:'email',message:'Keep email draft'});
 const baseline=repo.followUpSummary().due;
 assert.equal(repo.queryLeads({ids:id}).total,1);assert.equal(repo.scanStats(sid).discovered,1);assert.ok(previews.listPreviews().rows.some(r=>r.place_id===id));
 assert.equal(repo.trashLeads([id,id]).count,1);
 assert.equal(repo.getLead(id),null);assert.equal(repo.queryLeads({ids:id,includeClosed:1}).total,0);assert.equal(repo.queryLeads({scanId:sid}).total,0);assert.equal(repo.mapPoints({ids:id}).length,0);assert.equal(repo.analytics(sid).totals.total,0);assert.equal(repo.scanStats(sid).discovered,0);assert.equal(repo.followUpSummary().due,baseline-1);assert.equal(repo.categoriesInUse({scanId:sid}).length,0);assert.equal(repo.countriesInUse({scanId:sid}).length,0);assert.equal(repo.searchCategoriesInUse({scanId:sid}).total,0);assert.equal(previews.listPreviews().rows.some(r=>r.place_id===id),false);
 assert.throws(()=>previews.getPreview(id),e=>e.status===404);assert.throws(()=>repo.updateLead(id,{notes:'Change deleted lead'}),e=>e.status===404);
 assert.equal(repo.queryLeads({ids:id,trash:true}).total,1);assert.equal(repo.getLead(id,{includeDeleted:true}).notes,'Retain these notes');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM preview_activity WHERE place_id=?').get(id).n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM scan_businesses WHERE place_id=?').get(id).n,1);
 assert.equal(repo.trashLeads([id]).count,0);
 assert.equal(repo.trashLeads([id],true).count,1);assert.equal(repo.getLead(id).notes,'Retain these notes');assert.equal(previews.getPreview(id).preview.brief,'Keep design brief');assert.equal(repo.scanStats(sid).discovered,1);assert.equal(repo.queryLeads({ids:id,trash:true}).total,0);
});

test('a later scan does not resurrect a deleted business',()=>{const id=lead(),sid=scan(id);repo.trashLeads([id]);const result=repo.upsertPlace({sourceId:id,name:'Updated name',website:null},{scanId:sid,countryCode:'US',categoryValue:'cctv'});assert.equal(result.ignored,true);assert.equal(repo.getLead(id),null);assert.notEqual(repo.getLead(id,{includeDeleted:true}).name,'Updated name');});

test('bulk deletion and restoration validate their input and preserve unrelated leads',()=>{const a=lead(),b=lead(),c=lead();for(const ids of [undefined,[],[''],[5],['x'.repeat(301)],Array(1001).fill(a)])assert.throws(()=>repo.trashLeads(ids),e=>e.status===400);assert.equal(repo.trashLeads([a,b,'missing']).count,2);assert.ok(repo.getLead(c));assert.equal(repo.trashLeads([a,b],true).count,2);assert.ok(repo.getLead(a));assert.ok(repo.getLead(b));});

test('transport locks make bulk deletion atomic',()=>{
 const a=lead(),b=lead();
 // The sender table is initialized by the production email service.
 const columns=db.prepare('PRAGMA table_info(email_messages)').all();assert.ok(columns.some(c=>c.name==='place_id'));assert.ok(emailService);
 const required=columns.filter(c=>c.notnull&&c.dflt_value===null&&!c.pk);
 const values=Object.fromEntries(required.map(c=>[c.name,c.type==='INTEGER'?1:'test']));
 Object.assign(values,{id:'trash-sending-lock',place_id:a,status:'sending',created_at:1});
 const keys=Object.keys(values).filter(k=>columns.some(c=>c.name===k));db.prepare(`INSERT INTO email_messages(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k]));
 assert.throws(()=>repo.trashLeads([a,b]),e=>e.status===409);assert.ok(repo.getLead(b));db.prepare("UPDATE email_messages SET status='failed' WHERE place_id=?").run(a);assert.equal(repo.trashLeads([a,b]).count,2);
});

test('trash and restore recover interrupted website analysis while deleted leads cannot be requeued',()=>{
 const id=lead();db.prepare("UPDATE businesses SET website='https://example.com',site_status='analyzing' WHERE place_id=?").run(id);
 repo.trashLeads([id]);assert.equal(repo.getLead(id,{includeDeleted:true}).site_status,'pending');
 assert.throws(()=>repo.requeueSite(id),e=>e.status===404);assert.equal(repo.claimPendingSites(100).some(row=>row.place_id===id),false);
 repo.trashLeads([id],true);assert.equal(repo.claimPendingSites(100).some(row=>row.place_id===id),true);assert.equal(repo.getLead(id).site_status,'analyzing');
});
