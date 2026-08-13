const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../client/index.html');
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  // Read target socket server URL from Vercel environment variables
  const socketUrl = process.env.VITE_SOCKET_URL || process.env.BACKEND_URL || '';
  if (socketUrl) {
    console.log(`Baking production Socket URL: "${socketUrl}" into client/index.html`);
    html = html.replace('__BACKEND_URL_PLACEHOLDER__', socketUrl);
    fs.writeFileSync(htmlPath, html);
    console.log('✅ Build successful! Socket URL is baked.');
  } else {
    console.log('ℹ️ No VITE_SOCKET_URL or BACKEND_URL env variables found. Localhost detection and manual override fallbacks will be used.');
  }
} else {
  console.error(`❌ Build failed: could not find frontend index file at: ${htmlPath}`);
  process.exit(1);
}
