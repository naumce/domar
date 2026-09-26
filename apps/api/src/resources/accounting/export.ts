import { ACCOUNT_SLOTS, csvCell, type Chart, type Journal, type JournalEntry } from '@domar/domain';
import { strToU8, zipSync } from 'fflate';
import { dayIn } from '../common.js';

/** Excel on a Macedonian Windows reads a `;` file as columns only when a BOM says it is UTF-8. */
const BOM = '﻿';

/**
 * Fixed so the same journal produces byte-identical zips (spec's reproducibility requirement, fix
 * round 1 item 3): `zipSync` stamps `Date.now()` into every entry's mod-time when none is given, which
 * made two exports of the same window differ at the header bytes even though every byte of content
 * was identical. The exact value is arbitrary; it only has to be constant and DOS-zip-valid (>= 1980).
 */
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

function csv(header: string[], rows: (string | number)[][]): string {
  const line = (xs: (string | number)[]) => xs.map((x) => csvCell(String(x))).join(';');
  return `${BOM}${[line(header), ...rows.map(line)].join('\n')}\n`;
}

/**
 * Minor units as a decimal with a comma and a thousands dot, which is what a `;` file means in this
 * locale. Integer arithmetic only: the money has been in minor units the whole way here (spec §8).
 */
export function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')}`;
}

export interface AccountingExportMeta {
  tenantName: string;
  buildingName: string | null;
  from: string;
  to: string;
  createdAt: Date;
  /**
   * The chart the derivation actually read, slot by slot. The journal reads the chart live rather
   * than from a snapshot, so re-running an export after a code changed can book the same expenses
   * differently; printing the chart here makes two runs that differ visibly different rather than
   * mysteriously different (controller ruling).
   */
  chart: Chart;
  /** So `createdAt` prints as the civil day it was for the tenant, like every other date in the file
   * (fix round 1, item 8) rather than a bare UTC instant. */
  timeZone: string;
}

/**
 * The counts the file itself prints, and therefore the only ones any screen may show for the same
 * export (fix round 2, item 5). `journal.totals.entryCount`/`lineCount` are `buildJournal`'s combined
 * figures over entries *and* adjustments — right for the trial balance's ВКУПНО row, wrong as a
 * headline beside `Корекции: n`, which would then be counted inside `Ставки: n` as well. `Ставки` and
 * `Редови` mean `dnevnik.csv`'s own rows here, in `README.txt`, in the preview, in the export
 * response and in `accounting_periods.entry_count`.
 */
export function journalCounts(journal: Journal): { entryCount: number; lineCount: number; adjustmentCount: number; adjustmentLineCount: number } {
  return {
    entryCount: journal.entries.length,
    lineCount: journal.entries.reduce((s, e) => s + e.lines.length, 0),
    adjustmentCount: journal.adjustments.length,
    adjustmentLineCount: journal.adjustments.reduce((s, e) => s + e.lines.length, 0),
  };
}

const JOURNAL_HEADER = ['ставка', 'датум', 'период', 'конто', 'назив', 'должи', 'побарува', 'опис', 'зграда', 'партнер', 'извор', 'извор-ид'];

function journalRows(entries: JournalEntry[]): (string | number)[][] {
  return entries.flatMap((e) => e.lines.map((l) => [
    e.no, e.date, e.period, l.code, l.name, money(l.debitMinor), money(l.creditMinor),
    l.description, e.buildingName, e.counterparty, e.sourceType, e.sourceId,
  ]));
}

/**
 * The accountant's zip (spec §6): the journal, the trial balance that proves it balances, the
 * prior-period adjustments when there are any, and a README they can check at a glance.
 */
export function buildAccountingExport(journal: Journal, meta: AccountingExportMeta): Buffer {
  const t = journal.totals;
  // Entries and adjustments counted apart, so each printed number matches the rows of the file next
  // to it (fix round 1, item 1); `t.debitMinor`/`t.creditMinor` stay the whole file's, which is what
  // the trial balance's ВКУПНО row below is.
  const counts = journalCounts(journal);
  const day = dayIn(meta.timeZone);
  const files: Record<string, Uint8Array> = {
    'dnevnik.csv': strToU8(csv(JOURNAL_HEADER, journalRows(journal.entries))),
    'bruto-bilans.csv': strToU8(csv(
      ['конто', 'назив', 'должи', 'побарува', 'разлика'],
      [
        ...journal.trialBalance.map((r) => [r.code, r.name, money(r.debitMinor), money(r.creditMinor), money(r.differenceMinor)]),
        ['ВКУПНО', '', money(t.debitMinor), money(t.creditMinor), money(t.debitMinor - t.creditMinor)],
      ],
    )),
    'README.txt': strToU8([
      `Организација: ${meta.tenantName}`,
      `Зграда: ${meta.buildingName ?? 'сите'}`,
      `Период: ${meta.from} — ${meta.to} (крајот не е вклучен)`,
      // A civil day in the tenant's own zone, like every other date in this file — not a bare UTC
      // instant (fix round 1, item 8).
      `Изготвено: ${day(meta.createdAt)}`,
      `Ставки: ${counts.entryCount}`,
      `Редови: ${counts.lineCount}`,
      `Должи: ${money(t.debitMinor)}`,
      `Побарува: ${money(t.creditMinor)}`,
      `Разлика: ${money(t.debitMinor - t.creditMinor)}`,
      `Корекции од претходни периоди: ${counts.adjustmentCount}`,
      `Редови на корекции: ${counts.adjustmentLineCount}`,
      `Затворени периоди во овој извоз: ${journal.closedPeriods.length ? journal.closedPeriods.join(', ') : 'нема'}`,
      '',
      // Slot by slot, so a chart that changed between two runs of the same window is visible here
      // rather than only in the numbers it silently changed (controller ruling).
      'Контен план (употребен во овој извоз):',
      ...ACCOUNT_SLOTS.map((slot) => `  ${slot}: ${meta.chart[slot].code} — ${meta.chart[slot].name}`),
      '',
      'Датотеките се UTF-8 со BOM и раздвојувач „;“.',
      '',
    ].join('\n')),
  };
  // Present only when there are any, so an empty file never suggests something was missed (spec §6).
  if (journal.adjustments.length > 0) {
    files['korekcii.csv'] = strToU8(csv(
      [...JOURNAL_HEADER, 'затворен-период'],
      journal.adjustments.flatMap((e) => e.lines.map((l) => [
        e.no, e.date, e.period, l.code, l.name, money(l.debitMinor), money(l.creditMinor),
        l.description, e.buildingName, e.counterparty, e.sourceType, e.sourceId, e.closedPeriod ? 'да' : 'не',
      ])),
    ));
  }
  // A fixed `mtime` (fix round 1, item 3): without it `zipSync` stamps `Date.now()` into every entry,
  // so the same journal built twice produces two different zips and this export is not reproducible.
  return Buffer.from(zipSync(files, { level: 6, mtime: FIXED_MTIME }));
}
