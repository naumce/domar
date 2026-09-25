import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestEvents, requestPhotos } from '../src/resources/maintenance/repo.js';
import { setupPublishedBuilding } from './billing-fixture.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('maintenance requests', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let tech: { id: string; cookie: string };
  let other: { id: string; cookie: string };
  let readonlyCookie = '';
  let unitId = '';

  const post = (url: string, payload: unknown, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload: payload as never });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const patch = (url: string, payload: unknown, cookie?: string) =>
    t.app.inject({ method: 'PATCH', url, headers: { cookie: cookie ?? a.cookie }, payload: payload as never });

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await post(`/api/buildings/${A.buildingId}/maintenance`, {
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high', ...over,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-maint');
    b = await registerTenant(t.app, 'firma-maint-other');
    A = await setupPublishedBuilding(t.app, a.cookie);
    unitId = (await get(`/api/buildings/${A.buildingId}/units`)).json().rows[0].id;
    tech = await createStaffUser(t.app, a.cookie, 'firma-maint', { email: 'stefan@firma-maint.mk', firstName: 'Стефан', lastName: 'Стефановски', role: 'technician' });
    other = await createStaffUser(t.app, a.cookie, 'firma-maint', { email: 'nikola@firma-maint.mk', firstName: 'Никола', lastName: 'Николовски', role: 'technician' });
    readonlyCookie = (await createStaffUser(t.app, a.cookie, 'firma-maint', { email: 'ro@firma-maint.mk', firstName: 'Р', lastName: 'О', role: 'readonly' })).cookie;
  });
  afterAll(async () => { await t.close(); });

  it('creates a request reported by the signed-in manager, with a created event', async () => {
    const row = await create({ unitId });
    expect(row.status).toBe('new');
    expect(row.priority).toBe('high');
    expect(row.category).toBe('plumbing');
    expect(row.unitId).toBe(unitId);
    expect(row.unitLabel).toBe('1');
    expect(row.reporterKind).toBe('manager');
    expect(row.reporterName).toBe('O firma-maint');
    expect(row.assigneeUserId).toBeNull();
    expect(row.costMinor).toBeNull();
    expect(row.expenseId).toBeNull();
    expect(row.photoCount).toBe(0);

    const detail = (await get(`/api/maintenance-requests/${row.id}`)).json();
    expect(detail.description).toBe('Вода тече покрај вертикалата под влезот.');
    expect(detail.photos).toEqual([]);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0].kind).toBe('created');
    expect(detail.events[0].toStatus).toBe('new');
    expect(detail.events[0].visibility).toBe('internal');
    expect(detail.events[0].authorKind).toBe('manager');
  });

  it('walks new → triaged → assigned → in_progress → done and logs every step', async () => {
    const row = await create();
    const triaged = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged', note: 'Проверено на лице место.' });
    expect(triaged.statusCode).toBe(200);
    expect(triaged.json().status).toBe('triaged');

    // `supplierId: null` exercises the assign body's optional supplier as "none"; this fixture has none.
    const assigned = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id, supplierId: null });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json().status).toBe('assigned');
    expect(assigned.json().assigneeUserId).toBe(tech.id);
    expect(assigned.json().assigneeName).toBe('Стефан Стефановски');

    const started = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' }, tech.cookie);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().status).toBe('in_progress');

    const done = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done', cost: null, note: 'Заменета спојка.', visibility: 'owner' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe('done');
    expect(done.json().closedAt).not.toBeNull();
    expect(done.json().costMinor).toBeNull();
    expect(done.json().expenseId).toBeNull();

    const detail = (await get(`/api/maintenance-requests/${row.id}`)).json();
    expect(detail.events.map((e: { kind: string; toStatus: string | null }) => [e.kind, e.toStatus])).toEqual([
      ['created', 'new'], ['status_changed', 'triaged'], ['assigned', 'assigned'],
      ['status_changed', 'in_progress'], ['status_changed', 'done'],
    ]);
    expect(detail.events[1].note).toBe('Проверено на лице место.');
    expect(detail.events[3].authorName).toBe('Стефан Стефановски');
    // A status an owner can read on the card is a status they can read in the feed (addendum 11).
    expect(detail.events.map((e: { visibility: string }) => e.visibility)).toEqual(['internal', 'owner', 'owner', 'owner', 'owner']);
  });

  it('refuses an illegal move with 409 and leaves the status alone', async () => {
    const row = await create();
    const jump = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' });
    expect(jump.statusCode).toBe(409);
    expect(jump.json().error.code).toBe('status_locked');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().status).toBe('new');

    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'rejected', note: 'Двојна пријава.' });
    const reopen = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error.code).toBe('status_locked');
  });

  it('refuses to close without a decision about the money', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const res = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cost_decision_required');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().status).toBe('assigned');
  });

  it('reassigns without moving an in-progress request back to assigned', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' }, tech.cookie);
    const again = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: other.id });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().status).toBe('in_progress');
    expect(again.json().assigneeUserId).toBe(other.id);
  });

  it('only assigns to an active technician, accountant or owner of this tenant', async () => {
    const row = await create();
    const foreign = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: b.userId });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('invalid_reference');

    const ro = (await get('/api/users')).json().rows.find((u: { email: string }) => u.email === 'ro@firma-maint.mk');
    const readonlyAssignee = await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: ro.id });
    expect(readonlyAssignee.statusCode).toBe(400);
    expect(readonlyAssignee.json().error.code).toBe('invalid_reference');
  });

  it('shows a technician their own requests and nothing else', async () => {
    const mine = await create({ title: 'Лифтот запира меѓу катови', category: 'lift' });
    const theirs = await create({ title: 'Изгорена сијалица во ходник', category: 'electrical' });
    await post(`/api/maintenance-requests/${mine.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${theirs.id}/assign`, { assigneeUserId: other.id });

    const list = await get(`/api/buildings/${A.buildingId}/maintenance`, tech.cookie);
    expect(list.statusCode).toBe(200);
    const ids = list.json().rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    expect((await get(`/api/maintenance-requests/${mine.id}`, tech.cookie)).statusCode).toBe(200);
    // Not 403: a technician must not be able to enumerate the board by reading status codes.
    expect((await get(`/api/maintenance-requests/${theirs.id}`, tech.cookie)).statusCode).toBe(404);
    expect((await post(`/api/maintenance-requests/${theirs.id}/status`, { status: 'in_progress' }, tech.cookie)).statusCode).toBe(404);
  });

  it('refuses a technician the acts that are not theirs', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    expect((await post(`/api/buildings/${A.buildingId}/maintenance`, { title: 'x', description: '', category: 'other' }, tech.cookie)).statusCode).toBe(403);
    expect((await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: other.id }, tech.cookie)).statusCode).toBe(403);
    expect((await patch(`/api/maintenance-requests/${row.id}`, { priority: 'urgent' }, tech.cookie)).statusCode).toBe(403);
    const triage = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }, tech.cookie);
    expect(triage.statusCode).toBe(403); // the capability gate refuses a technician `triage` before any transition is considered
    // A technician may still speak on their own request.
    expect((await post(`/api/maintenance-requests/${row.id}/events`, { note: 'Ќе дојдам утре во 9.' }, tech.cookie)).statusCode).toBe(201);
  });

  it('lets readonly read the board and write nothing', async () => {
    const row = await create();
    expect((await get(`/api/buildings/${A.buildingId}/maintenance`, readonlyCookie)).statusCode).toBe(200);
    expect((await get(`/api/maintenance-requests/${row.id}`, readonlyCookie)).statusCode).toBe(200);
    expect((await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }, readonlyCookie)).statusCode).toBe(403);
    expect((await post(`/api/maintenance-requests/${row.id}/events`, { note: 'x' }, readonlyCookie)).statusCode).toBe(403);
  });

  it('gives a technician read on the building, as spec §10 says', async () => {
    const res = await get(`/api/buildings/${A.buildingId}`, tech.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Партизанска 12');
  });

  it('filters the board by status and by category', async () => {
    const list = await get(`/api/buildings/${A.buildingId}/maintenance?status=new&category=lift`);
    expect(list.statusCode).toBe(200);
    for (const r of list.json().rows) {
      expect(r.status).toBe('new');
      expect(r.category).toBe('lift');
    }
  });

  it('edits a request while it is open and refuses once it is closed', async () => {
    const row = await create();
    const edited = await patch(`/api/maintenance-requests/${row.id}`, { priority: 'urgent', title: 'Протекува цевка — итно' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().priority).toBe('urgent');
    expect(edited.json().title).toBe('Протекува цевка — итно');
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'rejected' });
    const late = await patch(`/api/maintenance-requests/${row.id}`, { priority: 'low' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('status_locked');
  });

  it('keeps another tenant out with 404, never 403', async () => {
    const row = await create();
    expect((await get(`/api/maintenance-requests/${row.id}`, b.cookie)).statusCode).toBe(404);
    expect((await post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }, b.cookie)).statusCode).toBe(404);
    expect((await get(`/api/buildings/${A.buildingId}/maintenance`, b.cookie)).statusCode).toBe(404);
  });

  it('refuses a unit that is not in this building', async () => {
    const otherBuilding = (await post('/api/buildings', { name: 'Востаничка 7' })).json().id;
    const res = await post(`/api/buildings/${otherBuilding}/maintenance`, { title: 'т', description: '', category: 'other', unitId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('guards a feed in the helper itself, whoever calls it', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const mine = { tenantId: a.tenantId, userId: tech.id, role: 'technician' as const };
    const theirs = { tenantId: a.tenantId, userId: other.id, role: 'technician' as const };
    expect((await requestEvents(t.db, mine, row.id)).length).toBeGreaterThan(0);
    // The helper is exported, so it answers for itself: no caller check stands between it and the row.
    expect(await requestEvents(t.db, theirs, row.id)).toEqual([]);
    expect(await requestPhotos(t.db, theirs, row.id)).toEqual([]);
    expect(await requestEvents(t.db, { tenantId: b.tenantId, userId: b.userId, role: 'owner' }, row.id)).toEqual([]);
    // A contact reads a feed only on the request they themselves reported (the portal, Task 6).
    expect(await requestEvents(t.db, { tenantId: a.tenantId, userId: a.userId, role: 'owner' }, row.id, { reporterContactId: A.owners.O1 })).toEqual([]);
  });

  it('filters the board by priority and by assignee, and pages it', async () => {
    const urgent = await create({ title: 'Пукна вертикала', priority: 'urgent' });
    await post(`/api/maintenance-requests/${urgent.id}/assign`, { assigneeUserId: other.id });

    const byPriority = await get(`/api/buildings/${A.buildingId}/maintenance?priority=urgent`);
    expect(byPriority.statusCode).toBe(200);
    expect(byPriority.json().rows.map((r: { id: string }) => r.id)).toContain(urgent.id);
    for (const r of byPriority.json().rows) expect(r.priority).toBe('urgent');

    const byAssignee = await get(`/api/buildings/${A.buildingId}/maintenance?assigneeUserId=${other.id}`);
    expect(byAssignee.json().rows.map((r: { id: string }) => r.id)).toContain(urgent.id);
    for (const r of byAssignee.json().rows) expect(r.assigneeUserId).toBe(other.id);

    const page = await get(`/api/buildings/${A.buildingId}/maintenance?pageSize=1`);
    expect(page.json().rows).toHaveLength(1);
    // `total` counts the whole board, not the page it just handed out.
    expect(page.json().total).toBeGreaterThan(1);
    const second = await get(`/api/buildings/${A.buildingId}/maintenance?pageSize=1&page=2`);
    expect(second.json().rows[0].id).not.toBe(page.json().rows[0].id);
    expect(second.json().total).toBe(page.json().total);
  });

  it('lets exactly one of two concurrent triages through', async () => {
    const row = await create();
    const [one, two] = await Promise.all([
      post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }),
      post(`/api/maintenance-requests/${row.id}/status`, { status: 'triaged' }),
    ]);
    expect([one.statusCode, two.statusCode].sort((x, y) => x - y)).toEqual([200, 409]);
    expect([one, two].find((r) => r.statusCode === 409)!.json().error.code).toBe('status_locked');

    const detail = (await get(`/api/maintenance-requests/${row.id}`)).json();
    expect(detail.status).toBe('triaged');
    expect(detail.events.filter((e: { kind: string }) => e.kind === 'status_changed')).toHaveLength(1);
  });

  it('audits every mutation', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${row.id}/events`, { note: 'Забелешка.' });
    const actions = (await t.db.query.auditLogs.findMany({ where: (l, { eq: e }) => e(l.entityId, row.id) })).map((l) => l.action).sort();
    expect(actions).toEqual(['maintenance.assign', 'maintenance.create', 'maintenance.event']);
  });
});
