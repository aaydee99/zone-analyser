import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { setDismissed } from '@/lib/monitor-store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Dismisses a finding (it stays out of notifications and counts) or brings it back: { dismissed: boolean }. */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const id = (await params).id;
  if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(404, 'Finding not found');
  const { dismissed } = await readBody<{ dismissed?: boolean }>(req);
  const f = await setDismissed(id, dismissed === false ? null : me.email);
  if (!f) throw new HttpError(404, 'Finding not found');
  await audit(me, dismissed === false ? 'monitoring.finding_restored' : 'monitoring.finding_dismissed', f.title, { check: f.check, severity: f.severity });
  return { finding: f };
}, { perm: 'monitors:manage' });
