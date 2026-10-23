const KEY = "infra-theme";
const CHOICES = ["system", "light", "dark"];
const LABELS = { system: "Design · Système", light: "Design · Clair", dark: "Design · Sombre" };

export function themeChoice() {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* stockage indisponible : on suit le système */
  }
  return "system";
}

export function resolvedTheme(choice = themeChoice()) {
  if (choice === "light" || choice === "dark") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(choice = themeChoice()) {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(choice);
  root.dataset.themeChoice = choice;
}

export function cycleTheme() {
  const next = CHOICES[(CHOICES.indexOf(themeChoice()) + 1) % CHOICES.length];
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* le choix reste valable pour cette page */
  }
  applyTheme(next);
  return next;
}

export function themeButtonLabel(choice = themeChoice()) {
  return LABELS[choice];
}

export function watchSystemTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (themeChoice() === "system") applyTheme("system");
  });
}
