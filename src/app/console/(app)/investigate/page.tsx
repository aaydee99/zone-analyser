import { redirect } from 'next/navigation';

/** The investigation tools open on the Ray ID lookup. */
export default function InvestigatePage() {
  redirect('/console/investigate/ray');
}
