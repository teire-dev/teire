import { RepoTabs } from "@/components/app/repo-tabs";

/** Settings (plan revision 3.3, U3; Factory's settings grammar): a mono heading over section tabs. */
export default function SettingsLayout({ children }: LayoutProps<"/app/settings">) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="eyebrow text-sm">Settings</h1>
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
