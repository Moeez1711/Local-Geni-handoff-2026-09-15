import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
process.env.DB_PATH = ':memory:';
process.env.EMAIL_KEY_PATH = '/never-write-whatsapp-test-key';
const { db } = await import('./db.js');
const { createWhatsAppService, normalizeWhatsAppTemplate, renderWhatsAppTemplate } = await import('./whatsappService.js');
const { createWhatsAppRouter } = await import('./routes/whatsapp.js');
const { getPreview } = await import('./previewRepo.js');
const { trashLeads, updateLead } = await import('./repo.js');
const { config } = await import('./config.js');
const { default:previewsRouter } = await import('./routes/previews.js');
const TOKEN = 'private-meta-token-must-never-be-returned';
const accountInput = { phoneNumberId:'123456789012345',businessAccountId:'987654321098765',accessToken:TOKEN };
const rawTemplate = () => ({ id:'111222333444555',name:'website_design',language:'en_US',category:'MARKETING',status:'APPROVED',parameter_format:'POSITIONAL',components:[
  { type:'HEADER',format:'TEXT',text:'For {{1}}' },
  { type:'BODY',text:'Hi {{1}}, here is the design: {{2}}' },
  { type:'FOOTER',text:'Reply STOP to opt out.' },
  { type:'BUTTONS',buttons:[{ type:'URL',text:'View design',url:'https://design.agency/view/{{1}}' },{ type:'PHONE_NUMBER',text:'Call us',phone_number:'+14165550999' }] }
] });
let sequence = 0;
const services = [];
function seed(number = '+14165550123') {
  const id = `wa-cloud-${++sequence}`;
  db.prepare('INSERT INTO businesses(place_id,name,phone_e164,first_seen,last_seen) VALUES(?,?,?,?,?)').run(id,`Café ${sequence}`,number,1,1);
  return id;
}
function fixture({ fetchOverride, activity } = {}) {
  let time = 1800000000000;
  const calls = [], templates = [rawTemplate()];
  const fakeFetch = async (url,options) => {
    calls.push({ url,options });
    if (fetchOverride) { const override = await fetchOverride(url,options,calls); if (override) return override; }
    const path = new URL(url).pathname;
    if (path.endsWith('/phone_numbers')) return Response.json({data:[{id:accountInput.phoneNumberId,display_phone_number:'+1 416 555 0900',verified_name:'Local Geni QA',quality_rating:'GREEN',code_verification_status:'VERIFIED'}]});
    if (path.endsWith('/message_templates')) return Response.json({data:templates});
    if (path.endsWith('/messages')) return Response.json({messages:[{id:`wamid.qa_${calls.length}`} ]});
    throw new Error(`Unexpected fake endpoint: ${path}`);
  };
  const service = createWhatsAppService({ fetchFn:fakeFetch,now:() => time,keyProvider:() => Buffer.alloc(32,7),...(activity ? {recordActivityFn:activity} : {}) });
  services.push(service);
  return {service,calls,templates,advance:(ms) => { time += ms; },posts:() => calls.filter((c) => c.options.method === 'POST')};
}
async function connect(f) { f.service.saveSettings(accountInput); await f.service.verifyConnection(); }
function permission(f,placeId,number = '+14165550123') { return f.service.saveConsent(placeId,{number,optedIn:true,evidence:'Recipient requested WhatsApp design offers on our form, 2026-09-12.',confirmed:true}); }
function recipient(placeId) { return {placeId,parameters:{'header.1':'Café & Co','body.1':'José','body.2':'https://design.agency/view/cafe?device=mobile&ref=local','button.0':'cafe?device=mobile&ref=local'}}; }
async function review(f,placeIds) { return f.service.prepareBatch({templateId:rawTemplate().id,recipients:placeIds.map(recipient)}); }
function send(f,prepared,key = `submission-${++sequence}`) { return f.service.sendBatch({...prepared,idempotencyKey:key,confirmed:true}); }
test.beforeEach(() => {
  for (const table of ['whatsapp_outbox','whatsapp_batches','whatsapp_reviews','whatsapp_templates','whatsapp_consent_events','whatsapp_consents','whatsapp_suppressions','whatsapp_account']) db.prepare(`DELETE FROM ${table}`).run();
});
test.afterEach(() => { for (const service of services.splice(0)) service.stopWorker(); });

test('credentials encrypted and masked, verify is read-only and pins the WABA phone identity',async () => {
  const f = fixture(); const saved = f.service.saveSettings(accountInput);
  assert.equal(saved.verified,false); assert.equal(saved.hasToken,true); assert.ok(!JSON.stringify(saved).includes(TOKEN));
  const stored = db.prepare('SELECT * FROM whatsapp_account').get(); assert.ok(!JSON.stringify(stored).includes(TOKEN));
  assert.equal((await f.service.verifyConnection()).verified,true); assert.equal(f.posts().length,0);
  assert.equal(new URL(f.calls[0].url).origin,'https://graph.facebook.com');
  assert.equal(f.calls[0].options.redirect,'error'); assert.equal(f.calls[0].options.headers.Authorization,`Bearer ${TOKEN}`);
  f.service.saveSettings({dailyLimit:30}); assert.equal(f.service.getSettings().hasToken,true);
  f.service.saveSettings({businessAccountId:'999999999999999'}); assert.equal(f.service.getSettings().hasToken,false); assert.equal(f.service.getSettings().verified,false);
  assert.throws(() => f.service.saveSettings({apiVersion:'v26.0/../../me'}),e => e.code === 'WHATSAPP_INPUT_INVALID');
});

test('verify rejects another account phone and stale in-flight settings never become verified',async () => {
  let release; const deferred = new Promise((r) => {release=r;});
  const f = fixture({fetchOverride:async (url) => url.includes('/phone_numbers') ? deferred : null});
  f.service.saveSettings(accountInput); const pending = f.service.verifyConnection();
  f.service.saveSettings({phoneNumberId:'999999999999999'});
  release(Response.json({data:[{id:accountInput.phoneNumberId,code_verification_status:'VERIFIED',display_phone_number:'+14165550900'}]}));
  await assert.rejects(pending,e => e.code === 'WHATSAPP_ACCOUNT_CHANGED'); assert.equal(f.service.getSettings().verified,false);
  const g = fixture({fetchOverride:async (url) => url.includes('/phone_numbers') ? Response.json({data:[{id:'different'}]}) : null});
  g.service.saveSettings(accountInput); await assert.rejects(g.service.verifyConnection(),e => e.code === 'WHATSAPP_PHONE_NOT_IN_ACCOUNT');
});

test('provider errors redact token and never follow pagination hosts or redirects',async () => {
  const f = fixture({fetchOverride:async () => Response.json({error:{code:190,message:TOKEN}},{status:401})});
  f.service.saveSettings(accountInput);
  await assert.rejects(f.service.verifyConnection(),e => e.code === 'WHATSAPP_PROVIDER_REJECTED' && !e.message.includes(TOKEN));
  let pages = 0;
  const g = fixture({fetchOverride:async (url) => {
    if (!url.includes('/phone_numbers')) return;
    pages++; return pages === 1 ? Response.json({data:[],paging:{next:`https://evil.invalid/steal?token=${TOKEN}`,cursors:{after:'opaque_cursor'}}}) : Response.json({data:[{id:accountInput.phoneNumberId,display_phone_number:'+14165550900',code_verification_status:'VERIFIED'}]});
  }});
  await connect(g); assert.equal(g.calls.length,2); assert.ok(g.calls.every((c) => new URL(c.url).hostname === 'graph.facebook.com' && !c.url.includes(TOKEN)));
  assert.equal(new URL(g.calls[1].url).searchParams.get('after'),'opaque_cursor');
});

test('only approved supported text templates render every component and exact URL parameters',() => {
  const template = normalizeWhatsAppTemplate(rawTemplate()); assert.equal(template.supported,true);
  assert.deepEqual(template.parameters.map((p) => p.key),['header.1','body.1','body.2','button.0']);
  const rendered = renderWhatsAppTemplate(template,recipient('unused').parameters);
  assert.equal(rendered.body,'Hi José, here is the design: https://design.agency/view/cafe?device=mobile&ref=local');
  assert.equal(rendered.buttons[0].url,'https://design.agency/view/cafe?device=mobile&ref=local');
  assert.deepEqual(rendered.components[2],{type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:'cafe?device=mobile&ref=local'}]});
  assert.equal(renderWhatsAppTemplate(template,{...recipient('x').parameters,'button.0':'cafe?literal=$&'}).buttons[0].url,'https://design.agency/view/cafe?literal=$&');
  for (const change of [{category:'AUTHENTICATION'},{parameter_format:'NAMED'},{status:'PAUSED'},{components:[{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'Body'}]},{components:[{type:'BODY',text:'Body'},{type:'CAROUSEL',cards:[]}]}]) assert.equal(normalizeWhatsAppTemplate({...rawTemplate(),...change}).supported,false);
  assert.throws(() => renderWhatsAppTemplate(template,{...recipient('x').parameters,'body.1':'{{businessName}}'}),e => e.code === 'WHATSAPP_PARAMETERS_INVALID');
  assert.throws(() => renderWhatsAppTemplate(template,{...recipient('x').parameters,extra:'ignored?'}),e => e.code === 'WHATSAPP_PARAMETERS_INVALID');
});

test('public phone is not permission; exact opt-in evidence and duplicate/blocked checks are mandatory',async () => {
  const f=fixture(); await connect(f); const a=seed(),b=seed();
  await assert.rejects(review(f,[a]),e => e.code === 'WHATSAPP_OPT_IN_REQUIRED');
  assert.throws(() => f.service.saveConsent(a,{number:'+14165550123',optedIn:true,evidence:'',confirmed:true}),e => e.code === 'WHATSAPP_INPUT_INVALID');
  permission(f,a); permission(f,b);
  await assert.rejects(review(f,[a,b]),e => e.code === 'WHATSAPP_DUPLICATE_RECIPIENT');
  updateLead(a,{lead_status:'not_interested'}); await assert.rejects(review(f,[a]),e => e.code === 'WHATSAPP_RECIPIENT_BLOCKED');
  assert.equal(f.posts().length,0);
});

test('reviewed batch sends exact template once, accepted receipt and contact activity commit together',async () => {
  const f=fixture(); await connect(f); const a=seed(); permission(f,a); const prepared=await review(f,[a]);
  assert.equal(f.posts().length,0); assert.equal(getPreview(a).lead.last_contacted_at,null);
  assert.throws(() => send(f,{...prepared,confirmationDigest:'altered'}),e => e.code === 'WHATSAPP_REVIEW_CHANGED');
  const {batch}=send(f,prepared,'stable-key'); assert.equal(batch.rows[0].status,'queued'); assert.equal(f.posts().length,0);
  const tick=f.service.tick(); await Promise.all([tick,f.service.tick()]);
  const finished=f.service.getBatch(batch.id); assert.equal(finished.rows[0].status,'accepted'); assert.match(finished.rows[0].providerMessageId,/^wamid\./);
  assert.equal(finished.rows[0].tracking,'acceptance_only'); assert.equal(finished.rows[0].deliveredAt,undefined);
  assert.equal(f.posts().length,1); const wire=JSON.parse(f.posts()[0].options.body);
  assert.equal(wire.to,'14165550123'); assert.equal(wire.type,'template'); assert.equal(wire.template.components[1].parameters[1].text,recipient(a).parameters['body.2']);
  assert.equal(getPreview(a).activity[0].message,prepared.messages[0].text); assert.equal(getPreview(a).activity[0].kind,'sent');
  assert.equal(getPreview(a).lead.lead_status,'contacted');
  f.advance(3600000); assert.equal(send(f,prepared,'stable-key').batch.id,batch.id);
  assert.throws(() => send(f,prepared,'different-key'),e => ['WHATSAPP_REVIEW_EXPIRED','WHATSAPP_REVIEW_USED'].includes(e.code));
  assert.equal(f.service.listBatches({idempotencyKey:'stable-key'}).rows[0].id,batch.id);
});

test('expired review and changed number/account/permission cannot send',async () => {
  const f=fixture(); await connect(f); const a=seed(); permission(f,a); const first=await review(f,[a]);
  f.advance(15*60000); assert.throws(() => send(f,first),e => e.code === 'WHATSAPP_REVIEW_EXPIRED');
  const second=await review(f,[a]); db.prepare('UPDATE businesses SET phone_e164=? WHERE place_id=?').run('+14165550124',a);
  assert.throws(() => send(f,second),e => e.code === 'WHATSAPP_LEAD_CHANGED');
  db.prepare('UPDATE businesses SET phone_e164=? WHERE place_id=?').run('+14165550123',a); permission(f,a);
  assert.throws(() => send(f,second),e => e.code === 'WHATSAPP_OPT_IN_REQUIRED');
  const third=await review(f,[a]); f.service.saveSettings({accessToken:'another-private-meta-token-123456'});
  assert.throws(() => send(f,third),e => e.code === 'WHATSAPP_ACCOUNT_CHANGED'); assert.equal(f.posts().length,0);
});

test('template edit between review and transport blocks outgoing submission',async () => {
  const f=fixture(); await connect(f); const a=seed(); permission(f,a); const p=await review(f,[a]); const {batch}=send(f,p);
  f.templates[0].components[1].text='Changed content {{1}} {{2}}'; await f.service.tick();
  assert.equal(f.posts().length,0); const row=f.service.getBatch(batch.id).rows[0]; assert.equal(row.status,'failed'); assert.equal(row.errorCode,'WHATSAPP_TEMPLATE_CHANGED'); assert.equal(getPreview(a).lead.last_contacted_at,null);
});

test('late opt-out during template refresh blocks transport and pending recipients remain cancelled',async () => {
  let pause=false,release; const gate=new Promise((r) => {release=r;});
  const f=fixture({fetchOverride:async (url) => {if (pause && url.includes('/message_templates')) {await gate; return Response.json({data:[rawTemplate()]});}}});
  await connect(f); const a=seed(); permission(f,a); const {batch}=send(f,await review(f,[a])); pause=true;
  const pending=f.service.tick(); await Promise.resolve();
  f.service.saveConsent(a,{number:'14165550123',optedIn:false,evidence:'Recipient asked to stop.',confirmed:true}); release(); await pending;
  assert.equal(f.posts().length,0); assert.equal(f.service.getBatch(batch.id).rows[0].status,'cancelled');
  assert.equal(f.service.listSuppressions().rows[0].number,'14165550123');
});

test('deleting and restoring before worker tick never revives queued WhatsApp messages',async () => {
  const f=fixture(); await connect(f); const a=seed(); permission(f,a); const {batch}=send(f,await review(f,[a]));
  trashLeads([a]); trashLeads([a],true); await f.service.tick();
  assert.equal(f.posts().length,0); assert.equal(f.service.getBatch(batch.id).rows[0].status,'cancelled');
  assert.equal(f.service.getBatch(batch.id).rows[0].errorCode,'WHATSAPP_LEAD_DELETED');
});

test('limits pace a durable batch, cancellation stops the remainder, pause requires explicit resume',async () => {
  const f=fixture(); await connect(f); const a=seed(),b=seed('+14165550124'); permission(f,a); permission(f,b,'+14165550124');
  const {batch}=send(f,await review(f,[a,b])); await f.service.tick(); await f.service.tick(); assert.equal(f.posts().length,1);
  assert.equal(f.service.getBatch(batch.id).nextAttemptAt,1800000120000);
  f.service.saveSettings({paused:true}); f.advance(120000); await f.service.tick(); assert.equal(f.posts().length,1);
  f.service.saveSettings({paused:false}); await f.service.tick(); assert.equal(f.posts().length,1);
  f.service.resumeBatch(batch.id,{confirmed:true}); await f.service.tick(); assert.equal(f.posts().length,2);
  const c=seed('+14165550125'); permission(f,c,'+14165550125'); const other=send(f,await review(f,[c]));
  f.service.cancelBatch(other.batch.id); f.advance(120000); await f.service.tick(); assert.equal(f.posts().length,2);
  assert.equal(f.service.getBatch(other.batch.id).rows[0].status,'cancelled');
});

test('timeouts, 5xx and malformed receipts are unknown; definite rejection fails without contact',async () => {
  for (const [kind,status] of [['timeout','unknown'],['server','unknown'],['receipt','unknown'],['rejected','failed']]) {
    for (const table of ['whatsapp_outbox','whatsapp_batches','whatsapp_reviews']) db.prepare(`DELETE FROM ${table}`).run();
    const f=fixture({fetchOverride:async (url,options) => {
      if (options.method !== 'POST') return;
      if (kind==='timeout') throw new Error(`ECONNECTION ${TOKEN}`);
      if (kind==='server') return Response.json({error:{message:TOKEN}},{status:503});
      if (kind==='rejected') return Response.json({error:{code:131026,message:TOKEN}},{status:400});
      return Response.json({messages:[]});
    }});
    await connect(f); const a=seed(); permission(f,a); const p=await review(f,[a]); const {batch}=send(f,p,`outcome-${kind}`); await f.service.tick(); await f.service.tick();
    const row=f.service.getBatch(batch.id).rows[0]; assert.equal(row.status,status); assert.ok(!JSON.stringify(row).includes(TOKEN));
    assert.equal(getPreview(a).lead.last_contacted_at,null); assert.equal(getPreview(a).activity.length,0);
    send(f,p,`outcome-${kind}`); await f.service.tick(); assert.equal(f.posts().length,1);
  }
});

test('history/contact transaction rolls back on activity failure and leaves an unknown outcome',async () => {
  const f=fixture({activity:() => {throw new Error(TOKEN);}}); await connect(f); const a=seed(); permission(f,a); const {batch}=send(f,await review(f,[a])); await f.service.tick();
  const row=f.service.getBatch(batch.id).rows[0]; assert.equal(row.status,'unknown'); assert.equal(row.providerMessageId,null); assert.equal(getPreview(a).lead.last_contacted_at,null); assert.ok(!row.error.includes(TOKEN));
});

test('new review tokens cannot duplicate an outstanding or uncertain template submission',async () => {
  const f=fixture({fetchOverride:async (url,options) => {if(options.method==='POST') throw new Error('Connection closed after submission.');}});
  await connect(f); const a=seed(); permission(f,a);
  const first=await review(f,[a]),second=await review(f,[a]); send(f,first,'first-attempt');
  assert.throws(() => send(f,second,'second-attempt'),e => e.code === 'WHATSAPP_DUPLICATE_SUBMISSION');
  await f.service.tick(); await assert.rejects(review(f,[a]),e => e.code === 'WHATSAPP_DUPLICATE_SUBMISSION');
  assert.equal(f.posts().length,1);
});

test('an opt-out received during an already submitted request preserves its truthful accepted history',async () => {
  let started,release;
  const entered=new Promise((r) => {started=r;}); const response=new Promise((r) => {release=r;});
  const f=fixture({fetchOverride:async (url,options) => {if(options.method==='POST') {started(); return response;}}});
  await connect(f); const a=seed(); permission(f,a); const {batch}=send(f,await review(f,[a]));
  const pending=f.service.tick(); await entered;
  assert.throws(() => trashLeads([a]),e => e.status===409);
  f.service.saveConsent(a,{number:'14165550123',optedIn:false,evidence:'Recipient opted out while submission was in flight.',confirmed:true});
  release(Response.json({messages:[{id:'wamid.accepted_before_revocation'}]})); await pending;
  assert.equal(f.service.getBatch(batch.id).rows[0].status,'accepted'); assert.equal(getPreview(a).activity[0].kind,'sent');
  await assert.rejects(review(f,[a]),e => e.code==='WHATSAPP_RECIPIENT_BLOCKED');
});

test('crash recovery converts in-flight outcome to unknown and pauses other queued messages',async () => {
  const f=fixture(); await connect(f); const a=seed(),b=seed('+14165550124'); permission(f,a); permission(f,b,'+14165550124');
  const {batch}=send(f,await review(f,[a,b])); db.prepare("UPDATE whatsapp_outbox SET status='sending' WHERE id=?").run(batch.rows[0].id);
  const restarted=fixture(); restarted.service.recoverInterrupted();
  const result=restarted.service.getBatch(batch.id); assert.equal(result.status,'paused'); assert.equal(result.counts.unknown,1); assert.equal(result.counts.queued,1);
  await restarted.service.tick(); assert.equal(restarted.posts().length,0);
});

test('actual router enforces local origin, secret masking, explicit review confirmation and reconciliation',async (t) => {
  const f=fixture(); const app=express(); app.use(express.json()); app.use('/api/whatsapp',createWhatsAppRouter(f.service)); app.use('/api/previews',previewsRouter);
  app.use((error,req,res,next) => res.status(error.status || 500).json({error:error.message}));
  const server=http.createServer(app); await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port=server.address().port;
  const call=(path,{method='GET',body,origin=`http://127.0.0.1:${config.port}`}={}) => new Promise((resolve,reject) => {
    const request=http.request({hostname:'127.0.0.1',port,path:path.startsWith('/api/') ? path : `/api/whatsapp${path}`,method,headers:{Host:`127.0.0.1:${config.port}`,Origin:origin,'Content-Type':'application/json'}},(res) => {let data='';res.on('data',(chunk) => {data+=chunk;});res.on('end',() => resolve({status:res.statusCode,body:JSON.parse(data)}));});
    request.on('error',reject);request.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await call('/settings',{origin:'https://evil.invalid'})).status,403);
  const saved=await call('/settings',{method:'PUT',body:accountInput}); assert.equal(saved.status,200); assert.equal(saved.body.accessToken,undefined); assert.ok(!JSON.stringify(saved).includes(TOKEN));
  assert.equal((await call('/verify',{method:'POST'})).body.verified,true);
  const a=seed(); permission(f,a); const prepared=await call('/prepare',{method:'POST',body:{templateId:rawTemplate().id,recipients:[recipient(a)]}});
  const payload={...prepared.body,idempotencyKey:'route-key'};
  assert.equal((await call('/send',{method:'POST',body:payload})).status,400); assert.equal(f.posts().length,0);
  const sent=await call('/send',{method:'POST',body:{...payload,confirmed:true}}); assert.equal(sent.status,202); assert.equal(sent.body.batch.counts.queued,1);
  const found=await call('/batches?idempotencyKey=route-key'); assert.equal(found.body.rows[0].id,sent.body.batch.id);
  await f.service.tick(); const history=await call(`/messages?placeId=${a}`); assert.equal(history.body.rows[0].status,'accepted');
  f.service.saveConsent(a,{number:'14165550123',optedIn:false,evidence:'Recipient opted out.',confirmed:true});
  f.service.disconnect(); // Known number withdrawals still apply with no API account configured.
  for (const kind of ['draft_opened','sent']) {
    const activity=await call(`/api/previews/${a}/activity`,{method:'POST',body:{kind,channel:'whatsapp',message:'Cannot bypass permission through manual mode.',idempotencyKey:`manual-${kind}`}});
    assert.equal(activity.status,409);
  }
  assert.equal(getPreview(a).activity.length,1);
});

test.after(() => db.close());
