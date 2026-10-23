import { applyTheme, cycleTheme, themeButtonLabel, watchSystemTheme } from "./theme.js";

applyTheme();
watchSystemTheme();
const themeButton = document.querySelector("#theme");
if (themeButton instanceof HTMLButtonElement) {
  themeButton.textContent = themeButtonLabel();
  themeButton.addEventListener("click", () => {
    cycleTheme();
    themeButton.textContent = themeButtonLabel();
  });
}

const error = document.querySelector("[data-error]");
if (error && new URLSearchParams(location.search).get("e") === "1") {
  error.hidden = false;
  const field = document.querySelector("#password");
  if (field instanceof HTMLInputElement) {
    field.focus();
  }
}
