import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * MongoDB connection lifecycle.
 *
 * `strictQuery` on: unknown query fields are rejected rather than silently
 * ignored — a small but real defence against a typo widening a filter.
 */
mongoose.set('strictQuery', true);

let connected = false;

export async function connectDatabase() {
  if (connected) return mongoose.connection;
  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongodb connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'));
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    // socketTimeoutMS bounds an INDIVIDUAL operation once a socket is selected.
    // Without it, an operation the server accepts but never acknowledges — a
    // majority-write that can't reach a secondary, a transaction commit stalling
    // on a shared-tier cluster — waits forever, so POST /scheduling/appointments
    // never responds and the Book-appointment button spins indefinitely. Bounding
    // it turns that stall into a surfaced, retryable error the API returns as a
    // normal response. Generous enough for ordinary CRUD and paginated exports.
    socketTimeoutMS: 45_000,
    maxPoolSize: 20,
  });
  connected = true;
  logger.info('mongodb connected');
  return mongoose.connection;
}

export async function disconnectDatabase() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('mongodb disconnected (clean shutdown)');
}

/**
 * Whether the deployment supports multi-document transactions. Standalone
 * mongod does not; a replica set (or sharded cluster) does. Used to degrade
 * gracefully in local single-node setups while keeping the transactional path
 * in production.
 */
export function supportsTransactions() {
  const topology = mongoose.connection?.client?.topology;
  const desc = topology?.description;
  if (!desc) return false;
  return desc.type === 'ReplicaSetWithPrimary' || desc.type === 'Sharded' || desc.type === 'LoadBalanced';
}

export { mongoose };
