for (const button of document.querySelectorAll("[data-reveal]")) {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.reveal);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Skryť" : "Zobraziť";
    button.setAttribute("aria-pressed", String(visible));
  });
}
for (const form of document.querySelectorAll("form[data-preview]")) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const note = document.querySelector("[data-preview-note]");
    note.textContent = "Toto je ukážka dizajnu. Údaje sa nikam neodoslali.";
    for (const input of form.querySelectorAll(
      "input[type=password],input[name=password],input[name=confirm]",
    ))
      input.value = "";
  });
}
