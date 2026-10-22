const error = document.querySelector("[data-error]");
if (error && new URLSearchParams(location.search).get("e") === "1") {
  error.hidden = false;
  const field = document.querySelector("#password");
  if (field instanceof HTMLInputElement) {
    field.focus();
  }
}
