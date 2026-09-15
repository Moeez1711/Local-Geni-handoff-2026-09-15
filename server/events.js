import { EventEmitter } from 'node:events';

// In-process event bus; SSE clients subscribe to it.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const emit = (type, data) => bus.emit('event', { type, data, ts: Date.now() });
