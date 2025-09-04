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
      const method = req.method;
      let url = req.url.split('?')[0];

      // Serve a test-rendered variant that injects a CSRF token and sets action to /register
      if (url === '/' || url === '/_test_register' || url === '/register') url = '/_test_register.html';

      // POST handler for mocked registration endpoint
      if (method === 'POST' && url === '/register') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, received: body }));
        });
        return;
      }

      const filePath = path.join(TEMPLATES_DIR, url === '/_test_register.html' ? 'register.html' : url);
      fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }

    // produce a lightweight test-rendered HTML by injecting CSRF and adjusting action
    let out = data;
    // replace the csrf block with a hidden input for testing (if present)
    out = out.replace(/\{% if csrf_token is defined %\}.*?\{% endif %\}/s, '<input type="hidden" name="csrf_token" value="test-csrf-token">');
    // ensure there's always a csrf token available for legacy form POST checks
    if (!/name="csrf_token"/i.test(out)) {
      // try to insert before </body>, otherwise prepend
      if (out.indexOf('</body>') !== -1) {
        out = out.replace('</body>', '<input type="hidden" name="csrf_token" value="test-csrf-token"></body>');
      } else {
        out = '<input type="hidden" name="csrf_token" value="test-csrf-token">' + out;
      }
    }
    // replace action with a concrete endpoint
    out = out.replace(/action=\"\{\{ request.path \}\}\"/g, 'action="/register"');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(out);
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
  await page.goto('http://localhost:' + PORT + '/_test_register.html');

  console.log('Page loaded. Running browser checks...');

  // Debug logging to help investigate missing POST captures
  page.on('console', msg => console.log('PAGE:', msg.text()));
  page.on('request', req => console.log('-> request', req.method(), req.url()));
  page.on('response', res => console.log('<- response', res.status(), res.url()));
  page.on('requestfailed', req => console.log('!! request failed', req.url(), req.failure && req.failure().errorText));

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

  // check strength updates (do this before submitting so elements remain present)
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

  // Ensure confirm matches final password before submit
  await page.fill('#reg_confirm_password', 'VeryStr0ngP@ssw0rd!');
  await page.waitForTimeout(100);

  // Intercept the registration POST and inspect payload
  let postCaptured = null;
  await page.route('**/register', async (route, request) => {
    try {
      if (request.method().toUpperCase() === 'POST') {
        postCaptured = request.postData();
        // return a fake successful response
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      } else {
        await route.continue();
      }
    } catch (e) { await route.continue(); }
  });

  // submit the form and wait briefly for route to capture
  await Promise.all([
    page.click('#regSubmit'),
    page.waitForTimeout(300)
  ]);

  if (!postCaptured) { console.error('ERROR: Registration POST not captured'); await browser.close(); server.close(); process.exit(8); }
  console.log('Captured POST payload:', postCaptured);

  // check CSRF token present
  if (!/csrf_token=test-csrf-token/.test(postCaptured)) { console.error('ERROR: CSRF token missing or not submitted'); await browser.close(); server.close(); process.exit(9); }

  

  await browser.close();
  server.close();
  console.log('Checks complete.');
}

runChecks().catch(e => { console.error(e); process.exit(1); });
