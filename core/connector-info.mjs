export const EXTENSION_ID = 'pnfghekgheamlilmdlapjbhaofgnbcco';
export const HOST_NAME = 'com.notakillite.bridge';
export const PROTOCOL_VERSION = 1;
export const APP_VERSION = '0.6.0';
export class ConnectionError extends Error {
  constructor(code, message) { super(message); this.name = 'ConnectionError'; this.code = code; }
}
