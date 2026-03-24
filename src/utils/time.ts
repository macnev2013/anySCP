/**
 * Format an ISO date string as a human-readable relative time.
 * Handles SQLite UTC strings without the trailing "Z".
 */
export function relativeTime(isoDate: string): string {
  const now = Date.now();
  // SQLite stores datetime in UTC without the "Z" suffix
  const then = new Date(isoDate.endsWith("Z") ? isoDate : isoDate + "Z").getTime();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
