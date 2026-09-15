import crypto from 'node:crypto';
import { db } from './db.js';
import * as workspaceAuth from './auth.js';

export const DEAL_STAGES = [
  ['new', 'New opportunity'], ['contacted', 'Conversation started'], ['qualified', 'Qualified'],
  ['design_shared', 'Design shared'], ['meeting', 'Meeting booked'], ['proposal', 'Proposal sent'],
  ['won', 'Won'], ['lost', 'Lost'],
];
const fail = (status, message) => Object.assign(new Error(message), { status });
const id = () => crypto.randomUUID();
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function text(value, label, max = 200, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) throw fail(400, `${label} is invalid.`);
  return value.trim();
}
function email(value) { const v = text(value, 'Email', 254); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw fail(400, 'Enter a valid email address.'); return v; }
function website(value) { const v = text(value, 'Website', 2048); if (!v) return ''; let u; try { u = new URL(v); } catch { throw fail(400, 'Enter a full HTTP or HTTPS website address.'); } if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw fail(400, 'Enter a full HTTP or HTTPS website address.'); return u.href; }
function followDate(value) { if (value === '' || value === null) return null; if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw fail(400, 'Choose a valid follow-up date.'); return value; }
function amount(value) { if (value === null || value === '') return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12 || Math.abs(value * 100 - Math.round(value * 100)) > .0001) throw fail(400, 'Deal value must be a positive amount with up to two decimals, or zero.'); return value; }
const contactView = r => r && ({ id:r.id, companyId:r.company_id, companyName:r.company_name, placeId:r.place_id, name:r.name, email:r.email, phone:r.phone, jobTitle:r.job_title, notes:r.notes, version:r.version, archivedAt:r.archived_at, createdAt:r.created_at, updatedAt:r.updated_at });
const dealView = r => r && ({ id:r.id, companyId:r.company_id, companyName:r.company_name, placeId:r.place_id, contactId:r.contact_id, contactName:r.contact_name || null, title:r.title, stage:r.stage, value:r.value, currency:r.currency, ownerId:r.owner_id, followUpDate:r.follow_up_date, notes:r.notes, version:r.version, archivedAt:r.archived_at, createdAt:r.created_at, updatedAt:r.updated_at });

export function createCrmService({ database = db, now = Date.now, validateAssignee = value => workspaceAuth.assertActiveWorkspaceUser(value, { assignable:true }) } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS crm_companies (
    id TEXT PRIMARY KEY, place_id TEXT NOT NULL UNIQUE REFERENCES businesses(place_id), created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crm_contacts (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id), name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1, archived_at INTEGER, request_key TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crm_deals (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id), contact_id TEXT REFERENCES crm_contacts(id),
    title TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new', value REAL, currency TEXT NOT NULL DEFAULT 'USD', owner_id TEXT,
    follow_up_date TEXT, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
    archived_at INTEGER, request_key TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crm_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL REFERENCES crm_companies(id), deal_id TEXT, actor_id TEXT,
    action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crm_creation_requests (request_key TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,entity_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON crm_contacts(company_id,archived_at);
  CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(stage,owner_id,archived_at);
  CREATE INDEX IF NOT EXISTS idx_crm_deals_company ON crm_deals(company_id,archived_at);`);
  function atomic(action) { const key = `crm_${crypto.randomBytes(5).toString('hex')}`; database.exec(`SAVEPOINT ${key}`); try { const result = action(); database.exec(`RELEASE ${key}`); return result; } catch (e) { database.exec(`ROLLBACK TO ${key}; RELEASE ${key}`); throw e; } }
  function log(companyId, action, detail, actor, dealId = null) { database.prepare('INSERT INTO crm_activity(company_id,deal_id,actor_id,action,detail_json,created_at) VALUES(?,?,?,?,?,?)').run(companyId,dealId,actor?.id || null,action,JSON.stringify(detail),now()); }
  function replay(kind,key,payload) { const row=database.prepare('SELECT * FROM crm_creation_requests WHERE request_key=?').get(key);if(!row)return null;if(row.kind!==kind||row.digest!==fingerprint(payload))throw fail(409,'This creation request has different saved details. Start a new record.');return row.entity_id; }
  function remember(kind,key,payload,entityId) {database.prepare('INSERT INTO crm_creation_requests(request_key,kind,digest,entity_id) VALUES(?,?,?,?)').run(key,kind,fingerprint(payload),entityId);}
  function business(placeId) { const r = database.prepare('SELECT * FROM businesses WHERE place_id=? AND deleted_at IS NULL').get(String(placeId)); if (!r) throw fail(404, 'This business is unavailable or in Trash.'); return r; }
  function company(companyId) { const r = database.prepare(`SELECT c.id,c.place_id,b.name,b.category,b.website,b.phone_e164,b.phone_national,b.emails,b.country_code,b.address,b.notes,c.created_at FROM crm_companies c JOIN businesses b ON b.place_id=c.place_id WHERE c.id=? AND b.deleted_at IS NULL`).get(String(companyId)); if (!r) throw fail(404, 'This company is unavailable or its lead is in Trash.'); let emails = [];try{emails=JSON.parse(r.emails||'[]');}catch{} return {id:r.id,placeId:r.place_id,name:r.name,category:r.category || '',website:r.website || '',phone:r.phone_e164 || r.phone_national || '',emails,address:r.address || '',country:r.country_code || '',notes:r.notes,createdAt:r.created_at}; }
  function ensureCompany(placeId, actor) {
    const lead = business(placeId); const existing = database.prepare('SELECT id FROM crm_companies WHERE place_id=?').get(lead.place_id); if (existing) return company(existing.id);
    const companyId = id(); database.prepare('INSERT INTO crm_companies(id,place_id,created_at) VALUES(?,?,?)').run(companyId,lead.place_id,now()); log(companyId,'company_added',{name:lead.name},actor); return company(companyId);
  }
  function createCompany(body = {}, actor) {
    if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Company details are required.');
    if (body.placeId) return atomic(() => ensureCompany(body.placeId,actor));
    const name = text(body.name,'Company name',200,true), web = website(body.website || ''), mail = email(body.email || ''), phone = text(body.phone || '', 'Phone', 50);
    const requestKey = text(body.requestKey,'Creation request',100,true);
    const payload={name,web,mail,phone},replayed=replay('company',requestKey,payload);if(replayed)return company(replayed);
    const placeId = `manual:${crypto.createHash('sha256').update(requestKey).digest('hex')}`;
    const exists = database.prepare('SELECT place_id,name FROM businesses WHERE place_id=?').get(placeId);
    if (exists) { if (exists.name !== name) throw fail(409,'This creation request belongs to a different company.'); return ensureCompany(placeId,actor); }
    return atomic(() => {
      const international=phone.replace(/[ ()-]/g,'');
      database.prepare(`INSERT INTO businesses(place_id,name,website,website_domain,phone_national,phone_e164,emails,site_status,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(placeId,name,web,web ? new URL(web).hostname : '',phone,/^\+[1-9]\d{6,14}$/.test(international)?international:null,JSON.stringify(mail ? [mail] : []),web ? 'unknown' : 'none',now(),now());
      const result=ensureCompany(placeId,actor);remember('company',requestKey,payload,result.id);return result;
    });
  }
  /**
   * Admit a group of discovered businesses to the CRM in one idempotent
   * operation. A lead is a company in the CRM; optional contact records use
   * only details already present on the lead and never invent a person.
   */
  function bulkCreateCompanies(body = {}, actor) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'Choose at least one business.');
    if (!Array.isArray(body.placeIds) || !body.placeIds.length || body.placeIds.length > 1000 || body.placeIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 300)) {
      throw fail(400, 'Choose between 1 and 1,000 businesses.');
    }
    const placeIds = [...new Set(body.placeIds.map(value => value.trim()))];
    const createContacts = body.createContacts === true;
    const batchKey = body.requestKey == null ? null : text(body.requestKey, 'Creation request', 100, true);
    const companies = { created: 0, alreadyInCrm: 0, total: 0 };
    const contacts = { created: 0, alreadyInCrm: 0, skipped: 0 };
    const failures = [];
    for (const placeId of placeIds) {
      let record;
      const existing = database.prepare('SELECT id FROM crm_companies WHERE place_id=?').get(placeId);
      try {
        record = atomic(() => ensureCompany(placeId, actor));
      } catch (error) {
        if (error.status && error.status < 500) { failures.push({ placeId, reason: error.message }); continue; }
        throw error;
      }
      companies.total += 1;
      if (existing) companies.alreadyInCrm += 1; else companies.created += 1;
      if (!createContacts) continue;

      const lead = business(placeId);
      let emails = [];
      try { emails = JSON.parse(lead.emails || '[]'); } catch { emails = []; }
      const emailValue = Array.isArray(emails) && typeof emails[0] === 'string' ? emails[0].trim() : '';
      const phoneValue = String(lead.phone_e164 || lead.phone_national || '').trim();
      if (!emailValue && !phoneValue) { contacts.skipped += 1; continue; }
      const duplicate = database.prepare(`SELECT id FROM crm_contacts WHERE company_id=? AND archived_at IS NULL
        AND ((email != '' AND email=?) OR (phone != '' AND phone=?)) LIMIT 1`).get(record.id, emailValue, phoneValue);
      if (duplicate) { contacts.alreadyInCrm += 1; continue; }
      try {
        // Contact creation requests are replay-safe while staying inside the
        // 100-character request-key limit, even when a caller supplies a
        // maximum-length batch key.
        const contactKey = batchKey
          ? `bulk:${crypto.createHash('sha256').update(`${batchKey}:${placeId}`).digest('hex')}`
          : crypto.randomUUID();
        saveContact({ companyId: record.id, name: lead.name, email: emailValue, phone: phoneValue, jobTitle: 'Business contact', requestKey: contactKey }, actor);
        contacts.created += 1;
      } catch (error) {
        if (error.status && error.status < 500) { failures.push({ placeId, reason: error.message }); continue; }
        throw error;
      }
    }
    return { requested: placeIds.length, companies, contacts: createContacts ? contacts : null, failures };
  }
  function contact(contactId, includeArchived = false) { const r = database.prepare(`SELECT p.*,b.name AS company_name,c.place_id FROM crm_contacts p JOIN crm_companies c ON c.id=p.company_id JOIN businesses b ON b.place_id=c.place_id WHERE p.id=? AND b.deleted_at IS NULL ${includeArchived ? '' : 'AND p.archived_at IS NULL'}`).get(String(contactId)); if (!r) throw fail(404,'Contact not found.');return contactView(r); }
  function deal(dealId, includeArchived = false) { const r = database.prepare(`SELECT d.*,b.name AS company_name,c.place_id,p.name AS contact_name FROM crm_deals d JOIN crm_companies c ON c.id=d.company_id JOIN businesses b ON b.place_id=c.place_id LEFT JOIN crm_contacts p ON p.id=d.contact_id WHERE d.id=? AND b.deleted_at IS NULL ${includeArchived ? '' : 'AND d.archived_at IS NULL'}`).get(String(dealId));if(!r)throw fail(404,'Deal not found.'); return dealView(r); }
  function checkVersion(body, current) { if (!Number.isInteger(body.version) || body.version !== current.version) throw fail(409,'This record changed. Reload it before saving your changes.'); }
  function contactFields(body, previous = {}) { return { name:text(body.name ?? previous.name,'Contact name',160,true),email:email(body.email ?? previous.email ?? ''),phone:text(body.phone ?? previous.phone ?? '','Phone',50),jobTitle:text(body.jobTitle ?? previous.jobTitle ?? '','Job title',120),notes:text(body.notes ?? previous.notes ?? '','Contact notes',10000) }; }
  function saveContact(body, actor, contactId) {
    if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Contact details are required.');
    const previous = contactId ? contact(contactId) : null; if (previous) checkVersion(body,previous);
    const companyId = previous?.companyId || body.companyId; company(companyId);
    if (previous && body.companyId && body.companyId !== companyId) throw fail(400,'A contact cannot be moved to another company.');
    const next = contactFields(body,previous || {}); const requestKey = previous ? null : text(body.requestKey,'Creation request',100,true);
    const payload={companyId,...next},replayed=requestKey&&replay('contact',requestKey,payload);if(replayed)return contact(replayed,true);
    const existing = requestKey && database.prepare('SELECT id,company_id FROM crm_contacts WHERE request_key=?').get(requestKey);
    if (existing) { if (existing.company_id !== companyId) throw fail(409,'This request belongs to a different company.');return contact(existing.id,true); }
    return atomic(() => {
      const nextId = previous?.id || id();
      if(previous)database.prepare('UPDATE crm_contacts SET name=?,email=?,phone=?,job_title=?,notes=?,version=version+1,updated_at=? WHERE id=?').run(next.name,next.email,next.phone,next.jobTitle,next.notes,now(),nextId);
      else database.prepare('INSERT INTO crm_contacts(id,company_id,name,email,phone,job_title,notes,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(nextId,companyId,next.name,next.email,next.phone,next.jobTitle,next.notes,requestKey,now(),now());
      if(requestKey)remember('contact',requestKey,payload,nextId);
      log(companyId,previous ? 'contact_updated':'contact_added',{contactId:nextId,name:next.name},actor); return contact(nextId);
    });
  }
  function dealFields(body, previous = {}) {
    const next = { title:text(body.title ?? previous.title,'Deal name',200,true),stage:body.stage ?? previous.stage ?? 'new',value:own(body,'value') ? amount(body.value) : previous.value ?? null,currency:body.currency ?? previous.currency ?? 'USD',ownerId:own(body,'ownerId') ? body.ownerId || null : previous.ownerId || null,contactId:own(body,'contactId') ? body.contactId || null : previous.contactId || null,followUpDate:own(body,'followUpDate') ? followDate(body.followUpDate) : previous.followUpDate || null,notes:text(body.notes ?? previous.notes ?? '','Deal notes',10000) };
    if(!DEAL_STAGES.some(([stage])=>stage===next.stage))throw fail(400,'Choose a valid deal stage.');
    if(typeof next.currency!=='string'||!['USD','CAD','GBP','EUR','AUD','NZD','PKR','AED','SAR','INR'].includes(next.currency))throw fail(400,'Choose a supported deal currency.');
    if(next.ownerId && (!previous.ownerId || own(body,'ownerId'))) validateAssignee(next.ownerId);
    return next;
  }
  function saveDeal(body, actor, dealId) {
    if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'Deal details are required.');
    const previous = dealId ? deal(dealId) : null; if(previous)checkVersion(body,previous);
    const companyId=previous?.companyId || body.companyId; company(companyId);
    if(previous&&body.companyId&&body.companyId!==companyId)throw fail(400,'A deal cannot be moved to another company.');
    const next=dealFields(body,previous||{});
    if(next.contactId) { const target=contact(next.contactId,previous?.contactId===next.contactId);if(target.companyId!==companyId)throw fail(400,'Choose a contact from this company.'); }
    const requestKey=previous?null:text(body.requestKey,'Creation request',100,true);
    const payload={companyId,...next},replayed=requestKey&&replay('deal',requestKey,payload);if(replayed)return deal(replayed,true);
    const existing=requestKey&&database.prepare('SELECT id,company_id FROM crm_deals WHERE request_key=?').get(requestKey);
    if(existing){if(existing.company_id!==companyId)throw fail(409,'This request belongs to a different company.');return deal(existing.id,true);}
    return atomic(()=>{
      const nextId=previous?.id||id();
      const values=[next.contactId,next.title,next.stage,next.value,next.currency,next.ownerId,next.followUpDate,next.notes];
      if(previous)database.prepare('UPDATE crm_deals SET contact_id=?,title=?,stage=?,value=?,currency=?,owner_id=?,follow_up_date=?,notes=?,version=version+1,updated_at=? WHERE id=?').run(...values,now(),nextId);
      else database.prepare('INSERT INTO crm_deals(id,company_id,contact_id,title,stage,value,currency,owner_id,follow_up_date,notes,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nextId,companyId,...values,requestKey,now(),now());
      if(requestKey)remember('deal',requestKey,payload,nextId);
      log(companyId,previous ? (previous.stage!==next.stage?'deal_stage_changed':'deal_updated'):'deal_added',{title:next.title,from:previous?.stage||null,to:next.stage,ownerId:next.ownerId},actor,nextId);return deal(nextId);
    });
  }
  function archive(kind, entityId, body, actor, restore=false) {
    if(!['contact','deal'].includes(kind))throw fail(400,'Unknown CRM record.');
    const current=kind==='contact'?contact(entityId,true):deal(entityId,true);checkVersion(body,current);
    if(Boolean(current.archivedAt)===!restore)return current;
    return atomic(()=>{database.prepare(`UPDATE crm_${kind==='contact'?'contacts':'deals'} SET archived_at=?,version=version+1,updated_at=? WHERE id=?`).run(restore?null:now(),now(),entityId);log(current.companyId,`${kind}_${restore?'restored':'archived'}`,{id:entityId},actor,kind==='deal'?entityId:null);return kind==='contact'?contact(entityId,true):deal(entityId,true);});
  }
  function list(kind, filters={}) {
    const page=Number(filters.page||0),limit=Number(filters.limit||100);
    if(!Number.isInteger(page)||page<0||!Number.isInteger(limit)||limit<1||limit>500)throw fail(400,'Invalid CRM page.');
    const q=String(filters.q||'').trim().slice(0,200),params=[],where=['b.deleted_at IS NULL'];let from,columns,order,view;
    if(kind==='companies') {from='crm_companies c JOIN businesses b ON b.place_id=c.place_id';columns='c.id';order='c.created_at DESC,c.id';view=r=>({...company(r.id),contactCount:database.prepare('SELECT COUNT(*) n FROM crm_contacts WHERE company_id=? AND archived_at IS NULL').get(r.id).n,dealCount:database.prepare('SELECT COUNT(*) n FROM crm_deals WHERE company_id=? AND archived_at IS NULL').get(r.id).n});if(q){where.push('(b.name LIKE ? OR b.website LIKE ? OR b.category LIKE ?)');params.push(...Array(3).fill(`%${q}%`));}}
    else if(kind==='contacts') {from='crm_contacts p JOIN crm_companies c ON c.id=p.company_id JOIN businesses b ON b.place_id=c.place_id';columns='p.id';order='p.updated_at DESC,p.id';view=r=>contact(r.id,true);where.push(filters.archived==='1'?'p.archived_at IS NOT NULL':'p.archived_at IS NULL');if(q){where.push('(p.name LIKE ? OR p.email LIKE ? OR p.phone LIKE ? OR b.name LIKE ?)');params.push(...Array(4).fill(`%${q}%`));}}
    else if(kind==='deals') {from='crm_deals d JOIN crm_companies c ON c.id=d.company_id JOIN businesses b ON b.place_id=c.place_id';columns='d.id';order='d.updated_at DESC,d.id';view=r=>deal(r.id,true);where.push(filters.archived==='1'?'d.archived_at IS NOT NULL':'d.archived_at IS NULL');if(q){where.push('(d.title LIKE ? OR b.name LIKE ?)');params.push(...Array(2).fill(`%${q}%`));}if(filters.stage){if(!DEAL_STAGES.some(([s])=>s===filters.stage))throw fail(400,'Choose a valid deal stage.');where.push('d.stage=?');params.push(filters.stage);}if(filters.ownerId){where.push(filters.ownerId==='unassigned'?'d.owner_id IS NULL':'d.owner_id=?');if(filters.ownerId!=='unassigned')params.push(String(filters.ownerId));}}
    else throw fail(400,'Unknown CRM view.');
    if(filters.companyId){where.push('c.id=?');params.push(String(filters.companyId));}
    const clause=where.join(' AND '),total=database.prepare(`SELECT COUNT(*) n FROM ${from} WHERE ${clause}`).get(...params).n;
    const rows=database.prepare(`SELECT ${columns} FROM ${from} WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,limit,page*limit).map(view);
    return {rows,total,page,limit,hasMore:(page+1)*limit<total};
  }
  function board(filters={}) { return {stages:DEAL_STAGES.map(([key,label])=>({id:key,label,...list('deals',{...filters,stage:key,page:0,limit:50})})),totalsByCurrency:database.prepare(`SELECT d.currency,COUNT(*) AS deals,SUM(COALESCE(d.value,0)) AS value FROM crm_deals d JOIN crm_companies c ON c.id=d.company_id JOIN businesses b ON b.place_id=c.place_id WHERE d.archived_at IS NULL AND b.deleted_at IS NULL AND d.stage NOT IN ('won','lost') GROUP BY d.currency`).all()}; }
  function companyDetail(companyId) { return {company:company(companyId),contacts:list('contacts',{companyId,limit:500}).rows,deals:list('deals',{companyId,limit:500}).rows,activity:database.prepare('SELECT id,deal_id AS dealId,actor_id AS actorId,action,detail_json AS detailJson,created_at AS createdAt FROM crm_activity WHERE company_id=? ORDER BY id DESC LIMIT 100').all(companyId).map(r=>({...r,detail:JSON.parse(r.detailJson),detailJson:undefined}))}; }
  function forLead(placeId) {business(placeId);const row=database.prepare('SELECT id FROM crm_companies WHERE place_id=?').get(placeId);return row?companyDetail(row.id):{company:null,contacts:[],deals:[],activity:[]};}
  return {createCompany,bulkCreateCompanies,ensureCompany,list,companyDetail,forLead,contact,saveContact,deal,saveDeal,archive,board};
}
export const crmService=createCrmService();
