import { db as runtimeDb } from './db.js';
import { getPrivateSecret, setPrivateSecret } from './emailVault.js';
import { addSuppression as suppress, normalizeEmail, emailError } from './emailPolicy.js';
import { createPublicPublishingCore } from './publicPublishingService.js';

export function createPublicPublishingService({db=runtimeDb,getSecret=getPrivateSecret,setSecret=setPrivateSecret,fetchFn=fetch,addSuppression=suppress,now=Date.now}={}) {
  return createPublicPublishingCore({db,getSecret,setSecret,fetchFn,addSuppression,normalizeEmail,emailError,now});
}

const service=createPublicPublishingService();
export const getPublishingStatus=()=>service.getPublishingStatus();
export const configurePublishing=body=>service.configure(body);
export const verifyPublishing=()=>service.verify();
export const getUnsubscribeLink=body=>service.getUnsubscribeLink(body);
export const syncPublicOptOuts=()=>service.syncPublicOptOuts();
