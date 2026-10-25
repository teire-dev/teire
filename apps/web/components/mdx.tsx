import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { ImageZoom } from "fumadocs-ui/components/image-zoom";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { icons } from "lucide-react";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { ConfigReference } from "./docs/config-reference";
import { Diagram } from "./docs/diagram";
import { BuiltOn, EcosystemGrid, ProviderRow } from "./docs/logos";
import { Phone, Phones, Shot } from "./docs/shots";
import { ExamplePr } from "./landing/example-pr";

/** A lucide icon by name, so .mdx files can write `icon={<Icon name="Bot" />}` without imports. */
function Icon({ name, ...props }: { name: keyof typeof icons } & ComponentProps<"svg">) {
  const Glyph = icons[name];
  // A name lucide doesn't have renders nothing rather than breaking the page.
  return Glyph ? <Glyph {...props} /> : null;
}

/** The real PR from the landing page, inside a docs page. */
function PrExample() {
  return (
    <div className="not-prose my-6 max-w-xl">
      <ExamplePr />
    </div>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: (props: ComponentProps<"img">) => <ImageZoom {...(props as ComponentProps<typeof ImageZoom>)} />,
    Accordion,
    Accordions,
    Files,
    Folder,
    File,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    Diagram,
    ConfigReference,
    EcosystemGrid,
    ProviderRow,
    BuiltOn,
    PrExample,
    Shot,
    Phone,
    Phones,
    Icon,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
