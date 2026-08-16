/**
 * Types shared between the server and the desktop app.
 *
 * This package is the contract at the API boundary: anything crossing
 * server -> client is defined once, here, and imported by both sides. It stays
 * deliberately dependency-free so the client can consume it without pulling
 * server concerns along.
 */

export * from './api.js';
export * from './health.js';
