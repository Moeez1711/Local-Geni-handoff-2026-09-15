/** Verified Meta webhook input only. No public unsigned ingestion or media downloads.
 * HMAC protocol: Meta's fbsamples/business-messaging-sample-tech-provider-app.
 */
import crypto from 'node:crypto';
import {db,json,tx} from './db.js';
import {getLead} from './repo.js';
import {recordActivity} from './previewRepo.js';

db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_webhook_config (
 id INTEGER PRIMARY KEY CHECK(id=1), account_key TEXT NOT NULL, app_secret TEXT, verify_token TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
 id TEXT PRIMARY KEY, account_key TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_inbox_messages (
 id TEXT PRIMARY KEY, account_key TEXT NOT NULL, number TEXT NOT NULL, profile_name TEXT,
 type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', media_json TEXT, context_message_id TEXT,
 received_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_thread ON whatsapp_inbox_messages(account_key,number,received_at);
CREATE TABLE IF NOT EXISTS whatsapp_delivery_events (
 id TEXT PRIMARY KEY, account_key TEXT NOT NULL, message_id TEXT NOT NULL, number TEXT NOT NULL,
 status TEXT NOT NULL, occurred_at INTEGER NOT NULL, error_code INTEGER, received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_delivery_message ON whatsapp_delivery_events(account_key,message_id);
`);
const fail=(status,code,message) => Object.assign(new Error(message),{status,code,whatsappSafe:true});
const digest=(value) => crypto.createHash('sha256').update(value).digest('hex');
const numberFor=(value) => {
  const result=String(value || '').trim().replace(/^\+/,'').replace(/[ ()-]/g,'');
  if(!/^[1-9]\d{6,14}$/.test(result)) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','The webhook contains an invalid phone number.');
  return result;
};
const messageId=(value) => typeof value==='string' && /^wamid\.[A-Za-z0-9_+/=.-]{1,1000}$/.test(value);
const boundedText=(value,max=4096) => typeof value==='string' ? value.slice(0,max) : '';
const optOut=(text) => /^(?:stop|unsubscribe|opt[ -]?out|remove me|please stop|stop messaging me|do not contact me|don'?t contact me|not interested|no thanks)[\s.!]*$/i.test(text.trim());
const sameSecret=(left,right) => {const a=Buffer.from(String(left)),b=Buffer.from(String(right));return a.length===b.length && crypto.timingSafeEqual(a,b);};

export function createWhatsAppInbox({getAccount,vault,now=()=>Date.now(),recordActivityFn=recordActivity}) {
  const accountKey=() => {const account=getAccount();return account.businessAccountId && account.phoneNumberId ? `${account.businessAccountId}:${account.phoneNumberId}` : '';};
  const configRow=() => db.prepare('SELECT * FROM whatsapp_webhook_config WHERE id=1 AND account_key=?').get(accountKey());
  const unlock=(row,column) => {try{return row?.[column] ? vault.open(row[column],`whatsapp-webhook:${row.account_key}:${column}`) : null;}catch{throw fail(409,'WHATSAPP_WEBHOOK_KEY_UNAVAILABLE','Reconnect the webhook credentials.');}};
  function getStatus() {
    const row=configRow();
    return {hasAppSecret:!!row?.app_secret,hasVerifyToken:!!row?.verify_token,webhookConfigured:!!row?.app_secret && !!row?.verify_token,
      lastWebhookAt:db.prepare('SELECT MAX(received_at) time FROM whatsapp_webhook_events WHERE account_key=?').get(accountKey())?.time || null};
  }
  function saveConfiguration(body={}) {
    const key=accountKey();if(!key) throw fail(409,'WHATSAPP_NOT_CONNECTED','Save a WhatsApp business account first.');
    const old=configRow();let appSecret=old?.app_secret || null,verifyToken=old?.verify_token || null,changed=false;
    for(const [field,column] of [['appSecret','app_secret'],['verifyToken','verify_token']]) {
      if(body[field]===undefined || body[field]==='') continue;
      if(typeof body[field]!=='string' || body[field].length<16 || body[field].length>1024 || /\s|[\x00-\x1f\x7f]/.test(body[field])) throw fail(400,'WHATSAPP_WEBHOOK_SECRET_INVALID','Webhook secrets must contain 16–1024 characters without spaces.');
      let sealed;try{sealed=vault.seal(body[field],`whatsapp-webhook:${key}:${column}`);}catch{throw fail(409,'WHATSAPP_WEBHOOK_KEY_UNAVAILABLE','Webhook credentials could not be stored securely.');}
      if(column==='app_secret') appSecret=sealed;else verifyToken=sealed;changed=true;
    }
    if(changed) db.prepare('INSERT INTO whatsapp_webhook_config(id,account_key,app_secret,verify_token,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_key=excluded.account_key,app_secret=excluded.app_secret,verify_token=excluded.verify_token,updated_at=excluded.updated_at').run(key,appSecret,verifyToken,now());
    return getStatus();
  }
  function clearConfiguration(){db.prepare('DELETE FROM whatsapp_webhook_config WHERE id=1').run();}
  function verifyWebhookChallenge(query={}) {
    const expected=unlock(configRow(),'verify_token');
    if(!expected || query['hub.mode']!=='subscribe' || typeof query['hub.verify_token']!=='string' || !sameSecret(expected,query['hub.verify_token']) || typeof query['hub.challenge']!=='string' || !/^\d{1,100}$/.test(query['hub.challenge'])) throw fail(403,'WHATSAPP_WEBHOOK_FORBIDDEN','Webhook verification was rejected.');
    return query['hub.challenge'];
  }
  function matchingLeads(number) {
    // Phone normalization mirrors outbound selection. Ambiguous duplicate matches are not guessed.
    return db.prepare('SELECT place_id,whatsapp,phone_e164 FROM businesses WHERE deleted_at IS NULL AND (whatsapp IS NOT NULL OR phone_e164 IS NOT NULL)').all().filter((lead)=>{
      for(const value of [lead.whatsapp,lead.phone_e164]) {try{if(numberFor(value)===number) return true;}catch{}}
      return false;
    }).map((lead)=>getLead(lead.place_id));
  }
  function stamp(value) {
    const seconds=typeof value==='string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
    const millis=seconds*1000;
    if(!Number.isSafeInteger(millis) || millis<=0 || millis>now()+300000) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','The webhook timestamp is invalid.');
    return millis;
  }
  function applyDeliveryStatus(providerMessageId) {
    const account=getAccount(),key=accountKey();
    const row=db.prepare('SELECT * FROM whatsapp_outbox WHERE provider_message_id=?').get(providerMessageId);if(!row) return;
    const snapshot=json(row.snapshot_json,{});
    if(snapshot.businessAccountId!==account.businessAccountId || (snapshot.phoneNumberId ? snapshot.phoneNumberId!==account.phoneNumberId : row.account_revision!==account.revision)) return;
    const events=db.prepare('SELECT * FROM whatsapp_delivery_events WHERE account_key=? AND message_id=? AND number=?').all(key,providerMessageId,row.number);
    if(!events.length) return;
    const at=(status)=>{const values=events.filter((e)=>e.status===status).map((e)=>e.occurred_at);return values.length ? Math.min(...values) : null;};
    const read=at('read'),delivered=at('delivered'),failed=at('failed'),sent=at('sent');
    const status=read ? 'read' : delivered ? 'delivered' : failed ? 'failed' : sent ? 'sent' : null;
    const code=events.filter((e)=>e.status==='failed').sort((a,b)=>b.occurred_at-a.occurred_at)[0]?.error_code || null;
    db.prepare('UPDATE whatsapp_outbox SET delivery_status=?,delivered_at=?,read_at=?,delivery_failed_at=?,delivery_error_code=?,updated_at=? WHERE id=?').run(status,delivered,read,failed,code,now(),row.id);
  }
  function ingestVerifiedWebhook(raw,signature) {
    const secret=unlock(configRow(),'app_secret');
    if(!secret) throw fail(409,'WHATSAPP_WEBHOOK_NOT_CONFIGURED','Configure the Meta app secret before receiving webhooks.');
    if((typeof raw!=='string' && !Buffer.isBuffer(raw)) || Buffer.byteLength(raw)>1024*1024 || typeof signature!=='string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) throw fail(403,'WHATSAPP_WEBHOOK_FORBIDDEN','Webhook authentication failed.');
    const expected=crypto.createHmac('sha256',secret).update(raw).digest();
    if(!crypto.timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'))) throw fail(403,'WHATSAPP_WEBHOOK_FORBIDDEN','Webhook authentication failed.');
    let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(raw)));}catch{throw fail(400,'WHATSAPP_WEBHOOK_INVALID','Webhook JSON is invalid.');}
    if(payload?.object!=='whatsapp_business_account' || !Array.isArray(payload.entry) || payload.entry.length>20) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','This is not a WhatsApp webhook.');
    const key=accountKey(),account=getAccount(),eventId=digest(Buffer.from(raw));
    if(db.prepare('SELECT 1 FROM whatsapp_webhook_events WHERE id=? AND account_key=?').get(eventId,key)) return {duplicate:true,messages:0,statuses:0};
    const incoming=[],statuses=[];let matched=false;
    for(const entry of payload.entry) {
      if(String(entry.id)!==account.businessAccountId) continue;
      if(!Array.isArray(entry.changes) || entry.changes.length>100) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','Webhook changes are invalid.');
      for(const change of entry.changes) {
        const value=change.value;
        if(change.field!=='messages' || value?.messaging_product!=='whatsapp' || String(value.metadata?.phone_number_id)!==account.phoneNumberId) continue;
        matched=true;
        for(const type of ['messages','statuses']) if(value[type]!==undefined && (!Array.isArray(value[type]) || value[type].length>100)) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','Webhook message list is invalid.');
        for(const message of value.messages || []) {
          if(!messageId(message.id)) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','Webhook message ID is invalid.');
          const number=numberFor(message.from),receivedAt=stamp(message.timestamp);
          const contact=(Array.isArray(value.contacts) ? value.contacts : []).find((c)=>String(c.wa_id)===number);
          let text='',media=null,type=boundedText(message.type,50) || 'unsupported';
          if(type==='text') {if(typeof message.text?.body!=='string' || message.text.body.length>4096) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','Webhook text is invalid.');text=message.text.body;}
          else if(['image','video','audio','document','sticker'].includes(type)) {const source=message[type] || {};media={id:boundedText(source.id,300),mimeType:boundedText(source.mime_type,120),filename:boundedText(source.filename,300),caption:boundedText(source.caption,1024)};text=media.caption;}
          else if(type==='button') text=boundedText(message.button?.text,1024);
          else if(type==='interactive') text=boundedText(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title,1024);
          else text=`[${type} message. Open WhatsApp Business to view this content.]`;
          incoming.push({id:message.id,number,receivedAt,type,text,media,profileName:boundedText(contact?.profile?.name,300),context:messageId(message.context?.id) ? message.context.id : null});
        }
        for(const status of value.statuses || []) {
          if(!['sent','delivered','read','failed'].includes(status.status)) continue;
          if(!messageId(status.id)) throw fail(400,'WHATSAPP_WEBHOOK_INVALID','Webhook status ID is invalid.');
          const code=Number(status.errors?.[0]?.code);
          statuses.push({messageId:status.id,number:numberFor(status.recipient_id),status:status.status,occurredAt:stamp(status.timestamp),errorCode:Number.isSafeInteger(code) && code>=0 ? code : null});
        }
      }
    }
    if(!matched) throw fail(403,'WHATSAPP_WEBHOOK_ACCOUNT_MISMATCH','The webhook does not belong to this WhatsApp business phone.');
    let inserted=0,statusCount=0;
    tx(()=>{
      for(const message of incoming) {
        const result=db.prepare('INSERT OR IGNORE INTO whatsapp_inbox_messages(id,account_key,number,profile_name,type,text,media_json,context_message_id,received_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(message.id,key,message.number,message.profileName,message.type,message.text,message.media ? JSON.stringify(message.media) : null,message.context,message.receivedAt,now());
        if(!result.changes) continue;inserted++;
        const leads=matchingLeads(message.number);
        if(optOut(message.text)) {
          db.prepare('INSERT INTO whatsapp_suppressions(number,reason,updated_at) VALUES(?,?,?) ON CONFLICT(number) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at').run(message.number,'Recipient opted out in an authenticated WhatsApp message.',now());
          db.prepare('UPDATE whatsapp_consents SET opted_in=0,revision=?,updated_at=? WHERE number=?').run(crypto.randomUUID(),now(),message.number);
          db.prepare("UPDATE whatsapp_outbox SET status='cancelled',error_code='WHATSAPP_PERMISSION_REVOKED',error_message='Recipient opted out in WhatsApp.',updated_at=? WHERE number=? AND status='queued'").run(now(),message.number);
        }
        if(leads.length===1) recordActivityFn(leads[0].place_id,{kind:'reply',channel:'whatsapp',message:message.text,idempotencyKey:`wa-in:${digest(message.id)}`},{transaction:false});
      }
      for(const status of statuses) {
        const id=digest(JSON.stringify([key,status.messageId,status.number,status.status,status.occurredAt,status.errorCode]));
        statusCount+=Number(db.prepare('INSERT OR IGNORE INTO whatsapp_delivery_events(id,account_key,message_id,number,status,occurred_at,error_code,received_at) VALUES(?,?,?,?,?,?,?,?)').run(id,key,status.messageId,status.number,status.status,status.occurredAt,status.errorCode,now()).changes);
        applyDeliveryStatus(status.messageId);
      }
      db.prepare('INSERT INTO whatsapp_webhook_events(id,account_key,received_at) VALUES(?,?,?)').run(eventId,key,now());
    });
    return {duplicate:false,messages:inserted,statuses:statusCount};
  }
  function replyWindow(number) {
    number=numberFor(number);const latest=db.prepare('SELECT MAX(received_at) last FROM whatsapp_inbox_messages WHERE account_key=? AND number=?').get(accountKey(),number)?.last;
    const ends=latest ? latest+86400000 : null;
    const suppressed=!!db.prepare('SELECT 1 FROM whatsapp_suppressions WHERE number=?').get(number);
    return {canReply:!!ends && now()<ends && !suppressed,replyWindowEndsAt:ends};
  }
  function assertReplyAllowed({number,inReplyTo,notBefore}) {
    number=numberFor(number);
    const original=db.prepare('SELECT * FROM whatsapp_inbox_messages WHERE id=? AND account_key=? AND number=?').get(String(inReplyTo || ''),accountKey(),number);
    if(!original) throw fail(409,'WHATSAPP_REPLY_CONTEXT_REQUIRED','Choose an authentic incoming message from this conversation.');
    const window=replyWindow(number);
    if(!window.canReply || (notBefore && notBefore>=window.replyWindowEndsAt)) throw fail(409,'WHATSAPP_REPLY_WINDOW_CLOSED','A text reply is available only within 24 hours of this person’s latest incoming message. Use an approved template outside that window.');
    return window;
  }
  function listThreads() {
    const rows=db.prepare('SELECT * FROM whatsapp_inbox_messages WHERE account_key=? ORDER BY received_at DESC,created_at DESC').all(accountKey());
    const threads=new Map();
    for(const row of rows) if(!threads.has(row.number)) {
      const leads=matchingLeads(row.number),lead=leads.length===1 ? leads[0] : null;
      const window=replyWindow(row.number);
      threads.set(row.number,{number:row.number,placeId:lead?.place_id || null,businessName:lead?.name || null,matchingPlaceIds:leads.map((l)=>l.place_id),profileName:row.profile_name,lastMessageId:row.id,lastMessageAt:row.received_at,lastText:row.text,lastType:row.type,...window,canReply:window.canReply && !leads.some((item)=>item.lead_status==='not_interested')});
      if(threads.size>=200) break;
    }
    return {rows:[...threads.values()],...getStatus()};
  }
  function listMessages({number}={}) {
    number=numberFor(number);const leads=matchingLeads(number),lead=leads.length===1 ? leads[0] : null;
    const rows=db.prepare('SELECT * FROM whatsapp_inbox_messages WHERE account_key=? AND number=? ORDER BY received_at DESC,created_at DESC LIMIT 200').all(accountKey(),number).reverse().map((row)=>({id:row.id,number:row.number,profileName:row.profile_name,type:row.type,text:row.text,media:json(row.media_json),inReplyTo:row.context_message_id,receivedAt:row.received_at,direction:'inbound',placeId:lead?.place_id || null}));
    return {rows,placeId:lead?.place_id || null,...replyWindow(number)};
  }
  return {getStatus,saveConfiguration,clearConfiguration,verifyWebhookChallenge,ingestVerifiedWebhook,applyDeliveryStatus,replyWindow,assertReplyAllowed,listThreads,listMessages};
}
