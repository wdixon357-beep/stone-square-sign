const MS_PER_DAY = 24 * 60 * 60 * 1000;

const positiveDays = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
};

/* Lodge officers may use the desk only around meetings, so a seven-day fixed token
 * signs everyone out between ordinary uses. Sessions now expire after inactivity:
 * an active session is renewed only when it reaches the refresh window. Logout,
 * password reset and access revocation still invalidate it immediately. */
export const createSessionPolicy = ({
  lifetimeDays: lifetimeValue = 90,
  refreshWindowDays: refreshValue = 30,
} = {}) => {
  const lifetimeDays = positiveDays(lifetimeValue, 90);
  const refreshWindowDays = Math.min(
    lifetimeDays,
    positiveDays(refreshValue, Math.min(30, lifetimeDays)),
  );
  const lifetimeMs = lifetimeDays * MS_PER_DAY;
  const refreshWindowMs = refreshWindowDays * MS_PER_DAY;

  return {
    lifetimeDays,
    refreshWindowDays,
    expiresAt(now = Date.now()) {
      return new Date(now + lifetimeMs).toISOString();
    },
    shouldRefresh(expiresAt, now = Date.now()) {
      const expiry = Date.parse(expiresAt);
      return Number.isFinite(expiry) && expiry > now && expiry - now <= refreshWindowMs;
    },
  };
};
