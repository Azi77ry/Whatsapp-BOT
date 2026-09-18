const fs = require('fs');
const fsPromises = require('fs/promises');
const fse = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const tempDir = './temp';
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const scheduleFileDeletion = (filePath) => {
    setTimeout(async () => {
        try {
            await fse.remove(filePath);
        } catch (error) {}
    }, 10000);
};

const convertStickerToImage = async (sock, quotedMessage, chatId) => {
    try {
        const stickerMessage = quotedMessage.stickerMessage;
        if (!stickerMessage) {
            await sock.sendMessage(chatId, { text: 'Reply to a sticker with .simage to convert it.' });
            return;
        }

        const stickerFilePath = path.join(tempDir, `sticker_${Date.now()}.webp`);
        const outputImagePath = path.join(tempDir, `converted_image_${Date.now()}.png`);

        const stream = await downloadContentFromMessage(stickerMessage, 'sticker');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        await fsPromises.writeFile(stickerFilePath, buffer);

        // Try sharp if available, else fallback to ffmpeg
        let converted = false;
        try {
            const sharp = require('sharp');
            await sharp(stickerFilePath).toFormat('png').toFile(outputImagePath);
            converted = true;
        } catch (e) {
            // Fallback to ffmpeg
            await new Promise((resolve, reject) => {
                exec(`ffmpeg -y -i "${stickerFilePath}" "${outputImagePath}"`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            converted = true;
        }

        if (fs.existsSync(outputImagePath)) {
            const imageBuffer = await fsPromises.readFile(outputImagePath);
            await sock.sendMessage(chatId, { image: imageBuffer, caption: 'Here is the converted image!' });
        }

        scheduleFileDeletion(stickerFilePath);
        scheduleFileDeletion(outputImagePath);
    } catch (error) {
        console.error('Error converting sticker to image:', error);
        await sock.sendMessage(chatId, { text: 'An error occurred while converting the sticker.' });
    }
};

module.exports = convertStickerToImage;
