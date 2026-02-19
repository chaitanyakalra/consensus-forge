const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot('7967746407:AAEZ5048EHAz9gTr9D1WYYneqUr7conNCWg', {
    polling: true
});

bot.on('message', (msg) => {
    console.log("Message received:", msg.text);
    bot.sendMessage(msg.chat.id, "I am alive 🚀");
});
