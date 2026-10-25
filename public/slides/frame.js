// A single 1600 × 900 presentation canvas. Fit the whole slide to the screen;
// viewport dimensions never reflow the content or create scrolling slides.
function fitDeck() {
  const scale = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
  document.documentElement.style.setProperty('--deck-scale', String(scale));
}
fitDeck();
window.addEventListener('resize', fitDeck);
window.visualViewport?.addEventListener('resize', fitDeck);
document.addEventListener('fullscreenchange', fitDeck);
