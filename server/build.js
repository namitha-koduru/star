const fs = require('fs');
const path = require('path');

// 1. Copy socket.io.min.js from node_modules to client folder
const srcPath = path.join(__dirname, '../node_modules/socket.io/client-dist/socket.io.min.js');
const destPath = path.join(__dirname, '../client/socket.io.min.js');

if (fs.existsSync(srcPath)) {
  fs.copyFileSync(srcPath, destPath);
  console.log('✅ Successfully copied local socket.io.min.js to client folder.');
} else {
  console.error(`❌ Build warning: local Socket.IO client not found at ${srcPath}`);
}

// 2. Perform HTML replacements
const htmlPath = path.join(__dirname, '../client/index.html');
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  
  // Make sure index.html points to local script instead of CDN
  if (html.includes('https://cdn.socket.io/4.8.1/socket.io.min.js')) {
    html = html.replace('https://cdn.socket.io/4.8.1/socket.io.min.js', '/socket.io.min.js');
  }

  // Read target socket server URL from Vercel environment variables
  const socketUrl = process.env.VITE_SOCKET_URL || process.env.BACKEND_URL || '';
  if (socketUrl) {
    console.log(`Baking production Socket URL: "${socketUrl}" into client/index.html`);
    html = html.replace('__BACKEND_URL_PLACEHOLDER__', socketUrl);
  } else {
    console.log('ℹ️ No VITE_SOCKET_URL or BACKEND_URL env variables found. Localhost detection and manual override fallbacks will be used.');
  }
  
  fs.writeFileSync(htmlPath, html);
  console.log('✅ Build html updates completed.');
} else {
  console.error(`❌ Build failed: could not find frontend index file at: ${htmlPath}`);
  process.exit(1);
}
