// A known session secret for a test that has to mint a bearer by hand (the two-field shape from before
// 2026-09-08, which accounts.ts still verifies until the last of them ages out): set before accounts.ts is
// evaluated, since the secret is read once at load. Import it after tmpdata.ts and before anything under src/.
process.env.OBS_SESSION_SECRET = process.env.OBS_SESSION_SECRET || "obs-test-session-secret";
export const TEST_SESSION_SECRET = process.env.OBS_SESSION_SECRET;
