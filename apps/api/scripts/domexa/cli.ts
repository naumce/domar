import { DomexaClient } from './client.js';
import { runExport } from './export.js';

const args = process.argv.slice(2);
const command = args[0] ?? '';
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = (name: string): string => process.env[name] ?? '';
const dir = flag('dir') ?? 'domexa-export';

if (command === 'export') {
  const client = new DomexaClient({
    baseUrl: env('DOMEXA_BASE_URL') || 'https://domexa.mk',
    org: env('DOMEXA_ORG'),
    ...(env('DOMEXA_EMAIL') ? { email: env('DOMEXA_EMAIL') } : {}),
    ...(env('DOMEXA_PASSWORD') ? { password: env('DOMEXA_PASSWORD') } : {}),
    ...(env('DOMEXA_COOKIE') ? { cookie: env('DOMEXA_COOKIE') } : {}),
  });
  await runExport(client, dir);
  console.log(`export finished in ${dir}/`);
} else {
  console.error('usage: pnpm --filter @domar/api migrate:domexa -- export [--dir domexa-export]');
  process.exit(1);
}
