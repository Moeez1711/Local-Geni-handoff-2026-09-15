import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import ExcelJS from 'exceljs';
process.env.DB_PATH=':memory:';
const {db}=await import('./db.js');
const fields=await import('./customFields.js');
const {createCustomFieldsRouter}=await import('./routes/customFields.js');
const {trashLeads,getLead}=await import('./repo.js');
const {toCsv,toXlsx}=await import('./export.js');
let n=0;
function lead() {const id=`custom-test-${++n}`;db.prepare('INSERT INTO businesses(place_id,name,first_seen,last_seen) VALUES(?,?,1,1)').run(id,'Café کراچی');return id;}
function define(type,label=type,options) {return fields.createCustomField({type,label,...(options ? {options} : {})}).field;}
function save(id,values,loaded=fields.getLeadCustomFields(id)) {return fields.saveLeadCustomFields(id,{version:loaded.version,definitionsVersion:loaded.definitionsVersion,values});}
test.beforeEach(() => {
  for(const table of ['custom_field_values','custom_field_lead_versions','custom_field_definitions']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare('UPDATE custom_field_meta SET version=0 WHERE id=1').run();
});

test('GET leaves lead data unmodified; definitions have stable IDs, unique normalized labels and immutable types',() => {
  const id=lead(); assert.equal(fields.getLeadCustomFields(id).version,0);
  assert.equal(db.prepare('SELECT count(*) n FROM custom_field_lead_versions').get().n,0);
  const one=define('text',' Contact name ');assert.equal(one.label,'Contact name');assert.match(one.id,/^cf_[0-9a-f-]{36}$/);
  assert.throws(() => define('number','CONTACT NAME'),e => e.code==='CUSTOM_FIELD_LABEL_EXISTS');
  assert.throws(() => define('text','Ｃｏｎｔａｃｔ ｎａｍｅ'),e => e.code==='CUSTOM_FIELD_LABEL_EXISTS');
  assert.throws(() => fields.updateCustomField(one.id,{type:'number'}),e => e.code==='CUSTOM_FIELD_TYPE_IMMUTABLE');
  const renamed=fields.updateCustomField(one.id,{label:'Decision maker',definitionsVersion:1});assert.equal(renamed.field.id,one.id);assert.equal(renamed.definitionsVersion,2);
  assert.throws(() => fields.updateCustomField(one.id,{label:'Stale',definitionsVersion:1}),e => e.code==='CUSTOM_FIELDS_STALE');
});

test('all seven types round-trip including zero, false, Unicode, multiline, leap day and HTTP links',() => {
  const id=lead();const text=define('text'),area=define('textarea'),num=define('number'),date=define('date'),select=define('select','Readiness',['Soon','Later']),check=define('checkbox'),url=define('url');
  const values={[text.id]:'  José کراچی  ',[area.id]:'First line\n第二行',[num.id]:0,[date.id]:'2028-02-29',[select.id]:'Later',[check.id]:false,[url.id]:'http://studio.agency/design?id=7'};
  const saved=save(id,values);assert.equal(saved.version,1);assert.deepEqual(saved.values,values);assert.equal(saved.definitions.length,7);
  assert.equal(save(id,{},saved).version,1);assert.equal(save(id,values,saved).version,1);
  const updated=save(id,{[check.id]:true,[num.id]:-125.5});assert.equal(updated.version,2);assert.equal(updated.values[check.id],true);assert.equal(updated.values[num.id],-125.5);
});

test('typed validation is atomic and rejects malformed dates, coercion, unsafe URLs and unknown field IDs',() => {
  const id=lead(),text=define('text'),number=define('number'),date=define('date'),check=define('checkbox'),url=define('url'),select=define('select','Priority',['High','Low']);
  save(id,{[text.id]:'Original'});
  for(const [field,value] of [[number,'25'],[number,Infinity],[number,1e16],[date,'2026-02-29'],[date,'2026-13-01'],[date,'2024-02-30'],[date,'0000-01-01'],[check,'false'],[select,'Medium'],[url,'javascript:alert(1)'],[url,'https://localhost/design'],[url,'http://127.0.0.1/design'],[url,'https://user:secret@agency.com'],[text,'line\nbreak'],[text,'a'.repeat(501)]]) {
    assert.throws(() => save(id,{[text.id]:'Should roll back',[field.id]:value}),e => e.code==='CUSTOM_FIELD_VALUE_INVALID');
    assert.equal(fields.getLeadCustomFields(id).values[text.id],'Original');assert.equal(fields.getLeadCustomFields(id).version,1);
  }
  assert.throws(() => save(id,JSON.parse('{"__proto__":"injected"}')),e => e.code==='CUSTOM_FIELD_NOT_FOUND');
  assert.equal({}.injected,undefined);
});

test('blanks clear only specified fields while omitted values and false remain',() => {
  const id=lead(),name=define('text'),amount=define('number'),active=define('checkbox');
  save(id,{[name.id]:'Contact',[amount.id]:0,[active.id]:false});
  const blank=save(id,{[name.id]:'',[amount.id]:null});assert.deepEqual(blank.values,{[active.id]:false});assert.equal(blank.version,2);
  assert.equal(save(id,{[name.id]:null}).version,2);
});

test('optimistic value and definition revisions prevent stale overwrites and archive races',() => {
  const id=lead(),field=define('text');const loaded=fields.getLeadCustomFields(id);
  save(id,{[field.id]:'First'},loaded);
  assert.throws(() => save(id,{[field.id]:'Lost update'},loaded),e => e.code==='CUSTOM_VALUES_STALE');
  const fresh=fields.getLeadCustomFields(id);fields.updateCustomField(field.id,{label:'Renamed'});
  assert.throws(() => save(id,{[field.id]:'Changed definition'},fresh),e => e.code==='CUSTOM_FIELDS_STALE');
  assert.throws(() => fields.saveLeadCustomFields(id,{version:1,values:{}}),e => e.code==='CUSTOM_FIELDS_VERSION_REQUIRED');
  assert.equal(fields.getLeadCustomFields(id).values[field.id],'First');
});

test('archiving hides definitions and export columns without deleting values; restore recovers the same ID',() => {
  const id=lead(),field=define('text','Archived detail');save(id,{[field.id]:'Retain this data'});
  fields.archiveCustomField(field.id,true);assert.equal(fields.listCustomFields().rows.length,0);assert.equal(fields.listCustomFields({includeArchived:'true'}).rows.length,1);
  const detail=fields.getLeadCustomFields(id);assert.equal(detail.definitions[0].archived,true);assert.equal(detail.values[field.id],'Retain this data');
  assert.throws(() => save(id,{[field.id]:''}),e => e.code==='CUSTOM_FIELD_ARCHIVED');
  assert.deepEqual(fields.getCustomFieldsForExport([getLead(id)]).customFields,[]);
  fields.archiveCustomField(field.id,false);assert.equal(fields.listCustomFields().rows[0].id,field.id);assert.equal(fields.getLeadCustomFields(id).values[field.id],'Retain this data');
});

test('select options in use cannot be removed or renamed, including values on trashed businesses',() => {
  const id=lead(),field=define('select','Source',['Form','Phone']);save(id,{[field.id]:'Form'});trashLeads([id]);
  assert.throws(() => fields.updateCustomField(field.id,{options:['Phone']}),e => e.code==='CUSTOM_FIELD_OPTION_IN_USE');
  assert.throws(() => fields.updateCustomField(field.id,{options:['form','Phone']}),e => e.code==='CUSTOM_FIELD_OPTION_IN_USE');
  const expanded=fields.updateCustomField(field.id,{options:['Form','Phone','Referral']});assert.equal(expanded.field.options.length,3);
  assert.throws(() => define('select','Duplicate choices',['Yes','YES']),e => e.code==='CUSTOM_FIELD_INVALID');
  assert.throws(() => define('select','Too many',Array.from({length:51},(_,i) => String(i))),e => e.code==='CUSTOM_FIELD_INVALID');
});

test('Trash blocks reads and writes; restoring retains values and their revision',() => {
  const id=lead(),field=define('textarea');save(id,{[field.id]:'Keep after restore'});const snapshot=fields.getLeadCustomFields(id);
  trashLeads([id]);assert.throws(() => fields.getLeadCustomFields(id),e => e.status===404);
  assert.throws(() => save(id,{[field.id]:'Stale'},snapshot),e => e.status===404);
  assert.equal(Object.keys(fields.getCustomFieldsForExport([{place_id:id}]).customValues).length,0);
  trashLeads([id],true);assert.equal(fields.getLeadCustomFields(id).values[field.id],'Keep after restore');assert.equal(fields.getLeadCustomFields(id).version,snapshot.version);
});

test('CSV/XLSX exports retain active values, labels and stable keys without formula or built-in collisions',async () => {
  const id=lead(),name=define('text','Business'),notes=define('textarea','Notes, "own"'),amount=define('number','Amount'),check=define('checkbox','Confirmed'),archived=define('text','Private archived');
  save(id,{[name.id]:'+1+HYPERLINK("https://agency.com")',[notes.id]:'\t=HYPERLINK("https://agency.com")\nUnicode کراچی',[amount.id]:0,[check.id]:false,[archived.id]:'Do not export'});
  fields.archiveCustomField(archived.id,true);
  const rows=[getLead(id)],custom=fields.getCustomFieldsForExport(rows),csv=toCsv(rows,custom);
  assert.ok(csv.includes(`Custom: Business [${name.id}]`));assert.ok(csv.includes('"Custom: Notes, ""own""'));
  assert.ok(csv.includes("'+1+HYPERLINK"));assert.ok(csv.includes("'\t=HYPERLINK"));assert.ok(!csv.includes('Private archived'));assert.ok(!csv.includes('Do not export'));
  const buffer=await toXlsx(rows,custom),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);const sheet=workbook.getWorksheet('Leads');
  const headers=sheet.getRow(1).values;const find=(field) => headers.findIndex((value) => String(value).includes(`[${field.id}]`));
  assert.equal(sheet.getCell(2,find(amount)).value,0);assert.equal(sheet.getCell(2,find(check)).value,false);
  assert.equal(sheet.getCell(2,find(name)).value,'\'+1+HYPERLINK("https://agency.com")');assert.equal(sheet.getCell(2,3).value,'Café کراچی');
  assert.equal(sheet.columnCount,30);
});

test('definition and value routes use independent manage/edit gates and return revision conflicts',async (t) => {
  const app=express();app.use(express.json());
  const gate=(roles) => (req,res,next) => roles.includes(req.get('x-test-role')) ? next() : res.status(403).json({error:'Not allowed'});
  app.use('/api/custom-fields',createCustomFieldsRouter({canManage:gate(['owner','admin']),canEdit:gate(['owner','admin','member'])}));
  const server=http.createServer(app);await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(() => new Promise((resolve) => server.close(resolve)));
  const call=async (path,{method='GET',body,role='owner'}={}) => {const response=await fetch(`http://127.0.0.1:${server.address().port}/api/custom-fields${path}`,{method,headers:{'Content-Type':'application/json','x-test-role':role},...(body ? {body:JSON.stringify(body)} : {})});return {status:response.status,body:await response.json()};};
  assert.equal((await call('/',{method:'POST',role:'member',body:{type:'text',label:'Forbidden'}})).status,403);
  const created=await call('/',{method:'POST',body:{type:'number',label:'Budget',definitionsVersion:0}});assert.equal(created.status,201);
  const id=lead(),field=created.body.field,loaded=await call(`/leads/${id}`);assert.equal(loaded.status,200);
  const body={version:loaded.body.version,definitionsVersion:loaded.body.definitionsVersion,values:{[field.id]:0}};
  assert.equal((await call(`/leads/${id}`,{method:'PUT',role:'viewer',body})).status,403);
  const saved=await call(`/leads/${id}`,{method:'PUT',role:'member',body});assert.equal(saved.status,200);assert.equal(saved.body.values[field.id],0);
  assert.equal((await call(`/leads/${id}`,{method:'PUT',role:'member',body})).status,409);
  assert.equal((await call(`/${field.id}/archive`,{method:'POST',role:'member',body:{}})).status,403);
  assert.equal((await call(`/${field.id}/archive`,{method:'POST',body:{definitionsVersion:1}})).status,200);
  assert.equal((await call('/?includeArchived=true')).body.rows[0].archived,true);
});

test.after(() => db.close());
