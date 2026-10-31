import { TimelineView } from './view';

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** One zone's incident timeline. ?zone=ID (from the zone explorer and monitoring findings). */
export default async function TimelinePage({ searchParams }: { searchParams: Params }) {
  const q = await searchParams;
  const hours = Number(one(q.hours)) || 24;
  return <TimelineView initialZone={one(q.zone)} initialHours={hours} />;
}
