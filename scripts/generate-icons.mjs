import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const iconsDir = path.join(projectRoot, 'icons');

const source = path.join(iconsDir, 'workwatch-logo.png');

async function generateSquareIcon({ outFile, size, paddingPct, background }) {
  const pad = Math.round(size * paddingPct);
  const inner = Math.max(1, size - pad * 2);

  const contained = await sharp(source)
    .resize(inner, inner, { fit: 'contain', withoutEnlargement: true })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background
    }
  })
    .composite([{ input: contained, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(iconsDir, outFile));
}

async function main() {
  // "any" icons: transparent background, moderate padding to avoid edge cropping.
  await generateSquareIcon({
    outFile: 'icon-192.png',
    size: 192,
    paddingPct: 0.12,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  });

  await generateSquareIcon({
    outFile: 'icon-512.png',
    size: 512,
    paddingPct: 0.12,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  });

  // Maskable: larger safe-zone padding + solid background so it doesn't disappear.
  await generateSquareIcon({
    outFile: 'icon-512-maskable.png',
    size: 512,
    paddingPct: 0.22,
    background: '#080c0e'
  });

  // Optional: favicon-like square used in your header/logo.
  await generateSquareIcon({
    outFile: 'workwatch-logo-square-256.png',
    size: 256,
    paddingPct: 0.14,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  });

  console.log('Generated icons in', iconsDir);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

