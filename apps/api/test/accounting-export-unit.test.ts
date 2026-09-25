import { ACCOUNT_SLOTS, chartFrom, type Journal } from '@domar/domain';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildAccountingExport, money, type AccountingExportMeta } from '../src/resources/accounting/export.js';

/**
 * Unit tests against `buildAccountingExport`/`money` directly — a pure function, so a hand-built
 * `Journal`/`Chart` fixture exercises it far more directly than round-tripping through the app and a
 * real ledger (`accounting-export.test.ts` covers that end-to-end path). Fix round 1, item 9: none of
 * this executed before — no adjustment fixture, no assertion on the printed chart, no direct test of
 * `money()`.
 */

const chart = chartFrom(ACCOUNT_SLOTS.map((slot, i) => ({ slot, code: String(1000 + i), name: `Сметка ${slot}`, isActive: true })));

const line = (code: string, name: string, debitMinor: number, creditMinor: number) => ({ code, name, debitMinor, creditMinor, description: 'опис' });

const journal: Journal = {
  entries: [
    {
      no: 1, date: '2026-01-05', period: '2026-01', buildingName: 'Зграда 1', counterparty: 'Пера Перески',
      sourceType: 'invoice', sourceId: 'i1', closedPeriod: false,
      lines: [line('1200', 'Побарувања', 10000, 0), line('7400', 'Приходи', 0, 10000)],
    },
  ],
  adjustments: [
    {
      no: 2, date: '2025-12-20', period: '2025-12', buildingName: 'Зграда 1', counterparty: 'Пера Перески',
      sourceType: 'expense', sourceId: 'e1', closedPeriod: true,
      lines: [line('1000', 'Редовна сметка', 5000, 0), line('4000', 'Трошоци', 0, 5000)],
    },
  ],
  trialBalance: [
    { code: '1000', name: 'Редовна сметка', debitMinor: 5000, creditMinor: 0, differenceMinor: 5000 },
    { code: '1200', name: 'Побарувања', debitMinor: 10000, creditMinor: 0, differenceMinor: 10000 },
    { code: '4000', name: 'Трошоци', debitMinor: 0, creditMinor: 5000, differenceMinor: -5000 },
    { code: '7400', name: 'Приходи', debitMinor: 0, creditMinor: 10000, differenceMinor: -10000 },
  ],
  totals: { debitMinor: 15000, creditMinor: 15000, entryCount: 2, lineCount: 4 },
  closedPeriods: ['2025-12'],
};

const meta: AccountingExportMeta = {
  tenantName: 'Тест организација', buildingName: 'Зграда 1', from: '2026-01-01', to: '2026-02-01',
  createdAt: new Date('2026-01-10T23:30:00.000Z'), chart, timeZone: 'Europe/Skopje',
};

describe('money()', () => {
  it('renders minor units as a comma decimal with dot thousands, no float path', () => {
    expect(money(0)).toBe('0,00');
    expect(money(1)).toBe('0,01');
    expect(money(100)).toBe('1,00');
    expect(money(150)).toBe('1,50');
    expect(money(-150)).toBe('-1,50');
    expect(money(99)).toBe('0,99');
    expect(money(1000000)).toBe('10.000,00');
    expect(money(100000000)).toBe('1.000.000,00');
  });
});

describe('buildAccountingExport', () => {
  it('separates the journal count from the adjustments count, each matching its own file', () => {
    const files = unzipSync(new Uint8Array(buildAccountingExport(journal, meta)));
    const readme = strFromU8(files['README.txt']!);
    expect(readme).toContain('Ставки: 1');
    expect(readme).toContain('Редови: 2');
    expect(readme).toContain('Корекции од претходни периоди: 1');
    expect(readme).toContain('Редови на корекции: 2');
  });

  it('prints the chart it used, slot by slot', () => {
    const files = unzipSync(new Uint8Array(buildAccountingExport(journal, meta)));
    const readme = strFromU8(files['README.txt']!);
    for (const slot of ACCOUNT_SLOTS) expect(readme).toContain(`${slot}: ${chart[slot].code} — ${chart[slot].name}`);
  });

  it('prints "Изготвено" as the tenant\'s civil day, like every other date in the file', () => {
    const files = unzipSync(new Uint8Array(buildAccountingExport(journal, meta)));
    const readme = strFromU8(files['README.txt']!);
    // 23:30 UTC on 2026-01-10 is already 2026-01-11 in Europe/Skopje (UTC+1) — a bare `.toISOString()`
    // would have printed the wrong day.
    expect(readme).toContain('Изготвено: 2026-01-11');
  });

  it('writes an adjustment into korekcii.csv, with the closed-period column the journal computed', () => {
    const files = unzipSync(new Uint8Array(buildAccountingExport(journal, meta)));
    expect(files['korekcii.csv']).toBeDefined();
    const [header, ...lines] = strFromU8(files['korekcii.csv']!.subarray(3)).trim().split('\n');
    expect(header).toBe('ставка;датум;период;конто;назив;должи;побарува;опис;зграда;партнер;извор;извор-ид;затворен-период');
    expect(lines.every((l) => l.endsWith(';да'))).toBe(true);
  });

  it('omits korekcii.csv when there are no adjustments', () => {
    const noAdjustments: Journal = { ...journal, adjustments: [] };
    const files = unzipSync(new Uint8Array(buildAccountingExport(noAdjustments, meta)));
    expect(files['korekcii.csv']).toBeUndefined();
  });

  it('is byte-identical across two builds of the same journal (spec: reproducible output)', () => {
    // Same journal, same meta, but not the same object references — a real second run of the same
    // window would rebuild both from scratch, so identity-sharing them here would prove less.
    const again: Journal = JSON.parse(JSON.stringify(journal)) as Journal;
    const metaAgain: AccountingExportMeta = { ...meta, chart: { ...chart }, createdAt: new Date(meta.createdAt.getTime()) };
    const first = buildAccountingExport(journal, meta);
    const second = buildAccountingExport(again, metaAgain);
    expect(first.equals(second)).toBe(true);
  });
});
