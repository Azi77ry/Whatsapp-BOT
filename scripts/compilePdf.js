const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const htmlPath = path.resolve(__dirname, '../public/KnightBot_Commands_Manual_Azirytech.html');
const pdfPath = path.resolve(__dirname, '../KnightBot_Commands_Manual_Azirytech.pdf');
const publicPdfPath = path.resolve(__dirname, '../public/KnightBot_Commands_Manual_Azirytech.pdf');
const tempProfile = path.resolve(__dirname, '../.temp_chrome_profile');

if (!fs.existsSync(tempProfile)) {
    fs.mkdirSync(tempProfile, { recursive: true });
}

console.log('Compiling PDF with Chrome directly from Node spawn...');
console.log('Source HTML:', htmlPath);
console.log('Target PDF:', pdfPath);

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-pdf-header-footer',
    `--user-data-dir=${tempProfile}`,
    `--print-to-pdf=${pdfPath}`,
    fileUrl
];

const child = spawn(chromePath, args);

child.stdout.on('data', (d) => console.log('STDOUT:', d.toString()));
child.stderr.on('data', (d) => console.log('STDERR:', d.toString()));

child.on('close', (code) => {
    console.log('Chrome process exited with code:', code);
    if (fs.existsSync(pdfPath)) {
        const size = fs.statSync(pdfPath).size;
        console.log(`✅ SUCCESS: PDF Generated! Size: ${size} bytes`);
        fs.copyFileSync(pdfPath, publicPdfPath);
        console.log(`✅ Copied to public download path: ${publicPdfPath}`);
    } else {
        console.error('❌ PDF file was not created.');
    }
    try {
        fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch (e) {}
});
