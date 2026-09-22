import { describe, expect, it } from 'vitest';
import { mkPack } from '../src/country/index.js';
import { mt940Parser } from '../src/statements/index.js';

const sample = [
  ':20:STMT20260915', ':25:300000000123456', ':28C:00181/001', ':60F:C260914MKD3500000,00',
  ':61:2609150915C25609,99NTRFNONREF//BK123', ':86:?00Uplata?20INV-0001/2026 stan 1?32MARKO MARKOV',
  ':61:2609150915C35405,70NTRF00987//BK124', ':86:Uplata smetka 09/2026 Boskovski',
  ':61:2609160916D1200,00NTRFFEE//BK125', ':86:Provizija',
  ':62F:C260916MKD3559815,69', '-',
].join('\r\n');

describe('mt940 parser', () => {
  it('detects and parses credits and debits with references and counterparties', () => {
    expect(mt940Parser.detect(sample)).toBe(true);
    const r = mt940Parser.parse(sample, mkPack.parseAmountToMinor);
    expect(r.format).toBe('mt940');
    expect(r.accountNumber).toBe('300000000123456');
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ bookedAt: '2026-09-15', amountMinor: 2560999, counterparty: 'MARKO MARKOV' });
    expect(r.lines[0]!.reference).toContain('INV-0001/2026');
    expect(r.lines[1]).toMatchObject({ bookedAt: '2026-09-15', amountMinor: 3540570, counterparty: '' });
    expect(r.lines[1]!.reference).toContain('Boskovski');
    expect(r.lines[2]).toMatchObject({ bookedAt: '2026-09-16', amountMinor: -120000 });
    expect(r.warnings).toEqual([]);
  });
  it('warns on unparsable :61: lines and skips them', () => {
    const bad = ':20:X\r\n:61:garbage\r\n:86:x\r\n';
    const r = mt940Parser.parse(bad, mkPack.parseAmountToMinor);
    expect(r.lines).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/61/);
  });
  it('does not detect CSV text', () => {
    expect(mt940Parser.detect('date;amount;reference\n2026-09-01;100,00;x')).toBe(false);
  });
  it('treats RC (reversal of credit) as negative and RD (reversal of debit) as positive', () => {
    const rc = [':20:X', ':61:2609150915RC10000,00NTRFNONREF//1'].join('\r\n');
    const rd = [':20:X', ':61:2609150915RD10000,00NTRFNONREF//1'].join('\r\n');
    expect(mt940Parser.parse(rc, mkPack.parseAmountToMinor).lines[0]!.amountMinor).toBe(-1000000);
    expect(mt940Parser.parse(rd, mkPack.parseAmountToMinor).lines[0]!.amountMinor).toBe(1000000);
  });
  it('warns and skips :61: lines with an invalid value date', () => {
    const bad = [':20:X', ':61:2613400915C100,00NTRFX//1'].join('\r\n');
    const r = mt940Parser.parse(bad, mkPack.parseAmountToMinor);
    expect(r.lines).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/date/i);
  });
  it('appends :61: continuation lines (subfield 9) to raw and reference', () => {
    const withCont = [':20:X', ':61:2609150915C10000,00NTRFNONREF//1', 'CONTLINE', ':86:Uplata'].join('\r\n');
    const r = mt940Parser.parse(withCont, mkPack.parseAmountToMinor);
    expect(r.lines[0]!.reference).toContain('CONTLINE');
    expect(r.lines[0]!.raw).toContain('CONTLINE');
  });
  it('treats an empty :25: as no account number', () => {
    const noAcct = [':20:X', ':25:', ':61:2609150915C100,00NTRFX//1', ':86:x'].join('\r\n');
    const r = mt940Parser.parse(noAcct, mkPack.parseAmountToMinor);
    expect(r.accountNumber).toBeNull();
  });
});
