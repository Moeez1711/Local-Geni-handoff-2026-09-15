const encode = new TextEncoder();
const SECURITY = {
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
  'X-Robots-Tag':'noindex, nofollow, noarchive', 'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{...SECURITY,'Content-Type':'application/json'}});
const html = (value,status=200) => new Response(value,{status,headers:{...SECURITY,'Content-Type':'text/html; charset=utf-8'}});
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,body){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Local Geni</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:580px;margin:12vh auto;padding:32px}small{color:#65656c}h1{font-size:32px;letter-spacing:-1px;line-height:1.2}button{font:inherit;background:#0069d2;color:white;border:0;border-radius:10px;padding:12px 22px;cursor:pointer}button:focus-visible{outline:3px solid #111;outline-offset:4px}p{color:#515158}</style></head><body><main><small>Local Geni</small><h1>${escape(title)}</h1>${body}</main></body></html>`;}
async function sameSecret(provided,expected){
  if(!expected||typeof provided!=='string')return false;
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(provided)),crypto.subtle.digest('SHA-256',encode.encode(expected))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let mismatch=0;for(let i=0;i<x.length;i++)mismatch|=x[i]^y[i];return mismatch===0;
}
async function validToken(token,key){
  if(!key||!/^([A-Za-z0-9_-]{32,64})\.([A-Za-z0-9_-]{43})$/.test(token))return false;
  const [id,signature]=token.split('.');
  try{const secret=await crypto.subtle.importKey('raw',encode.encode(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);const bytes=Uint8Array.from(atob(signature.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));return await crypto.subtle.verify('HMAC',secret,bytes,encode.encode(`local-geni-unsubscribe:v1:${id}`));}catch{return false;}
}
async function signingProof(challenge,key){
  const secret=await crypto.subtle.importKey('raw',encode.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=new Uint8Array(await crypto.subtle.sign('HMAC',secret,encode.encode(`local-geni-health:v1:${challenge}`)));
  return btoa(String.fromCharCode(...signed)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function readBody(request,limit){
  const reader=request.body?.getReader();if(!reader)throw Object.assign(new Error('A request body is required.'),{status:400});
  let size=0;const parts=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Object.assign(new Error('The request is too large.'),{status:413});}parts.push(value);}
  const merged=new Uint8Array(size);let offset=0;for(const part of parts){merged.set(part,offset);offset+=part.length;}
  return new TextDecoder().decode(merged);
}
export async function handleRequest(request,env){
  try{
    const url=new URL(request.url),path=url.pathname;
    if(path==='/robots.txt')return new Response('User-agent: *\nDisallow: /',{headers:{...SECURITY,'Content-Type':'text/plain'}});
    if(path==='/')return html(page('Email preferences','<p>Use the unsubscribe link in your email to manage future outreach.</p>'));
    if(path.startsWith('/api/')){
      const authorized=await sameSecret(request.headers.get('authorization'),env.PUBLISH_TOKEN?`Bearer ${env.PUBLISH_TOKEN}`:null);
      if(!authorized)return json({error:'Unauthorized'},401);
      if(path==='/api/health'&&request.method==='GET'){
        if(typeof env.UNSUBSCRIBE_SIGNING_KEY!=='string'||!/^[A-Za-z0-9_-]{32,200}$/.test(env.UNSUBSCRIBE_SIGNING_KEY))return json({error:'The unsubscribe service is not configured.'},503);
        const challenge=url.searchParams.get('challenge');
        if(challenge!==null&&!/^[A-Za-z0-9_-]{43}$/.test(challenge))return json({error:'Invalid connection challenge.'},400);
        await env.DB.prepare('SELECT count(*) AS n FROM unsubscribe_events').first();
        return json({service:'local-geni-public-links',version:1,ready:true,...(challenge?{challenge,signingProof:await signingProof(challenge,env.UNSUBSCRIBE_SIGNING_KEY)}:{})});
      }
      if(path==='/api/optouts'&&request.method==='GET'){
        const after=Number(url.searchParams.get('after')||0);if(!Number.isSafeInteger(after)||after<0)return json({error:'Invalid cursor'},400);
        const result=await env.DB.prepare('SELECT sequence,token_id AS tokenId,occurred_at AS occurredAt FROM unsubscribe_events WHERE sequence>? ORDER BY sequence LIMIT 500').bind(after).all();
        return json({rows:result.results,nextCursor:result.results.at(-1)?.sequence||after,hasMore:result.results.length===500});
      }
      return json({error:'Not found'},404);
    }
    const unsubscribe=path.match(/^\/u\/([A-Za-z0-9_.-]+)$/);
    if(unsubscribe&&await validToken(unsubscribe[1],env.UNSUBSCRIBE_SIGNING_KEY)){
      if(request.method==='GET')return html(page('Stop future emails',`<p>Confirm below to stop future outreach from this sender.</p><form method="post" action="/u/${escape(unsubscribe[1])}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`));
      if(request.method==='POST'){
        if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/x-www-form-urlencoded')return json({error:'Unsupported request'},415);
        const body=await readBody(request,1000);if(new URLSearchParams(body).get('List-Unsubscribe')!=='One-Click')return json({error:'Invalid confirmation'},400);
        await env.DB.prepare('INSERT INTO unsubscribe_events(token_id,occurred_at) VALUES(?,?) ON CONFLICT(token_id) DO NOTHING').bind(unsubscribe[1].split('.')[0],Date.now()).run();
        return html(page('You are unsubscribed','<p>Your request has been recorded. Future outreach from this sender will be blocked.</p>'));
      }
      return json({error:'Method not allowed'},405);
    }
    return html(page('Link not found','<p>Check the link in your email and try again.</p>'),404);
  }catch(error){return json({error:error.status?error.message:'This service is temporarily unavailable. Please try again.'},error.status||503);}
}
