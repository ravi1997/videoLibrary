/*
Simple headless check for register page using Playwright if available.
This script will:
 - start a tiny static server that serves the templates directory
 - open the register page at /register.html
 - run basic checks: required field validation, password match, strength meter updates

Usage: node scripts/check-register.js

Note: Playwright must be installed globally or in the project for full checks.
If Playwright is not installed, the script will run a basic HTML lint by loading file contents and checking for known elements.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.resolve(__dirname, '..', 'app', 'templates');
const PORT = 34567;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url === '/' || url === '/register') url = '/register.html';
      const filePath = path.join(TEMPLATES_DIR, url);
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    }).listen(PORT, () => resolve(server));
  });
}

async function runChecks() {
  const server = await startServer();
  console.log('Static server started at http://localhost:' + PORT);

  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.warn('Playwright not installed. Running lightweight static checks.');
    const html = fs.readFileSync(path.join(TEMPLATES_DIR, 'register.html'), 'utf8');
    const checks = [
      /id="reg_username"/,
      /id="reg_email"/,
      /id="reg_password"/,
      /id="reg_confirm_password"/,
      /id="pwStrength"/,
    ];
    let ok = true;
    checks.forEach((rx) => { if (!rx.test(html)) { console.error('Missing element matching', rx); ok = false; } });
    server.close();
    process.exit(ok ? 0 : 2);
    return;
  }

  const browser = await playwright.chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://localhost:' + PORT + '/register.html');

  console.log('Page loaded. Running browser checks...');

  // Check presence of fields
  const selectors = ['#reg_username', '#reg_email', '#reg_password', '#reg_confirm_password', '#pwStrength', '#regSubmit'];
  for (const s of selectors) {
    const el = await page.$(s);
    if (!el) {
      console.error('ERROR: Missing selector', s);
      await browser.close(); server.close(); process.exit(3);
    }
  }

  // Test password mismatch prevents submission
  await page.fill('#reg_username', 'tester');
  await page.fill('#reg_email', 'test@example.com');
  await page.fill('#reg_password', 'Password123!');
  await page.fill('#reg_confirm_password', 'PasswordX');
  const disabledBefore = await page.$eval('#regSubmit', el => el.disabled);
  if (!disabledBefore) { console.error('ERROR: Submit should be disabled on mismatch'); await browser.close(); server.close(); process.exit(5); }

  // fix confirm
  await page.fill('#reg_confirm_password', 'Password123!');
  // wait for validation
  await page.waitForTimeout(200);
  const disabledAfter = await page.$eval('#regSubmit', el => el.disabled);
  if (disabledAfter) { console.error('ERROR: Submit should be enabled after valid input'); await browser.close(); server.close(); process.exit(4); }

  // check strength updates
  await page.fill('#reg_password', 'weak');
  await page.waitForTimeout(100);
  const valWeak = await page.$eval('#pwStrength', el => el.getAttribute('value') || el.value);
  console.log('Strength after weak pwd:', valWeak);
  if (Number(valWeak) >= 2) { console.error('ERROR: Weak password scored too high', valWeak); await browser.close(); server.close(); process.exit(6); }

  await page.fill('#reg_password', 'VeryStr0ngP@ssw0rd!');
  await page.waitForTimeout(100);
  const valStrong = await page.$eval('#pwStrength', el => el.getAttribute('value') || el.value);
  console.log('Strength after strong pwd:', valStrong);
  if (Number(valStrong) < 3) { console.error('ERROR: Strong password scored too low', valStrong); await browser.close(); server.close(); process.exit(7); }

  await browser.close();
  server.close();
  console.log('Checks complete.');
}

runChecks().catch(e => { console.error(e); process.exit(1); });
