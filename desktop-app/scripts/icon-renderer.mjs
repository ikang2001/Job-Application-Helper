import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sourcePath = process.env.JOB_HELPER_ICON_SOURCE;
const outputPath = process.env.JOB_HELPER_ICON_OUTPUT;
if (!sourcePath || !outputPath) throw new Error('缺少桌面图标输入或输出路径');

// Hidden transparent capture does not need GPU compositing and can fail with
// Chromium's UnknownVizError on some Windows sessions.
app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({
      width: 512,
      height: 512,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await window.loadFile(sourcePath);
    await window.webContents.executeJavaScript(`
      const svg = document.documentElement;
      svg.setAttribute('width', '512');
      svg.setAttribute('height', '512');
      svg.style.width = '512px';
      svg.style.height = '512px';
      svg.style.margin = '0';
    `);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, image.toPNG());
    window.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
