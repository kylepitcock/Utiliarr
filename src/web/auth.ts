import crypto from 'node:crypto';
import { kvGet, kvSet } from '../db.js';

export const MIN_PASSWORD = 8;

function sessionSecret() {
  let s = kvGet('session_secret');
  if (!s) kvSet('session_secret', (s = crypto.randomBytes(32).toString('hex')));
  return s;
}
export const sign = (v: string) => crypto.createHmac('sha256', sessionSecret()).update(v).digest('base64url');
export const safeEq = (a: string, b: string) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

export const hasPassword = () => !!kvGet('admin_hash');

export function setPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  kvSet('admin_hash', `${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64).toString('base64')}`);
  // new secret invalidates every existing session
  kvSet('session_secret', crypto.randomBytes(32).toString('hex'));
}

export function checkPassword(pw: string) {
  const [salt, hash] = (kvGet('admin_hash') ?? '').split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'base64'));
}
