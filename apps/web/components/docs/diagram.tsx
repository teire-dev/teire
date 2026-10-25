import { ImageZoom } from "fumadocs-ui/components/image-zoom";

/**
 * An architecture diagram rendered from its Mermaid source (.github/diagrams) in Teire's own
 * colours: the light picture in light mode, the dark one in dark; either opens full size on a tap.
 */
const SIZE: Record<string, { width: number; height: number }> = {};

export function Diagram({
  name,
  alt,
  caption,
  width = 1600,
  height = 900,
}: {
  name: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
}) {
  const size = SIZE[name] ?? { width, height };
  return (
    <figure className="not-prose my-8">
      <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card">
        <ImageZoom
          src={`/diagrams/${name}-light.png`}
          alt={alt}
          {...size}
          className="block w-full dark:hidden"
        />
        <ImageZoom
          src={`/diagrams/${name}-dark.png`}
          alt={alt}
          {...size}
          className="hidden w-full dark:block"
        />
      </div>
      {caption ? (
        <figcaption className="mt-2.5 text-[13px] text-fd-muted-foreground">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
