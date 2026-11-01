import { RayView } from './view';

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** Ray ID lookup. ?ray=…&zone=…[&hours=…][&at=…] opens with a lookup (links from other pages). */
export default async function RayPage({ searchParams }: { searchParams: Params }) {
  const q = await searchParams;
  return <RayView initialRay={one(q.ray)} initialZone={one(q.zone)} initialHours={Number(one(q.hours)) || 24} initialAt={one(q.at)} />;
}
