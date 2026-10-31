import { redirect } from 'next/navigation';

/** Old entry point, kept so existing bookmarks still work. */
export default function UnlockRedirect() {
  redirect('/login');
}
