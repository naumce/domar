import { runApply } from './apply.js';
import { DomexaClient } from './client.js';
import { runExport } from './export.js';
import { runTransform } from './transform.js';

const args = process.argv.slice(2);
const command = args[0] ?? '';
/** `--dir --yes` is a missing value, not a directory named `--yes`. */
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
};
const has = (name: string): boolean => args.includes(`--${name}`);
const env = (name: string): string => process.env[name] ?? '';
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

try {
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
  } else if (command === 'transform') {
    await runTransform({
      dir,
      fromPeriod: flag('from') ?? thisMonth(),
      ...(flag('map') ? { mapFile: flag('map')! } : {}),
    });
    console.log(`transform finished in ${dir}/domar/ — read ${dir}/domar/report.md`);
  } else if (command === 'apply') {
    const summary = await runApply({
      dir: `${dir}/domar`,
      baseUrl: env('DOMAR_URL') || 'http://localhost:3001',
      slug: env('DOMAR_SLUG'),
      email: env('DOMAR_EMAIL'),
      password: env('DOMAR_PASSWORD'),
      dryRun: has('dry-run'),
      yes: has('yes'),
      forceSettings: has('force-settings'),
    });
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error('usage: pnpm --filter @domar/api migrate:domexa -- <export|transform|apply> [--dir domexa-export] [--from 2026-09] [--map map.json] [--dry-run] [--yes] [--force-settings]');
    process.exit(1);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
