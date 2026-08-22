import manifest from "../release-manifest.json" with { type: "json" };

export const PRODUCT_INFO = Object.freeze({
  displayName: manifest.product.displayName,
  description: manifest.product.description,
  runtimeName: manifest.product.runtimeName,
  packageName: manifest.package.name,
  binaryName: manifest.package.binaryName,
  version: manifest.release.version,
  repositorySlug: `${manifest.repository.owner}/${manifest.repository.name}`,
  repositoryUrl: `https://github.com/${manifest.repository.owner}/${manifest.repository.name}`
});
