This directory contains scripts to run quick checks on frontend templates.

check-register.js
 - Starts a static server serving `app/templates`
 - Uses Playwright (if installed) to run headless checks against `/register.html`
 - Fallback: static checks (presence of expected elements) when Playwright isn't available

Usage:
  # install dependencies if you want full browser checks
  npm install playwright

  # run the check
  npm run check:register
