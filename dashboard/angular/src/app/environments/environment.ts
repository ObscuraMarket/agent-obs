export const environment = {
  production: false,
  // OBS agent dashboard API (agent-obs, `npm run dashboard` in agent/, port 4671).
  // Override at runtime without rebuilding: open the page with ?api=https://host
  // (remembered in localStorage) or ?api=reset to go back to this default.
  // Set to '' to use same-origin relative URLs (see proxy.conf.json / `npm run start:proxy`).
  obsApiUrl: 'http://127.0.0.1:4671'
};
