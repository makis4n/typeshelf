/**
 * How the sync reads and replaces the settings: always through the copy
 * kept in the browser's storage, never a tab's own copy.
 *
 * Several tabs share that stored copy, and each merges its changes into it
 * (`saveSetting`), but each tab also holds its own copy in memory, which
 * goes stale as soon as another tab changes something. If the sync sent a
 * tab's copy, a tab that had missed a change would send the old value to
 * the account, and the browser and the account would disagree from then on.
 */

import { loadSettings, parseSettings, saveSettings, type Settings } from '../settings';
import type { SettingsPort } from './sync';

/**
 * @param show put the account's settings into effect on this page (they are already stored)
 */
export function storedSettingsPort(show: (next: Settings) => void): SettingsPort {
  return {
    read: () => loadSettings(),
    apply: (data) => {
      const next = parseSettings(data);
      // Stored whole, so storage matches the account even where this tab's copy already did.
      saveSettings(next);
      show(next);
    },
  };
}
