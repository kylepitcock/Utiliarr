import path from 'node:path';

export const env = {
  port: Number(process.env.PORT ?? 8080),
  dataDir: process.env.DATA_DIR ?? path.resolve('data'),
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  secureCookie: process.env.COOKIE_SECURE === 'true',
};
