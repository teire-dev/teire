import { cn } from "cn";

/** A brand's own light or dark mark (never recoloured with CSS), sized by the caller's height. */
export function BrandLogo({
  light,
  dark,
  alt,
  className,
}: {
  light: string;
  dark?: string;
  alt: string;
  className?: string;
}) {
  if (!dark || dark === light)
    // biome-ignore lint/performance/noImgElement: small self-hosted SVG marks, no optimisation to gain
    return <img src={light} alt={alt} className={cn("h-5 w-auto", className)} />;
  return (
    <>
      {/* biome-ignore lint/performance/noImgElement: small self-hosted SVG marks */}
      <img src={light} alt={alt} className={cn("h-5 w-auto dark:hidden", className)} />
      {/* biome-ignore lint/performance/noImgElement: small self-hosted SVG marks */}
      <img src={dark} alt={alt} className={cn("hidden h-5 w-auto dark:block", className)} />
    </>
  );
}
