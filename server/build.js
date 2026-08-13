const fs = require('fs');
const path = require('path');

// Ensure client directory exists
const clientDir = path.join(__dirname, '../client');
if (!fs.existsSync(clientDir)) {
  fs.mkdirSync(clientDir, { recursive: true });
}

// 1. Copy socket.io.min.js from socket.io-client package to client folder
const srcPath = path.join(__dirname, '../node_modules/socket.io-client/dist/socket.io.min.js');
const destPath = path.join(clientDir, 'socket.io.min.js');

console.log(`Locating Socket.IO client script at: ${srcPath}`);
if (fs.existsSync(srcPath)) {
  fs.copyFileSync(srcPath, destPath);
  console.log(`✅ Successfully copied Socket.IO client to: ${destPath}`);
  const stats = fs.statSync(destPath);
  console.log(`   File size: ${stats.size} bytes`);
} else {
  console.error(`❌ Build error: socket.io-client script not found at ${srcPath}`);
  process.exit(1);
}

// 2. Bake production backend URL into client/index.html
const htmlPath = path.join(clientDir, 'index.html');
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const socketUrl = process.env.VITE_SOCKET_URL || process.env.BACKEND_URL || '';
  
  if (socketUrl) {
    console.log(`Baking production Socket URL: "${socketUrl}" into client/index.html`);
    html = html.replace('__BACKEND_URL_PLACEHOLDER__', socketUrl);
    fs.writeFileSync(htmlPath, html);
    console.log('✅ URL injection complete.');
  } else {
    console.log('ℹ️ No VITE_SOCKET_URL or BACKEND_URL environment variables set. Client will auto-detect localhost or display a configuration error in production.');
  }
} else {
  console.error(`❌ Build error: could not find frontend index file at: ${htmlPath}`);
  process.exit(1);
}

console.log('🎉 Static frontend build completed successfully.');
