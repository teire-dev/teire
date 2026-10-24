export {
  declarationEntries,
  declarationFor,
  type PackageManifest,
  readManifest,
  resolveSubpath,
} from "./entries";
export { exportsOnlySurface } from "./lexer";
export { type NpmSurfaceOptions, npmSurface, npmSurfaceDiff, npmTypesLayout } from "./npm";
export { type FetchedPackage, fetchNpmPackage, IntegrityError, verifyIntegrity } from "./npm-package";
export { surfaceChangeRecords } from "./records";
export { diffSurfaces, positionalParams, widenedByDefaultedTypeParams } from "./ts-diff";
export { canonicalType, extractTsSurface, normaliseSignature } from "./ts-walk";
export { materializeTypeDeps, packageNameOf, typesPackageName } from "./typedeps";
export * from "./types";
