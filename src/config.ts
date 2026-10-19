import path from 'node:path';

export const env = {
  port: Number(process.env.PORT ?? 5757),
  dataDir: process.env.DATA_DIR ?? path.resolve('data'),
  secureCookie: process.env.COOKIE_SECURE === 'true',
};
