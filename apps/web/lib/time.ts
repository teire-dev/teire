/** Time in words, one set for every page (plan revision 3.4, B12): lists, cards, deadlines, the assistant. */
const DAY = 86_400_000;

const ms = (at: Date | string) => (typeof at === "string" ? Date.parse(at) : at.getTime());

/** "3 h ago", "2 d ago": a list's sense of time (the exact time goes on hover). */
export function ago(at: Date | string | null | undefined) {
  if (!at) return "";
  const s = Math.max(0, (Date.now() - ms(at)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** "in 12 days", "tomorrow", "today", "3 days ago": a deadline either side of now. */
export function until(at: Date | string | null | undefined) {
  if (!at) return "";
  const d = Math.round((ms(at) - Date.now()) / DAY);
  return d > 1 ? `in ${d} days` : d === 1 ? "tomorrow" : d === 0 ? "today" : `${-d} days ago`;
}

/** "in 12 days", "tomorrow", "today": the countdown an upcoming deadline carries (never "ago"). */
export function countdown(deadline: string, now = Date.now()) {
  const days = Math.ceil((Date.parse(deadline) - now) / DAY);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}
