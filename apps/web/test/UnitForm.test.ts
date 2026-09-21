import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Contact, Unit } from '@/api/types';
import UnitForm from '@/components/units/UnitForm.vue';
import { i18n } from '@/i18n';

const units: Unit[] = [
  { id: 'a1', buildingId: 'b', label: '1', floor: '1', kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: null, attachedToUnitId: null, owner: null },
  { id: 'p1', buildingId: 'b', label: 'P1', floor: null, kind: 'parking', areaM2: null, ownershipShare: null, ownerContactId: null, attachedToUnitId: null, owner: null },
];
const contacts: Contact[] = [{ id: 'c1', kind: 'person', firstName: 'Ана', lastName: 'Анева', companyNumber: null, vatNumber: null, email: null, phone: null, address: null, notes: null }];

describe('UnitForm', () => {
  it('offers only apartments/commercial as attachment targets and emits a typed payload', async () => {
    const w = mount(UnitForm, { props: { units, contacts }, global: { plugins: [i18n] } });
    const attach = w.get('[data-test=attachedToUnitId]');
    const values = attach.findAll('option').map((o) => o.attributes('value'));
    expect(values).toContain('a1');
    expect(values).not.toContain('p1');
    await w.get('[data-test=label]').setValue('P2');
    await w.get('[data-test=kind]').setValue('parking');
    await w.get('[data-test=areaM2]').setValue('12.5');
    await w.get('[data-test=ownerContactId]').setValue('c1');
    await attach.setValue('a1');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![0]![0]).toEqual({ label: 'P2', floor: null, kind: 'parking', areaM2: 12.5, ownershipShare: null, ownerContactId: 'c1', attachedToUnitId: 'a1' });
  });
  it('excludes the unit being edited from attachment targets', () => {
    const w = mount(UnitForm, { props: { units, contacts, initial: units[0] }, global: { plugins: [i18n] } });
    const values = w.get('[data-test=attachedToUnitId]').findAll('option').map((o) => o.attributes('value'));
    expect(values).not.toContain('a1');
  });
});
