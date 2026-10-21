export const APT_CHECK_EXECUTABLE = "apt-get";

export const APT_CHECK_ARGS = [
  "-s",
  "-y",
  "-o",
  "APT::Get::Show-Versions=true",
  "upgrade",
] as const;

export const SAFE_PROCESS_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  DEBIAN_FRONTEND: "noninteractive",
  LANG: "C",
  LC_ALL: "C",
};
