import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH=':memory:';
process.env.LOCAL_GENI_QA_ISOLATED='1';
const {db}=await import('./db.js');
const {createCrmService}=await import('./crm.js');
const {trashLeads}=await import('./repo.js');
const crm=createCrmService({validateAssignee:value=>{if(value!=='test-member')throw Object.assign(new Error('Not assignable'),{status:400});}});
const key=()=>crypto.randomUUID();
function business(name='Fictional CRM company'){const placeId=key();db.prepare("INSERT INTO businesses(place_id,name,site_status,first_seen,last_seen) VALUES(?,?,'none',1,1)").run(placeId,name);return placeId;}
function company(name){return crm.createCompany({placeId:business(name)});}
function contact(c,body={}){return crm.saveContact({companyId:c.id,name:'Fictional contact',email:'contact@example.test',requestKey:key(),...body});}
function deal(c,body={}){return crm.saveDeal({companyId:c.id,title:'Website project',requestKey:key(),...body});}
test('research admission is explicit, idempotent and does not change the original business',()=>{
 const p=business(),before=db.prepare('SELECT * FROM businesses WHERE place_id=?').get(p);assert.equal(crm.forLead(p).company,null);
 const c=crm.createCompany({placeId:p});assert.equal(crm.createCompany({placeId:p}).id,c.id);assert.deepEqual(db.prepare('SELECT * FROM businesses WHERE place_id=?').get(p),before);
 assert.equal(crm.forLead(p).company.id,c.id);assert.equal(crm.companyDetail(c.id).activity.length,1);
});
test('contacts and deals stay linked to their company, and cross-company contacts are rejected',()=>{
 const a=company(),b=company(),p=contact(a),d=deal(a,{contactId:p.id});
 assert.equal(crm.companyDetail(a.id).contacts[0].id,p.id);assert.equal(crm.companyDetail(a.id).deals[0].id,d.id);
 assert.throws(()=>deal(b,{contactId:p.id}),e=>e.status===400);assert.throws(()=>crm.saveDeal({version:d.version,companyId:b.id},null,d.id),e=>e.status===400);
});
test('manual companies retain international phones and repeated creation keys cannot overwrite details',()=>{
 const requestKey=key(),body={name:'Manual contact company',phone:'+1 (416) 555-0195',website:'https://example.test',email:'owner@example.test',requestKey};
 const c=crm.createCompany(body);assert.equal(c.phone,'+14165550195');assert.equal(crm.createCompany(body).id,c.id);
 assert.throws(()=>crm.createCompany({...body,email:'different@example.test'}),e=>e.status===409);
});
test('bulk lead admission is idempotent and never invents contact details',()=>{
 const withContact=business('Bulk company with contact'),withoutContact=business('Bulk company without contact');
 db.prepare('UPDATE businesses SET phone_e164=?,emails=? WHERE place_id=?').run('+14165550123','["owner@example.test"]',withContact);
 const first=crm.bulkCreateCompanies({placeIds:[withContact,withoutContact,withContact],createContacts:true,requestKey:key()});
 assert.equal(first.requested,2);assert.equal(first.companies.created,2);assert.equal(first.companies.alreadyInCrm,0);assert.equal(first.contacts.created,1);assert.equal(first.contacts.skipped,1);assert.equal(first.failures.length,0);
 const second=crm.bulkCreateCompanies({placeIds:[withContact,withoutContact],createContacts:true,requestKey:key()});
 assert.equal(second.companies.created,0);assert.equal(second.companies.alreadyInCrm,2);assert.equal(second.contacts.created,0);assert.equal(second.contacts.alreadyInCrm,1);assert.equal(second.contacts.skipped,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_contacts WHERE company_id=(SELECT id FROM crm_companies WHERE place_id=?)').get(withContact).n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_contacts WHERE company_id=(SELECT id FROM crm_companies WHERE place_id=?)').get(withoutContact).n,0);
});
test('creation retries preserve exact contact and deal data and detect changed payloads',()=>{
 const c=company(),contactBody={companyId:c.id,name:'Original contact',requestKey:key()};const p=crm.saveContact(contactBody);
 assert.equal(crm.saveContact(contactBody).id,p.id);assert.throws(()=>crm.saveContact({...contactBody,name:'Changed'}),e=>e.status===409);
 const dealBody={companyId:c.id,title:'Original deal',value:0,requestKey:key()};const d=crm.saveDeal(dealBody);
 assert.equal(crm.saveDeal(dealBody).id,d.id);assert.throws(()=>crm.saveDeal({...dealBody,value:1}),e=>e.status===409);
});
test('deal changes require a current version and stage changes never fabricate a sent message',()=>{
 const c=company(),d=deal(c,{value:0,currency:'CAD'});const moved=crm.saveDeal({version:d.version,stage:'design_shared'},null,d.id);
 assert.equal(moved.version,2);assert.equal(moved.value,0);assert.equal(moved.stage,'design_shared');
 assert.throws(()=>crm.saveDeal({version:1,stage:'won'},null,d.id),e=>e.status===409);
 assert.equal(db.prepare('SELECT lead_status FROM businesses WHERE place_id=?').get(c.placeId).lead_status,'not_contacted');
 assert.equal(crm.companyDetail(c.id).activity.at(0).action,'deal_stage_changed');
});
test('values, dates, currencies and assignments are validated atomically',()=>{
 const c=company(),d=deal(c);for(const patch of [{value:-1},{value:'23'},{value:1.234},{value:Infinity},{followUpDate:'2026-02-29'},{currency:'FAKE'},{stage:'unknown'},{ownerId:'inactive'}])assert.throws(()=>crm.saveDeal({version:d.version,...patch},null,d.id));
 assert.equal(crm.deal(d.id).version,1);const saved=crm.saveDeal({version:1,ownerId:'test-member',followUpDate:'2028-02-29',value:125.5,currency:'PKR'},null,d.id);assert.equal(saved.ownerId,'test-member');assert.equal(saved.value,125.5);
});
test('archiving records is recoverable and keeps relationships; archived contacts do not block existing deal edits',()=>{
 const c=company(),p=contact(c),d=deal(c,{contactId:p.id});const archived=crm.archive('contact',p.id,{version:p.version});
 assert.equal(crm.companyDetail(c.id).contacts.length,0);assert.equal(crm.deal(d.id).contactId,p.id);
 const changed=crm.saveDeal({version:d.version,stage:'qualified'},null,d.id);assert.equal(changed.contactId,p.id);
 const restored=crm.archive('contact',p.id,{version:archived.version},null,true);assert.equal(restored.archivedAt,null);
 const removed=crm.archive('deal',d.id,{version:changed.version});assert.equal(crm.companyDetail(c.id).deals.length,0);
 assert.equal(crm.archive('deal',d.id,{version:removed.version},null,true).stage,'qualified');
});
test('lead Trash hides its company, contacts, deals and board cards until restoration',()=>{
 const c=company('Trash relationship test'),p=contact(c),d=deal(c);trashLeads([c.placeId]);
 assert.throws(()=>crm.companyDetail(c.id),e=>e.status===404);assert.throws(()=>crm.contact(p.id),e=>e.status===404);assert.throws(()=>crm.deal(d.id),e=>e.status===404);
 assert.equal(crm.list('companies',{q:'Trash relationship test'}).total,0);assert.equal(crm.board({q:'Trash relationship test'}).stages.reduce((n,s)=>n+s.total,0),0);
 trashLeads([c.placeId],true);assert.equal(crm.companyDetail(c.id).contacts[0].id,p.id);assert.equal(crm.deal(d.id).stage,'new');
});
test('CRM pagination and company filters return records without mixing relationships',()=>{
 const c=company('Paging company'),p1=contact(c,{name:'One'}),p2=contact(c,{name:'Two'});const first=crm.list('contacts',{companyId:c.id,limit:1});const second=crm.list('contacts',{companyId:c.id,limit:1,page:1});assert.equal(first.total,2);assert.equal(first.hasMore,true);assert.notEqual(first.rows[0].id,second.rows[0].id);assert.deepEqual(new Set([first.rows[0].id,second.rows[0].id]),new Set([p1.id,p2.id]));
});
