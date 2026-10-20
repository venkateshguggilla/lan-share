// Renders the app icon (build/icon.png, 512x512) with Electron. Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2f6fed"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
    <rect x="58" y="150" width="124" height="96" rx="14"/><path d="M90 330h60M120 246v84"/>
    <rect x="330" y="150" width="124" height="96" rx="14"/><path d="M362 330h60M392 246v84"/>
    <path d="M214 176h84l-22-22M298 226h-84l22 22" stroke-width="20"/>
  </g>
</svg></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
