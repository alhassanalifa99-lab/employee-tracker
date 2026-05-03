/**
 * Generates solid-color PNGs for PWA manifest (icons + screenshots).
 * Run: node scripts/generate-pwa-assets.mjs
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function crc32(buf) {
    let c = ~0 >>> 0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
    return Buffer.concat([len, typeB, data, crc]);
}

function createSolidPng(w, h, r, g, b, a = 255) {
    const rowSize = 1 + w * 4;
    const raw = Buffer.alloc(rowSize * h);
    for (let y = 0; y < h; y++) {
        raw[y * rowSize] = 0;
        for (let x = 0; x < w; x++) {
            const o = y * rowSize + 1 + x * 4;
            raw[o] = r;
            raw[o + 1] = g;
            raw[o + 2] = b;
            raw[o + 3] = a;
        }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const green = [0, 232, 122];
const dark = [8, 12, 14];
const outDir = path.join(root, 'icons');
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'icon-192.png'), createSolidPng(192, 192, ...green));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), createSolidPng(512, 512, ...green));
fs.writeFileSync(path.join(outDir, 'icon-512-maskable.png'), createSolidPng(512, 512, ...dark));
fs.writeFileSync(path.join(outDir, 'screenshot-wide.png'), createSolidPng(1280, 720, ...dark));
fs.writeFileSync(path.join(outDir, 'screenshot-narrow.png'), createSolidPng(750, 1334, ...dark));

console.log('Wrote icons/*.png for PWA manifest.');
