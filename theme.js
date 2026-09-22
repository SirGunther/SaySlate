(() => {
  "use strict";

  const THEME_KEY = "sayslate-theme";
  let savedTheme = "light";

  try {
    const storedTheme = localStorage.getItem(THEME_KEY);
    if (storedTheme === "dark" || storedTheme === "light") savedTheme = storedTheme;
  } catch {
    // Light mode remains the safe default when storage is unavailable.
  }

  document.documentElement.dataset.theme = savedTheme;
})();
