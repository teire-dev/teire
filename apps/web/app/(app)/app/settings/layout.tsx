import { RepoTabs } from "@/components/app/repo-tabs";

/** Settings (plan revision 3.4, V4): the heading over section tabs, each its own URL. */
export default function SettingsLayout({ children }: LayoutProps<"/app/settings">) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-4">
        <h1 className="heading text-3xl text-ink">Settings</h1>
        <RepoTabs
          base="/app/settings"
          tabs={[
            { key: "organization", label: "Organization" },
            { key: "repositories", label: "Repositories" },
            { key: "installations", label: "Installations" },
            { key: "usage", label: "Usage" },
          ]}
        />
      </div>
      {children}
    </div>
  );
}
