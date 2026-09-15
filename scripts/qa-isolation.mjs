/** Loaded only in the QA child and its test workers, never the application runtime. */
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.LOCAL_GENI_QA_ISOLATED === '1') {
  const ports = new Set();
  const loopback = (host) => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
  const blocked = () => Object.assign(new Error('QA isolation blocked external or unowned network access.'), { code: 'QA_NETWORK_BLOCKED' });
  const argsFor = (args) => Array.isArray(args[0]) ? args[0] : args;
  const addressFor = (args) => {
    args = argsFor(args);
    if (args[0] && typeof args[0] === 'object') return { host: args[0].host, port: Number(args[0].port), path: args[0].path };
    return { port: Number(args[0]), host: typeof args[1] === 'string' ? args[1] : undefined, path: typeof args[0] === 'string' && !/^\d+$/.test(args[0]) ? args[0] : null };
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const address = addressFor(args);
    // Tests may create only their own ephemeral loopback servers.
    if (address.path || !loopback(address.host) || address.port !== 0) throw blocked();
    let port;
    this.once('listening', () => { port = this.address()?.port; if (port) ports.add(port); });
    this.once('close', () => { if (port) ports.delete(port); });
    return listen.apply(this, args);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const address = addressFor(args);
    if (address.path || !loopback(address.host || 'localhost') || !ports.has(address.port)) throw blocked();
    return connect.apply(this, args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { throw blocked(); }
    if (url.protocol !== 'http:' || !loopback(url.hostname) || !ports.has(Number(url.port)) || url.username || url.password) throw blocked();
    return originalFetch(input, { ...options, redirect: 'error' });
  };
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'resolveCname', 'resolveNs', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'reverse']) {
    if (typeof dns[name] === 'function') {
      const original = dns[name];
      dns[name] = function (host, ...args) {
        if (name === 'lookup' && loopback(host)) return original.call(this, host, ...args);
        const callback = args.at(-1); if (typeof callback === 'function') { queueMicrotask(() => callback(blocked())); return; }
        throw blocked();
      };
    }
    if (typeof dns.promises[name] === 'function') {
      const original = dns.promises[name];
      dns.promises[name] = async function (host, ...args) {
        if (name === 'lookup' && loopback(host)) return original.call(this, host, ...args);
        throw blocked();
      };
    }
  }
  // Provider libraries sometimes construct their own resolver rather than use dns.resolve*.
  for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
    for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'resolveCname', 'resolveNs', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'reverse']) {
      if (typeof Resolver?.prototype[name] !== 'function') continue;
      Resolver.prototype[name] = Resolver === dns.promises.Resolver ? async () => { throw blocked(); } : function (...args) {
        const callback = args.at(-1); if (typeof callback === 'function') { queueMicrotask(() => callback(blocked())); return; } throw blocked();
      };
    }
  }
  dgram.Socket.prototype.send = function () { throw blocked(); };
  dgram.Socket.prototype.connect = function () { throw blocked(); };
  syncBuiltinESMExports();
}
