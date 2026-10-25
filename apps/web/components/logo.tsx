import Link from "next/link";

/** Teire's mark: a T on a schematic square, with the wordmark in Geist. */
export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 font-semibold tracking-tight"
      aria-label="Teire home"
    >
      <svg viewBox="0 0 16 16" className="size-5" aria-hidden>
        <rect
          x="1.25"
          y="1.25"
          width="13.5"
          height="13.5"
          rx="3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5 5.25h6M8 5.25v5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span>Teire</span>
    </Link>
  );
}
