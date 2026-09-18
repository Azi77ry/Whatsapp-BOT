const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const axios = require('axios');
const Jimp = require('jimp');

async function blurCommand(sock, chatId, message, quotedMessage) {
    try {
        // Get the image to blur
        let imageBuffer;
        
        if (quotedMessage) {
            // If replying to a message
            if (!quotedMessage.imageMessage) {
                await sock.sendMessage(chatId, { 
                    text: '❌ Please reply to an image message' 
                }, { quoted: message });
                return;
            }
            
            const quoted = {
                message: {
                    imageMessage: quotedMessage.imageMessage
                }
            };
            
            imageBuffer = await downloadMediaMessage(
                quoted,
                'buffer',
                { },
                { }
            );
        } else if (message.message?.imageMessage) {
            // If image is in current message
            imageBuffer = await downloadMediaMessage(
                message,
                'buffer',
                { },
                { }
            );
        } else {
            await sock.sendMessage(chatId, { 
                text: '❌ Please reply to an image or send an image with caption .blur' 
            }, { quoted: message });
            return;
        }

        // Apply blur using Jimp or Sharp
        let blurredImage;
        try {
            const jimpImage = await Jimp.read(imageBuffer);
            jimpImage.resize(800, Jimp.AUTO);
            jimpImage.blur(10);
            blurredImage = await jimpImage.getBufferAsync(Jimp.MIME_JPEG);
        } catch (e) {
            const sharp = require('sharp');
            const resized = await sharp(imageBuffer).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
            blurredImage = await sharp(resized).blur(10).toBuffer();
        }

        // Send the blurred image
        await sock.sendMessage(chatId, {
            image: blurredImage,
            caption: '*[ ✔ ] Image Blurred Successfully*',
            contextInfo: {
                forwardingScore: 1,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363161513685998@newsletter',
                    newsletterName: 'KnightBot MD',
                    serverMessageId: -1
                }
            }
        }, { quoted: message });

    } catch (error) {
        console.error('Error in blur command:', error);
        await sock.sendMessage(chatId, { 
            text: '❌ Failed to blur image. Please try again later.' 
        }, { quoted: message });
    }
}

module.exports = blurCommand; 