import crypto from 'node:crypto';
const json = (value, fallback = {}) => { try { return JSON.parse(value) || fallback; } catch { return fallback; } };

export function createPublicPublishingCore({db,getSecret,setSecret,normalizeEmail,emailError,addSuppression,fetchFn=fetch,now=Date.now}={}){
  db.exec(`CREATE TABLE IF NOT EXISTS publishing_config(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS publishing_tokens(token_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,email TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,email));
    CREATE TABLE IF NOT EXISTS publishing_sync(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL DEFAULT 0,synced_at INTEGER);`);
  const read=()=>json(db.prepare('SELECT config FROM publishing_config WHERE id=1').get()?.config,{});
  const secrets=()=>getSecret('public-publishing');
  const fail=(code,message,status=409)=>emailError(status,code,message);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  function status(){const c=read();return{configured:Boolean(c.origin&&c.verifiedAt),origin:c.origin||'',verifiedAt:c.verifiedAt||null,lastSyncAt:db.prepare('SELECT synced_at FROM publishing_sync WHERE id=1').get()?.synced_at||null};}
  function cleanOrigin(value){let u;try{u=new URL(value);}catch{throw fail('INVALID_PUBLISHING_URL','Enter a public HTTPS address.',400);}
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!/^([a-z0-9-]+\.)+[a-z]{2,63}$/i.test(u.hostname)||/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(u.hostname))throw fail('INVALID_PUBLISHING_URL','Use a public HTTPS origin without a path.',400);return u.origin;
  }
  async function request(path,{method='GET',body,config=read(),credentials=secrets()}={}){
    if(!config.origin||!credentials?.apiToken)throw fail('PUBLISHING_NOT_CONFIGURED','Email preferences are not connected. Complete Unsubscribe setup first.');
    try{
      const r=await fetchFn(`${config.origin}${path}`,{method,headers:{Authorization:`Bearer ${credentials.apiToken}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();
    }catch{throw fail('PUBLISHING_UNAVAILABLE','Email preferences could not be reached. Your local work is saved. Check the connection and try again.',502);}
  }
  async function checkConnection(config,credentials){
    const challenge=crypto.randomBytes(32).toString('base64url');
    const health=await request(`/api/health?challenge=${challenge}`,{config,credentials});
    if(!object(health)||health.service!=='local-geni-public-links'||health.version!==1||health.ready!==true||health.challenge!==challenge||typeof health.signingProof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(health.signingProof))throw fail('INVALID_PUBLISHING_SERVICE','This address does not point to a ready Local Geni unsubscribe service.');
    const expected=crypto.createHmac('sha256',credentials.signingKey).update(`local-geni-health:v1:${challenge}`).digest();
    const actual=Buffer.from(health.signingProof,'base64url');
    if(actual.length!==expected.length||actual.toString('base64url')!==health.signingProof||!crypto.timingSafeEqual(actual,expected))throw fail('INVALID_PUBLISHING_KEY','The unsubscribe key does not match the unsubscribe service. Check both keys and reconnect.');
  }
  let configuring=false;
  async function configure(body={}){
    if(!object(body))throw fail('INVALID_PUBLISHING_CONFIG','Use valid unsubscribe settings.',400);
    if(configuring)throw fail('PUBLISHING_BUSY','A connection check is already running. Wait for it to finish.');
    configuring=true;
    try{
    const origin=cleanOrigin(body.origin||read().origin||'');const previous=secrets()||{};
    const credentials={apiToken:body.apiToken||previous.apiToken,signingKey:body.signingKey||previous.signingKey};
    for(const key of ['apiToken','signingKey'])if(typeof credentials[key]!=='string'||!/^[A-Za-z0-9_-]{32,200}$/.test(credentials[key]))throw fail('INVALID_PUBLISHING_KEY','Enter the connection and unsubscribe keys from your hosting service.',400);
    if(read().origin&&read().origin!==origin&&db.prepare('SELECT 1 FROM publishing_tokens LIMIT 1').get())throw fail('PUBLISHING_IN_USE','Keep the current unsubscribe address active because existing unsubscribe links depend on it.');
    if(previous.signingKey&&previous.signingKey!==credentials.signingKey&&db.prepare('SELECT 1 FROM publishing_tokens LIMIT 1').get())throw fail('PUBLISHING_IN_USE','Existing unsubscribe links require the current signing key.');
    await checkConnection({origin},credentials);
    db.exec('BEGIN');try{setSecret('public-publishing',credentials);db.prepare('INSERT INTO publishing_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(JSON.stringify({origin,verifiedAt:now()}));db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    return status();
    }finally{configuring=false;}
  }
  async function verify(){
    if(configuring)throw fail('PUBLISHING_BUSY','A connection check is already running. Wait for it to finish.');
    configuring=true;
    try{
      const c=read(),credentials=secrets();
      if(!c.origin||!credentials?.signingKey)throw fail('PUBLISHING_NOT_CONFIGURED','Email preferences are not connected. Complete Unsubscribe setup first.');
      await checkConnection(c,credentials);c.verifiedAt=now();db.prepare('UPDATE publishing_config SET config=? WHERE id=1').run(JSON.stringify(c));return status();
    }finally{configuring=false;}
  }
  function getUnsubscribeLink({accountId=1,to}={}){
    if(configuring)throw fail('PUBLISHING_BUSY','An unsubscribe connection check is running. Wait for it to finish before preparing an email.');
    if(!status().configured)return null;const key=secrets()?.signingKey;if(!key)throw fail('PUBLISHING_KEY_UNAVAILABLE','Reconnect unsubscribe before sending.');
    const email=normalizeEmail(to),account=String(accountId);let token=db.prepare('SELECT token_id FROM publishing_tokens WHERE account_id=? AND email=?').get(account,email)?.token_id;
    if(!token){token=crypto.randomBytes(32).toString('base64url');db.prepare('INSERT INTO publishing_tokens VALUES(?,?,?,?)').run(token,account,email,now());}
    const signature=crypto.createHmac('sha256',key).update(`local-geni-unsubscribe:v1:${token}`).digest('base64url');return`${read().origin}/u/${token}.${signature}`;
  }
  let syncing=null;
  async function sync(){
    if(!status().configured)return{configured:false,added:0};let cursor=db.prepare('SELECT cursor FROM publishing_sync WHERE id=1').get()?.cursor||0,added=0;
    await checkConnection(read(),secrets());
    for(let page=0;page<100;page++){
      const data=await request(`/api/optouts?after=${cursor}`);if(!object(data)||!Array.isArray(data.rows)||data.rows.length>500)throw fail('INVALID_OPTOUT_RESPONSE','Unsubscribe requests could not be checked. Sending is held until the check succeeds.',502);
      let next=cursor;const rows=[];for(const r of data.rows){if(!object(r)||!Number.isSafeInteger(r.sequence)||r.sequence<=next||typeof r.tokenId!=='string'||!/^[A-Za-z0-9_-]{32,64}$/.test(r.tokenId)||!Number.isSafeInteger(r.occurredAt)||r.occurredAt<=0)throw fail('INVALID_OPTOUT_RESPONSE','Unsubscribe requests could not be checked. Sending is held until the check succeeds.',502);next=r.sequence;rows.push(r);}
      if(data.nextCursor!==next||typeof data.hasMore!=='boolean'||data.hasMore!==(rows.length===500))throw fail('INVALID_OPTOUT_RESPONSE','Unsubscribe requests could not be checked.',502);
      db.exec('BEGIN');try{
        for(const row of rows){const token=db.prepare('SELECT email FROM publishing_tokens WHERE token_id=?').get(row.tokenId);if(token){addSuppression({email:token.email,reason:'opt_out'});added++;}}
        db.prepare('INSERT INTO publishing_sync VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,synced_at=excluded.synced_at').run(next,now());db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      cursor=next;if(!data.hasMore)return{configured:true,added,cursor,syncedAt:now()};
    }
    throw fail('OPTOUT_SYNC_PENDING','More unsubscribe requests are being checked. Sending remains held.');
  }
  function syncPublicOptOuts(){if(!syncing)syncing=sync().finally(()=>{syncing=null;});return syncing;}
  return{getPublishingStatus:status,configure,verify,getUnsubscribeLink,syncPublicOptOuts};
}
