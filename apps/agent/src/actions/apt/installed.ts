const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*$/;

export function parseInstalledPackages(stdout: string): Array<{ name: string; version: string }> {
  const packages = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      continue;
    }
    const name = line.slice(0, tab).trim();
    const version = line.slice(tab + 1).trim();
    if (!PACKAGE_NAME.test(name) || version.length === 0 || version.length > 200 || /\s/.test(version)) {
      continue;
    }
    packages.set(name, version);
  }
  return [...packages.entries()].slice(0, 8_000).map(([name, version]) => ({ name, version }));
}
