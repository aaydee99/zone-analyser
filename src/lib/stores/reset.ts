'use client';
import { useDataCache } from './data-cache';
import { useUiStore } from './ui-state';
import { useZoneStore } from './zone-store';

/** Forgets every kept answer: at sign-out, and when another person signs in in this tab. */
export function resetStores() {
  useZoneStore.getState().reset();
  useDataCache.getState().reset();
  useUiStore.getState().reset();
}

let owner = '';
/** The signed-in person: what is kept belongs to them, so another person in this tab starts empty. */
export function storesFor(userId: string) {
  if (owner && owner !== userId) resetStores();
  // The zone store is also kept across reloads: it checks whom its saved copy belongs to.
  if (owner !== userId) void useZoneStore.getState().claim(userId);
  owner = userId;
}
