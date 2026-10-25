import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import sizes from "@/lib/shots.json";

/**
 * Real captures of the product (local app, signed in, real scans and runs): wide desktop shots that
 * open full size on a tap, and phone shots in a frame. Sizes come from lib/shots.json.
 */
type Sizes = Record<string, { width: number; height: number }>;

export function Shot({ name, alt, caption }: { name: string; alt: string; caption?: string }) {
  const size = (sizes as Sizes)[`wide/${name}`] ?? { width: 1280, height: 1080 };
  return (
    <figure className="not-prose my-6">
      <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card">
        <ImageZoom src={`/shots/wide/${name}.webp`} alt={alt} {...size} className="block w-full" />
      </div>
      {caption ? <figcaption className="mt-2 text-[13px] text-fd-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

export function Phone({ name, alt, caption }: { name: string; alt: string; caption?: string }) {
  const size = (sizes as Sizes)[`phone/${name}`] ?? { width: 780, height: 1688 };
  return (
    <figure className="not-prose my-6 flex w-[240px] max-w-full flex-col items-center gap-2">
      <div className="w-full overflow-hidden rounded-[28px] border-[6px] border-fd-border bg-fd-card">
        <ImageZoom src={`/shots/phone/${name}.webp`} alt={alt} {...size} className="block w-full" />
      </div>
      {caption ? <figcaption className="text-center text-[12px] text-fd-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

/** Several phone shots side by side; they scroll sideways on a narrow screen. */
export function Phones({ children }: { children: React.ReactNode }) {
  return <div className="not-prose my-6 flex gap-4 overflow-x-auto pb-2">{children}</div>;
}
