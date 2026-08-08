/** Shared constants. */
export const WORKER_BASE_URL = "https://90dwp-push.mcmillendaniel.workers.dev";

/**
 * Identifies the build this module set came from. Surfaced in Settings next to
 * the service worker's cache name: if the two disagree with what was deployed,
 * the app is running a mix of old and new files.
 */
export const APP_VERSION = "2026-08-08 reminders";

/** The logbook day starts at this local hour. */
export const RESET_HOUR = 4;

export const STORAGE_KEY = "90dwp_state_v1";
export const PUSH_RESULT_KEY = "90dwp_last_push_result";

export const DEFAULT_SETTINGS = { pushEnabled: false };
