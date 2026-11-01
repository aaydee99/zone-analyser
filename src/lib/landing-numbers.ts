/** Terraform resource types a backup exports with cf-terraforming, shown on the landing page.
 *  Counted by hand in runner/backup.js (a CommonJS script, not importable here): ZONE_RESOURCES
 *  and ACCOUNT_RESOURCES. tests/landing-numbers.test.ts recounts both lists and fails on drift. */
export const TF_ZONE_TYPES = 57;
export const TF_ACCOUNT_TYPES = 77;
