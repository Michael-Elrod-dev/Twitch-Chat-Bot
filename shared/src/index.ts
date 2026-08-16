/**
 * Types shared between the server and the desktop app.
 *
 * This package is the contract at the API boundary: anything crossing
 * server -> client is defined once, here, and imported by both sides.
 *
 * It carries exactly one dependency, zod, and that is a deliberate trade. A
 * contract that only described shapes would leave validation to be written
 * separately on each side — which is precisely where a client and server drift
 * apart, silently, until a request that typechecks gets a 400. Defining the
 * schema once means the server validates with the same object the client's
 * types are inferred from.
 */

export * from './api.js';
export * from './health.js';
export * from './events.js';

export * from './contract/common.js';
export * from './contract/resources.js';
export * from './contract/live.js';
