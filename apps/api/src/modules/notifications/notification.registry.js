import { AppError } from '../../common/errors/AppError.js';
import { NOTIFICATION_CHANNELS } from './notification.tokens.js';
import { NOTIFICATION_MATRIX } from './notification.matrix.js';

/**
 * The notification registry. Validates the matrix at construction — no duplicate
 * type, at least one channel, only known channels — so a malformed matrix stops
 * the process from booting. Sole authority on what a type is; an unknown type is
 * a 404, never a silent no-op. Ported from the original.
 */
export class NotificationRegistry {
  constructor(descriptors = NOTIFICATION_MATRIX) {
    const map = new Map();
    for (const d of descriptors) {
      if (map.has(d.type)) throw new Error(`Notification registry: duplicate type "${d.type}".`);
      if (d.channels.length === 0) throw new Error(`Notification registry: "${d.type}" declares no channels.`);
      for (const channel of d.channels) {
        if (!NOTIFICATION_CHANNELS.includes(channel)) {
          throw new Error(`Notification registry: "${d.type}" declares unknown channel "${channel}".`);
        }
      }
      map.set(d.type, d);
    }
    this.byType = map;
  }
  has(type) { return this.byType.has(type); }
  list() { return [...this.byType.values()]; }
  require(type) {
    const d = this.byType.get(type);
    if (d === undefined) throw new AppError('NOT_FOUND', { status: 404, message: `Unknown notification type "${type}".` });
    return d;
  }
}
