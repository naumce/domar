import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, pushPayload } from '../src/index.js';

describe('pushPayload', () => {
  it('keeps the id, the title and the link and drops everything else', () => {
    const row = {
      id: 'n-1', title: 'Нова фактура · Партизанска 12', link: '/portal/invoices/i-1',
      body: 'Вкупно за плаќање: 2.450,00 ден.', tenantId: 't-1', ownerAccountId: 'a-1',
    };
    const out = pushPayload(row);
    // Spec §11: title + link only. A whitelist, so a column added later cannot leak by accident.
    expect(Object.keys(out).sort()).toEqual(['id', 'link', 'title']);
    expect(JSON.stringify(out)).not.toContain('ден.');
    expect(JSON.stringify(out)).not.toContain('2.450');
  });

  it('declares the seven kinds the database enum declares', () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
      'maintenance_status', 'maintenance_request_created', 'delivery_failed']);
  });
});
