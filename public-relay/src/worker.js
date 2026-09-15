import { env } from 'cloudflare:workers';
import { handleRequest } from './relay.js';
export default { fetch: (request) => handleRequest(request,env) };
