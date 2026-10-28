import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";

/** Any address Teire doesn't have: the mark, one line, and the two ways back. */
export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 bg-canvas px-6 text-center">
      <LogoMark className="size-10" />
      <div className="flex flex-col gap-2">
        <span className="eyebrow">404</span>
        <h1 className="heading text-3xl text-ink">This page isn't here.</h1>
      </div>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/">
            Head home
            <ArrowRight data-icon="inline-end" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/docs">Docs</Link>
        </Button>
      </div>
    </main>
  );
}
