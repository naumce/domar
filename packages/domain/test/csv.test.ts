import { describe, expect, it } from 'vitest';
import { mkPack } from '../src/country/index.js';
import { csvParser, detectStatementParser } from '../src/statements/index.js';

describe('csv statement parser', () => {
  const text = 'Date;Amount;Reference;Counterparty\n2026-09-15;25.609,99;"Uplata INV-0001/2026; stan 1";Marko Markov\n15.09.2026;-1.200,00;Provizija;\n';
  it('detects header, delimiter and both date formats; handles quoted fields', () => {
    expect(csvParser.detect(text)).toBe(true);
    expect(detectStatementParser(text, mkPack)?.id).toBe('csv');
    const r = csvParser.parse(text, mkPack.parseAmountToMinor);
    expect(r.lines).toEqual([
      { bookedAt: '2026-09-15', amountMinor: 2560999, reference: 'Uplata INV-0001/2026; stan 1', counterparty: 'Marko Markov', raw: expect.any(String) },
      { bookedAt: '2026-09-15', amountMinor: -120000, reference: 'Provizija', counterparty: '', raw: expect.any(String) },
    ]);
  });
  it('accepts comma delimiter and rejects files without date/amount headers', () => {
    const r = csvParser.parse('date,amount,reference\n2026-01-02,10.50,x\n', mkPack.parseAmountToMinor);
    expect(r.lines[0]).toMatchObject({ bookedAt: '2026-01-02', amountMinor: 1050 });
    expect(csvParser.detect('foo;bar\n1;2')).toBe(false);
    expect(detectStatementParser('foo;bar\n1;2', mkPack)).toBeNull();
  });
  it('warns on rows with bad dates or amounts and skips them', () => {
    const r = csvParser.parse('date;amount\n2026-13-40;10\n2026-01-01;abc\n2026-01-01;5\n', mkPack.parseAmountToMinor);
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toHaveLength(2);
  });
});
