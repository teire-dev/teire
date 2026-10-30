/** Where a source's words come from, so a reader can weigh them (`trustBasis`, plan revision 3.3, U5). */
export const TRUST_BASIS: Record<string, string> = {
  registry: "from the package registry",
  "source-repo": "from the project's own repository",
  "official-domain": "from the provider's own site",
  "advisory-db": "from an advisory database",
  computed: "computed by Teire from the published code",
  "repo-config": "declared in a repository's teire.yml",
};
