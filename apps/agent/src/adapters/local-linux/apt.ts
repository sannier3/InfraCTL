export const APT_CHECK_EXECUTABLE = "apt-get";

export const APT_CHECK_ARGS = [
  "-s",
  "-y",
  "-o",
  "APT::Get::Show-Versions=true",
  "upgrade",
] as const;

export const APT_UPGRADE_EXECUTABLE = "apt-get";

export const APT_UPGRADE_ARGS = [
  "-y",
  "-o",
  "Dpkg::Options::=--force-confdef",
  "-o",
  "Dpkg::Options::=--force-confold",
  "upgrade",
] as const;

export const APT_REFRESH_ARGS = ["update"] as const;

export const DPKG_QUERY_EXECUTABLE = "dpkg-query";

// Guillemets simples : ${Package} reste littéral. \\t et \\n sont les échappements lus par dpkg.
export const DPKG_QUERY_ARGS = ["-W", "-f", '${Package}\\t${Version}\\n'] as const;

export const APT_DIST_CHECK_ARGS = [
  "-s",
  "-y",
  "-o",
  "APT::Get::Show-Versions=true",
  "dist-upgrade",
] as const;

export const APT_DIST_UPGRADE_ARGS = [
  "-y",
  "-o",
  "Dpkg::Options::=--force-confdef",
  "-o",
  "Dpkg::Options::=--force-confold",
  "dist-upgrade",
] as const;

export const SAFE_PROCESS_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  DEBIAN_FRONTEND: "noninteractive",
  LANG: "C",
  LC_ALL: "C",
};
