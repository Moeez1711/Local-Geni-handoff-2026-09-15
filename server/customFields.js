/** Durable, typed business data. Stable field IDs survive labels, archiving and exports. */
import crypto from 'node:crypto';
import { db, json, tx } from './db.js';
import { getLead } from './repo.js';
import { validateUrl } from './previewRepo.js';

export const CUSTOM_FIELD_TYPES = ['text','textarea','number','date','select','checkbox','url'];
export const CUSTOM_FIELD_LIMITS = Object.freeze({ definitions:100, options:50, label:100, text:500, textarea:5000, number:1e15, url:2048 });
db.exec(`
CREATE TABLE IF NOT EXISTS custom_field_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO custom_field_meta(id,version) VALUES(1,0);
CREATE TABLE IF NOT EXISTS custom_field_definitions (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, label_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
 options_json TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_field_values (
 place_id TEXT NOT NULL REFERENCES businesses(place_id), field_id TEXT NOT NULL REFERENCES custom_field_definitions(id),
 value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(place_id,field_id)
);
CREATE TABLE IF NOT EXISTS custom_field_lead_versions (
 place_id TEXT PRIMARY KEY REFERENCES businesses(place_id), version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_custom_field_values_definition ON custom_field_values(field_id);
`);
const error = (status,code,message) => Object.assign(new Error(message),{status,code,customFieldsSafe:true});
const isObject = (value) => value && typeof value==='object' && !Array.isArray(value);
const labelKey = (value) => value.normalize('NFKC').toLocaleLowerCase('en-US');
function cleanLabel(value,what='Field label',max=100) {
  if (typeof value!=='string' || !value.trim() || value.trim().length>max || /[\x00-\x1f\x7f]/.test(value)) throw error(400,'CUSTOM_FIELD_INVALID',`${what} must be between 1 and ${max} characters on one line.`);
  return value.trim();
}
function cleanOptions(options,type) {
  if (type!=='select') {
    if (options!==undefined && (!Array.isArray(options) || options.length)) throw error(400,'CUSTOM_FIELD_INVALID','Only select fields have options.');
    return [];
  }
  if (!Array.isArray(options) || options.length<1 || options.length>CUSTOM_FIELD_LIMITS.options) throw error(400,'CUSTOM_FIELD_INVALID','A select field needs between 1 and 50 options.');
  const cleaned=options.map((value) => cleanLabel(value,'Option',120));
  if (new Set(cleaned.map(labelKey)).size!==cleaned.length) throw error(400,'CUSTOM_FIELD_INVALID','Select options must be unique.');
  return cleaned;
}
const definitionView = (row) => ({id:row.id,label:row.label,type:row.type,options:json(row.options_json,[]),archived:!!row.archived,createdAt:row.created_at,updatedAt:row.updated_at});
const version = () => db.prepare('SELECT version FROM custom_field_meta WHERE id=1').get().version;
const bumpVersion = () => db.prepare('UPDATE custom_field_meta SET version=version+1 WHERE id=1').run();
function assertDefinitionsVersion(provided,required=false) {
  if (provided===undefined && !required) return;
  if (!Number.isSafeInteger(provided) || provided<0) throw error(400,'CUSTOM_FIELDS_VERSION_REQUIRED','Include the current definitionsVersion.');
  if (provided!==version()) throw error(409,'CUSTOM_FIELDS_STALE','The field definitions changed. Reload before saving.');
}
function definitionRow(id) {
  const row=db.prepare('SELECT * FROM custom_field_definitions WHERE id=?').get(String(id));
  if (!row) throw error(404,'CUSTOM_FIELD_NOT_FOUND','This custom field was not found.');
  return row;
}
function assertLiveLead(placeId) {
  if (typeof placeId!=='string' || !getLead(placeId)) throw error(404,'CUSTOM_FIELD_LEAD_NOT_FOUND','This business is unavailable or in Trash.');
}
function assertUniqueLabel(label,exceptId='') {
  if (db.prepare('SELECT 1 FROM custom_field_definitions WHERE label_key=? AND id!=?').get(labelKey(label),exceptId)) throw error(409,'CUSTOM_FIELD_LABEL_EXISTS','A field with this label already exists, including archived fields.');
}

export function listCustomFields({includeArchived=false}={}) {
  const all=includeArchived===true || includeArchived==='true' || includeArchived==='1';
  return {rows:db.prepare(`SELECT * FROM custom_field_definitions ${all ? '' : 'WHERE archived=0'} ORDER BY created_at,id`).all().map(definitionView),definitionsVersion:version()};
}
export function createCustomField(body={}) {
  if (!isObject(body)) throw error(400,'CUSTOM_FIELD_INVALID','Provide a custom field definition.');
  const label=cleanLabel(body.label),type=body.type;
  if (!CUSTOM_FIELD_TYPES.includes(type)) throw error(400,'CUSTOM_FIELD_INVALID','Choose a supported field type.');
  const options=cleanOptions(body.options,type);
  return tx(() => {
    assertDefinitionsVersion(body.definitionsVersion);
    if (db.prepare('SELECT count(*) n FROM custom_field_definitions').get().n>=CUSTOM_FIELD_LIMITS.definitions) throw error(409,'CUSTOM_FIELD_LIMIT','This workspace supports up to 100 custom fields, including archived fields.');
    assertUniqueLabel(label);
    const id=`cf_${crypto.randomUUID()}`,now=Date.now();
    db.prepare('INSERT INTO custom_field_definitions(id,label,label_key,type,options_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,label,labelKey(label),type,JSON.stringify(options),now,now);
    bumpVersion(); return {field:definitionView(definitionRow(id)),definitionsVersion:version()};
  });
}
export function updateCustomField(id,body={}) {
  if (!isObject(body)) throw error(400,'CUSTOM_FIELD_INVALID','Provide a custom field definition.');
  return tx(() => {
    assertDefinitionsVersion(body.definitionsVersion);
    const row=definitionRow(id),old=definitionView(row);
    if ((body.id!==undefined && body.id!==row.id) || (body.type!==undefined && body.type!==row.type)) throw error(400,'CUSTOM_FIELD_TYPE_IMMUTABLE','Field IDs and types cannot change. Create another field if needed.');
    const label=body.label===undefined ? row.label : cleanLabel(body.label);
    const options=body.options===undefined ? old.options : cleanOptions(body.options,row.type);
    assertUniqueLabel(label,row.id);
    if (row.type==='select' && old.options.some((option) => !options.includes(option))) {
      const saved=db.prepare('SELECT DISTINCT value_json FROM custom_field_values WHERE field_id=?').all(row.id).map((item) => json(item.value_json));
      if (saved.some((value) => !options.includes(value))) throw error(409,'CUSTOM_FIELD_OPTION_IN_USE','An option you removed is saved on a business. Keep that option or deliberately update those saved values first.');
    }
    if (label!==row.label || JSON.stringify(options)!==row.options_json) {
      db.prepare('UPDATE custom_field_definitions SET label=?,label_key=?,options_json=?,updated_at=? WHERE id=?').run(label,labelKey(label),JSON.stringify(options),Date.now(),row.id);
      bumpVersion();
    }
    return {field:definitionView(definitionRow(row.id)),definitionsVersion:version()};
  });
}
export function archiveCustomField(id,archived=true,body={}) {
  if (!isObject(body)) throw error(400,'CUSTOM_FIELD_INVALID','Provide the current definition revision.');
  return tx(() => {
    assertDefinitionsVersion(body.definitionsVersion);
    const row=definitionRow(id);
    if (!!row.archived!==archived) { db.prepare('UPDATE custom_field_definitions SET archived=?,updated_at=? WHERE id=?').run(archived ? 1 : 0,Date.now(),row.id); bumpVersion(); }
    return {field:definitionView(definitionRow(row.id)),definitionsVersion:version()};
  });
}

export function validateCustomFieldValue(field,value) {
  if (value===null || value==='') return null;
  const invalid=(message) => {throw error(400,'CUSTOM_FIELD_VALUE_INVALID',`${field.label}: ${message}`);};
  if (field.type==='text' || field.type==='textarea') {
    const max=CUSTOM_FIELD_LIMITS[field.type];
    if (typeof value!=='string' || value.length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (field.type==='text' && /[\r\n]/.test(value))) invalid(`enter text of ${max} characters or fewer${field.type==='text' ? ' on one line' : ''}.`);
    return value;
  }
  if (field.type==='number') { if (typeof value!=='number' || !Number.isFinite(value) || Math.abs(value)>CUSTOM_FIELD_LIMITS.number) invalid('enter a finite number between -1000000000000000 and 1000000000000000.'); return value; }
  if (field.type==='checkbox') { if (typeof value!=='boolean') invalid('use true or false.'); return value; }
  if (field.type==='select') { if (typeof value!=='string' || !field.options.includes(value)) invalid('choose one of this field’s saved options.'); return value; }
  if (field.type==='date') {
    if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)!==value) invalid('enter a real date in YYYY-MM-DD format.');
    return value;
  }
  if (field.type==='url') {
    if (typeof value!=='string' || value.length>CUSTOM_FIELD_LIMITS.url || /[\s\x00-\x1f\x7f]/.test(value)) invalid('enter a public HTTP or HTTPS URL.');
    try {
      const parsed=new URL(value);
      if (!['http:','https:'].includes(parsed.protocol)) invalid('enter a public HTTP or HTTPS URL.');
      const https=new URL(parsed.href); https.protocol='https:'; validateUrl(https.href,'Custom URL');
      return parsed.href;
    } catch { invalid('enter a public HTTP or HTTPS URL without credentials or a private address.'); }
  }
  invalid('unsupported field type.');
}
export function getLeadCustomFields(placeId) {
  assertLiveLead(placeId);
  const definitions=listCustomFields({includeArchived:true});
  return {placeId,version:db.prepare('SELECT version FROM custom_field_lead_versions WHERE place_id=?').get(placeId)?.version || 0,definitionsVersion:definitions.definitionsVersion,
    values:Object.fromEntries(db.prepare('SELECT field_id,value_json FROM custom_field_values WHERE place_id=?').all(placeId).map((row) => [row.field_id,json(row.value_json)])),definitions:definitions.rows};
}
export function saveLeadCustomFields(placeId,body={}) {
  if (!isObject(body) || !isObject(body.values)) throw error(400,'CUSTOM_FIELD_VALUES_INVALID','Provide values keyed by stable field ID.');
  if (Object.keys(body.values).length>CUSTOM_FIELD_LIMITS.definitions) throw error(400,'CUSTOM_FIELD_VALUES_INVALID','Save up to 100 fields at a time.');
  if (!Number.isSafeInteger(body.version) || body.version<0) throw error(400,'CUSTOM_VALUES_VERSION_REQUIRED','Include the current business field version.');
  return tx(() => {
    assertLiveLead(placeId); assertDefinitionsVersion(body.definitionsVersion,true);
    const current=getLeadCustomFields(placeId);
    if (current.version!==body.version) throw error(409,'CUSTOM_VALUES_STALE','These business fields changed in another view. Reload before saving.');
    const definitions=new Map(current.definitions.map((field) => [field.id,field]));
    const changes=[];
    for (const [id,value] of Object.entries(body.values)) {
      const field=definitions.get(id);
      if (!field) throw error(400,'CUSTOM_FIELD_NOT_FOUND','A supplied field no longer exists. Reload the field definitions.');
      if (field.archived) throw error(409,'CUSTOM_FIELD_ARCHIVED',`${field.label} is archived. Restore it before editing its value.`);
      const validated=validateCustomFieldValue(field,value);
      if (validated===null ? Object.hasOwn(current.values,id) : JSON.stringify(validated)!==JSON.stringify(current.values[id])) changes.push([id,validated]);
    }
    const now=Date.now();
    for (const [id,value] of changes) {
      if (value===null) db.prepare('DELETE FROM custom_field_values WHERE place_id=? AND field_id=?').run(placeId,id);
      else db.prepare('INSERT INTO custom_field_values(place_id,field_id,value_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(place_id,field_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(placeId,id,JSON.stringify(value),now);
    }
    if (changes.length) db.prepare('INSERT INTO custom_field_lead_versions(place_id,version) VALUES(?,1) ON CONFLICT(place_id) DO UPDATE SET version=version+1').run(placeId);
    return getLeadCustomFields(placeId);
  });
}

/** Pure exporters receive this explicit snapshot, without importing the live database. */
export function getCustomFieldsForExport(rows) {
  const customFields=listCustomFields().rows;
  const customValues=Object.create(null);
  const ids=[...new Set(rows.map((row) => row.place_id).filter((id) => typeof id==='string'))];
  for (let offset=0;offset<ids.length;offset+=250) {
    const batch=ids.slice(offset,offset+250);
    const saved=db.prepare(`SELECT v.place_id,v.field_id,v.value_json FROM custom_field_values v JOIN custom_field_definitions f ON f.id=v.field_id JOIN businesses b ON b.place_id=v.place_id WHERE f.archived=0 AND b.deleted_at IS NULL AND v.place_id IN (${batch.map(() => '?').join(',')})`).all(...batch);
    for (const row of saved) { customValues[row.place_id] ||= Object.create(null); customValues[row.place_id][row.field_id]=json(row.value_json); }
  }
  return {customFields,customValues};
}

export const customFieldsService={list:listCustomFields,create:createCustomField,update:updateCustomField,archive:(id,body) => archiveCustomField(id,true,body),restore:(id,body) => archiveCustomField(id,false,body),getValues:getLeadCustomFields,saveValues:saveLeadCustomFields};
