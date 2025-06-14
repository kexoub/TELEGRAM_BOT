import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import util from "util";
import dotenv from 'dotenv'

dotenv.config();

// 获取当前模块的文件名和目录名
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 创建日志目录
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// 创建带时间戳的日志写入流
const createLogStream = (prefix) => {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
  return fs.createWriteStream(path.join(logDir, `${prefix}_${dateStr}.log`), { flags: 'a' });
};

const adminLogStream = createLogStream('admin');
const chatLogStream = createLogStream('chat');
const errorLogStream = createLogStream('error');

// 日志函数
const log = (stream, message, data = {}) => {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}${Object.keys(data).length > 0 ? '\n' + util.inspect(data, {depth: null}) : ''}\n\n`;
  stream.write(logMessage);
};

// 从环境变量获取配置
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS.split(',').map(id => parseInt(id.trim()));
const HF_WEATHER_API_KEY = process.env.HF_WEATHER_API_KEY;
const HITOKOTO_API_URL = process.env.HITOKOTO_API_URL;

// 检查环境变量是否加载成功
if (!TELEGRAM_TOKEN || ADMIN_USER_IDS.length === 0 || !HF_WEATHER_API_KEY || !HITOKOTO_API_URL) {
  console.error("❌ 环境变量配置错误！请检查 .env 文件");
  process.exit(1);
}

// 群组设置存储
const groupSettings = new Map();

// 初始化默认群组设置
const initGroupSettings = (chatId) => {
  if (!groupSettings.has(chatId)) {
    groupSettings.set(chatId, {
      verificationMode: 'captcha',
      welcomeMessage: '👋 欢迎 {name} 加入群组！请完成人机验证。',
      rules: '🚫 禁止广告\n🚫 禁止人身攻击\n🚫 禁止敏感内容',
      captchaTimeout: 5,
      pendingVerifications: new Map(),
      punishments: new Map()
    });
  }
  return groupSettings.get(chatId);
};

// 创建机器人实例
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: true,
  request: {
    timeout: 15000,
    agentOptions: {
      minVersion: 'TLSv1.2'
    }
  }
});

// 获取天气信息
const getWeather = async (location) => {
  try {
    // 获取地点ID
    const geoUrl = `https://geoapi.qweather.com/v2/city/lookup?key=${HF_WEATHER_API_KEY}&location=${encodeURIComponent(location)}`;
    const geoResponse = await axios.get(geoUrl);
    
    if (!geoResponse.data || !geoResponse.data.location || geoResponse.data.location.length === 0) {
      return null;
    }
    
    const locationId = geoResponse.data.location[0].id;
    const cityName = `${geoResponse.data.location[0].name}, ${geoResponse.data.location[0].adm2}`;
    
    // 获取实时天气
    const weatherUrl = `https://api.qweather.com/v7/weather/now?key=${HF_WEATHER_API_KEY}&location=${locationId}`;
    const weatherResponse = await axios.get(weatherUrl);
    
    if (!weatherResponse.data || !weatherResponse.data.now) {
      return null;
    }
    
    return {
      city: cityName,
      temp: weatherResponse.data.now.temp,
      feelsLike: weatherResponse.data.now.feelsLike,
      text: weatherResponse.data.now.text,
      windDir: weatherResponse.data.now.windDir,
      windScale: weatherResponse.data.now.windScale,
      humidity: weatherResponse.data.now.humidity,
      obsTime: weatherResponse.data.now.obsTime
    };
  } catch (error) {
    log(errorLogStream, "获取天气失败", { error: error.message });
    return null;
  }
};

// 记录用户消息
const logUserMessage = (msg) => {
  const user = msg.from;
  const chat = msg.chat;
  const message = {
    userId: user.id,
    username: user.username || `${user.first_name}${user.last_name ? ` ${user.last_name}` : ''}`,
    chatId: chat.id,
    chatType: chat.type,
    text: msg.text || '',
    date: new Date(msg.date * 1000).toISOString()
  };
  
  log(chatLogStream, "用户消息", message);
};

// 记录管理操作
const logAdminAction = (adminId, action, targetUserId, groupId, details) => {
  log(adminLogStream, "管理操作", {
    adminId,
    action,
    targetUserId,
    groupId,
    details
  });
};

// 检查用户是否是管理员
const isAdmin = (userId, chatId) => {
  if (ADMIN_USER_IDS.includes(userId)) return true;
  return false;
};

// 获取用户展示名称
const getUserDisplayName = (user) => {
  return user.username ? `@${user.username}` : `${user.first_name}${user.last_name ? ` ${user.last_name}` : ''}`;
};

// 生成随机验证码
const generateCaptcha = () => {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let captcha = '';
  for (let i = 0; i < 6; i++) {
    captcha += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return captcha;
};

// 处理新成员加入
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  const settings = initGroupSettings(chatId);
  
  for (const newMember of msg.new_chat_members) {
    if (newMember.is_bot && newMember.id === bot.getMe().then(me => me.id)) continue;
    
    logAdminAction('system', 'new_member', newMember.id, chatId, {
      name: getUserDisplayName(newMember)
    });
    
    // 检查用户是否被封禁
    if (settings.punishments.has(newMember.id)) {
      const punishment = settings.punishments.get(newMember.id);
      if (punishment.type === 'ban' && (punishment.until === -1 || punishment.until > Date.now())) {
        try {
          await bot.banChatMember(chatId, newMember.id);
          logAdminAction('system', 'auto_ban', newMember.id, chatId, {
            reason: punishment.reason
          });
          return;
        } catch (error) {
          log(errorLogStream, "自动封禁失败", { error: error.message });
        }
      }
    }
    
    // 根据群组设置处理新成员
    switch (settings.verificationMode) {
      case 'captcha':
        const captcha = generateCaptcha();
        const captchaMessage = `🔐 *人机验证*\n\n欢迎 ${getUserDisplayName(newMember)}！请回复以下验证码以证明您是人类：\n\n` +
                               `📝 验证码: \`${captcha}\`\n\n` +
                               `⏱️ 您有 ${settings.captchaTimeout} 分钟时间完成验证，否则将被移出群组。`;
        
        try {
          const message = await bot.sendMessage(chatId, captchaMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ 管理员通过", callback_data: `admin_approve_${newMember.id}` },
                  { text: "❌ 管理员拒绝", callback_data: `admin_reject_${newMember.id}` }
                ]
              ]
            }
          });
          
          try {
            await bot.sendMessage(newMember.id, `🔐 *人机验证*\n\n欢迎加入群组 ${msg.chat.title}！请回复以下验证码：\n\n` +
                                                `📝 验证码: \`${captcha}\`\n\n` +
                                                `⏱️ 您有 ${settings.captchaTimeout} 分钟时间完成验证。`);
          } catch (e) {
            await bot.sendMessage(chatId, `⚠️ 无法发送验证码给 ${getUserDisplayName(newMember)}，请确保用户已与机器人对话。`);
          }
          
          settings.pendingVerifications.set(newMember.id, {
            captcha,
            attempts: 0,
            messageId: message.message_id,
            groupId: chatId,
            timer: setTimeout(async () => {
              if (settings.pendingVerifications.has(newMember.id)) {
                try {
                  await bot.kickChatMember(chatId, newMember.id);
                  await bot.sendMessage(chatId, `⏱️ ${getUserDisplayName(newMember)} 因未完成验证已被移出群组。`);
                  logAdminAction('system', 'auto_kick', newMember.id, chatId, { reason: '验证超时' });
                } catch (error) {
                  log(errorLogStream, "自动踢出失败", { error: error.message });
                }
                settings.pendingVerifications.delete(newMember.id);
              }
            }, settings.captchaTimeout * 60 * 1000)
          });
        } catch (error) {
          log(errorLogStream, "发送验证码失败", { error: error.message });
        }
        break;
        
      case 'admin':
        const adminMessage = await bot.sendMessage(chatId, `🆕 新成员 ${getUserDisplayName(newMember)} 申请加入，请管理员审批：`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ 批准加入", callback_data: `approve_${newMember.id}` },
                { text: "❌ 拒绝加入", callback_data: `reject_${newMember.id}` }
              ]
            ]
          }
        });
        
        settings.pendingApprovals = settings.pendingApprovals || new Map();
        settings.pendingApprovals.set(newMember.id, adminMessage.message_id);
        break;
        
      default:
        const welcomeMsg = settings.welcomeMessage.replace('{name}', getUserDisplayName(newMember));
        bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }
  }
});

// 处理成员离开
bot.on('left_chat_member', (msg) => {
  const chatId = msg.chat.id;
  const member = msg.left_chat_member;
  logAdminAction('system', 'member_left', member.id, chatId, {
    name: getUserDisplayName(member)
  });
});

// 处理消息
bot.on('message', async (msg) => {
  logUserMessage(msg);
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';
  
  const settings = initGroupSettings(chatId);
  
  // 处理验证码回复（私聊）
  if (msg.chat.type === 'private' && settings.pendingVerifications.has(userId)) {
    const verification = settings.pendingVerifications.get(userId);
    
    if (text.trim().toUpperCase() === verification.captcha) {
      clearTimeout(verification.timer);
      
      try {
        await bot.sendMessage(userId, `✅ 验证成功！欢迎加入群组。`);
        
        await bot.editMessageText(`✅ ${getUserDisplayName(msg.from)} 已通过人机验证！`, {
          chat_id: verification.groupId,
          message_id: verification.messageId,
          reply_markup: { inline_keyboard: [] }
        });
        
        await bot.sendMessage(verification.groupId, `🎉 欢迎 ${getUserDisplayName(msg.from)} 加入群组！`);
      } catch (error) {
        log(errorLogStream, "处理验证成功时出错", { error: error.message });
      }
      
      settings.pendingVerifications.delete(userId);
    } else {
      verification.attempts++;
      
      if (verification.attempts >= 3) {
        clearTimeout(verification.timer);
        
        try {
          await bot.kickChatMember(verification.groupId, userId);
          await bot.sendMessage(verification.groupId, `❌ ${getUserDisplayName(msg.from)} 因多次验证失败已被移出群组。`);
          logAdminAction('system', 'auto_kick', userId, chatId, { reason: '多次验证失败' });
        } catch (error) {
          log(errorLogStream, "踢出用户失败", { error: error.message });
        }
        
        settings.pendingVerifications.delete(userId);
      } else {
        await bot.sendMessage(userId, `❌ 验证码错误！您还有 ${3 - verification.attempts} 次尝试机会。`);
      }
    }
    return;
  }
  
  // 处理命令
  if (text.startsWith('/')) {
    const [command, ...args] = text.split(' ');
    
    switch (command.toLowerCase()) {
      case '/start':
        bot.sendMessage(chatId, `🤖 欢迎使用高级群组管理机器人！\n\n我是专为群组管理设计的机器人，提供人机验证、成员审批、禁言封禁等功能。\n\n使用 /help 查看帮助信息。`);
        break;
        
      case '/help':
        const helpMsg = `🤖 *群组管理机器人帮助菜单*\n\n` +
                       `*👮 管理命令* (仅管理员可用):\n` +
                       `/kick [回复用户消息] [原因] - 踢出用户\n` +
                       `  示例: /kick 发布广告\n` +
                       `/ban [回复用户消息] [原因] - 永久封禁用户\n` +
                       `  示例: /ban 多次违规\n` +
                       `/mute [回复用户消息] [时长(分钟)] [原因] - 禁言用户\n` +
                       `  示例: /mute 60 发布无关内容\n` +
                       `/unmute [回复用户消息] - 解除禁言\n` +
                       `/warn [回复用户消息] [原因] - 警告用户\n` +
                       `/verify_mode [captcha|admin|none] - 设置新成员验证模式\n` +
                       `  示例: /verify_mode captcha\n\n` +
                       `*⚙️ 群组设置命令* (仅管理员可用):\n` +
                       `/set_welcome [消息] - 设置欢迎消息\n` +
                       `  示例: /set_welcome 欢迎 {name} 加入群组！\n` +
                       `/set_rules [规则] - 设置群规\n` +
                       `  示例: /set_rules 1.禁止广告 2.保持友好\n` +
                       `/set_captcha_timeout [分钟] - 设置验证超时时间\n` +
                       `  示例: /set_captcha_timeout 3\n\n` +
                       `*👤 用户命令* (所有成员可用):\n` +
                       `/weather - 查看天气\n` +
                       `/rules - 查看群组规则\n` +
                       `/report [回复用户消息] [原因] - 举报违规用户\n` +
                       `/mywarns - 查看我的警告记录\n\n` +
                       `*ℹ️ 系统信息*:\n` +
                       `当前验证模式: ${settings.verificationMode}\n` +
                       `验证超时时间: ${settings.captchaTimeout}分钟`;
        
        bot.sendMessage(chatId, helpMsg, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "📚 查看完整文档", url: "https://example.com/docs" }]
            ]
          }
        });
        break;
        
      case '/rules':
        bot.sendMessage(chatId, `📜 *群组规则*\n\n${settings.rules}`, { parse_mode: 'Markdown' });
        break;
        
      // 管理员命令
      case '/kick':
        if (!isAdmin(userId, chatId)) return;
        
        if (msg.reply_to_message) {
          const targetUser = msg.reply_to_message.from;
          const reason = args.join(' ') || '未提供原因';
          
          try {
            await bot.banChatMember(chatId, targetUser.id);
            await bot.unbanChatMember(chatId, targetUser.id);
            bot.sendMessage(chatId, `🚫 ${getUserDisplayName(targetUser)} 已被踢出群组。\n原因: ${reason}`);
            logAdminAction(userId, 'kick', targetUser.id, chatId, { reason });
          } catch (error) {
            log(errorLogStream, "踢出用户失败", { error: error.message });
          }
        } else {
          bot.sendMessage(chatId, "请回复要踢出的用户消息使用此命令");
        }
        break;
        
      case '/ban':
        if (!isAdmin(userId, chatId)) return;
        
        if (msg.reply_to_message) {
          const targetUser = msg.reply_to_message.from;
          const reason = args.join(' ') || '未提供原因';
          
          try {
            await bot.banChatMember(chatId, targetUser.id);
            bot.sendMessage(chatId, `🔒 ${getUserDisplayName(targetUser)} 已被永久封禁。\n原因: ${reason}`);
            
            settings.punishments.set(targetUser.id, {
              type: 'ban',
              reason,
              until: -1,
              by: userId,
              timestamp: Date.now()
            });
            
            logAdminAction(userId, 'ban', targetUser.id, chatId, { reason });
          } catch (error) {
            log(errorLogStream, "封禁用户失败", { error: error.message });
          }
        } else {
          bot.sendMessage(chatId, "请回复要封禁的用户消息使用此命令");
        }
        break;
      
      // 天气服务
      case '/weather':
      case '天气':
        const location = args.join(' ');
        if (!location) {
          bot.sendMessage(chatId, '请提供城市名称，例如: /weather 北京 或 天气 上海');
          break;
        }
        
        bot.sendChatAction(chatId, 'typing');
        const weatherData = await getWeather(location);
        
        if (weatherData) {
          const weatherMsg = `🌤️ *${weatherData.city} 天气*\n\n` +
                            `🕒 更新时间: ${new Date(weatherData.obsTime).toLocaleString()}\n` +
                            `🌡️ 温度: ${weatherData.temp}°C (体感: ${weatherData.feelsLike}°C)\n` +
                            `📝 天气状况: ${weatherData.text}\n` +
                            `💨 风力: ${weatherData.windDir} ${weatherData.windScale}级\n` +
                            `💧 湿度: ${weatherData.humidity}%`;
          
          bot.sendMessage(chatId, weatherMsg, { parse_mode: 'Markdown' });
        } else {
          bot.sendMessage(chatId, `无法获取 ${location} 的天气信息，请检查城市名称是否正确`);
        }
        break;    
        
      case '/mute':
        if (!isAdmin(userId, chatId)) return;
        
        if (msg.reply_to_message) {
          const targetUser = msg.reply_to_message.from;
          const duration = parseInt(args[0]) || 60;
          const reason = args.slice(1).join(' ') || '未提供原因';
          
          try {
            await bot.restrictChatMember(chatId, targetUser.id, {
              permissions: {
                can_send_messages: false,
                can_send_media_messages: false,
                can_send_polls: false,
                can_send_other_messages: false,
                can_add_web_page_previews: false,
                can_change_info: false,
                can_invite_users: false,
                can_pin_messages: false
              },
              until_date: Math.floor(Date.now() / 1000) + duration * 60
            });
            
            bot.sendMessage(chatId, `🔇 ${getUserDisplayName(targetUser)} 已被禁言 ${duration} 分钟。\n原因: ${reason}`);
            
            settings.punishments.set(targetUser.id, {
              type: 'mute',
              reason,
              duration: duration * 60,
              until: Date.now() + duration * 60 * 1000,
              by: userId,
              timestamp: Date.now()
            });
            
            logAdminAction(userId, 'mute', targetUser.id, chatId, { duration, reason });
          } catch (error) {
            log(errorLogStream, "禁言用户失败", { error: error.message });
          }
        } else {
          bot.sendMessage(chatId, "请回复要禁言的用户消息使用此命令");
        }
        break;
        
      case '/unmute':
        if (!isAdmin(userId, chatId)) return;
        
        if (msg.reply_to_message) {
          const targetUser = msg.reply_to_message.from;
          
          try {
            await bot.restrictChatMember(chatId, targetUser.id, {
              permissions: {
                can_send_messages: true,
                can_send_media_messages: true,
                can_send_polls: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
                can_change_info: true,
                can_invite_users: true,
                can_pin_messages: true
              }
            });
            
            bot.sendMessage(chatId, `🔊 ${getUserDisplayName(targetUser)} 的禁言已解除。`);
            
            if (settings.punishments.has(targetUser.id)) {
              settings.punishments.delete(targetUser.id);
            }
            
            logAdminAction(userId, 'unmute', targetUser.id, chatId);
          } catch (error) {
            log(errorLogStream, "解除禁言失败", { error: error.message });
          }
        } else {
          bot.sendMessage(chatId, "请回复要解除禁言的用户消息使用此命令");
        }
        break;
        
      case '/warn':
        if (!isAdmin(userId, chatId)) return;
        
        if (msg.reply_to_message) {
          const targetUser = msg.reply_to_message.from;
          const reason = args.join(' ') || '未提供原因';
          
          settings.punishments.set(targetUser.id, {
            type: 'warn',
            reason,
            by: userId,
            timestamp: Date.now()
          });
          
          bot.sendMessage(chatId, `⚠️ ${getUserDisplayName(targetUser)} 已收到警告。\n原因: ${reason}`);
          bot.sendMessage(targetUser.id, `⚠️ 您在群组 ${msg.chat.title} 中收到警告:\n${reason}`);
          
          logAdminAction(userId, 'warn', targetUser.id, chatId, { reason });
        } else {
          bot.sendMessage(chatId, "请回复要警告的用户消息使用此命令");
        }
        break;
        
      case '/verify_mode':
        if (!isAdmin(userId, chatId)) return;
        
        const mode = args[0]?.toLowerCase();
        if (mode && ['captcha', 'admin', 'none'].includes(mode)) {
          settings.verificationMode = mode;
          bot.sendMessage(chatId, `✅ 验证模式已设置为: ${mode}`);
        } else {
          bot.sendMessage(chatId, "请指定验证模式: captcha, admin 或 none");
        }
        break;
        
      case '/set_welcome':
        if (!isAdmin(userId, chatId)) return;
        
        const welcomeMsg = args.join(' ');
        if (welcomeMsg) {
          settings.welcomeMessage = welcomeMsg;
          bot.sendMessage(chatId, `✅ 欢迎消息已更新:\n${welcomeMsg}`);
        } else {
          bot.sendMessage(chatId, "请提供欢迎消息内容，例如: /set_welcome 欢迎 {name} 加入群组！");
        }
        break;
        
      case '/set_rules':
        if (!isAdmin(userId, chatId)) return;
        
        const rules = args.join(' ');
        if (rules) {
          settings.rules = rules;
          bot.sendMessage(chatId, `✅ 群规已更新:\n${rules}`);
        } else {
          bot.sendMessage(chatId, "请提供群规内容，例如: /set_rules 1. 禁止广告 2. 禁止人身攻击");
        }
        break;
        
      case '/set_captcha_timeout':
        if (!isAdmin(userId, chatId)) return;
        
        const timeout = parseInt(args[0]);
        if (timeout && timeout > 0) {
          settings.captchaTimeout = timeout;
          bot.sendMessage(chatId, `✅ 验证超时时间已设置为: ${timeout}分钟`);
        } else {
          bot.sendMessage(chatId, "请指定验证超时时间(分钟)，例如: /set_captcha_timeout 5");
        }
        break;
    }
  }
});

// 处理回调查询
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const settings = initGroupSettings(chatId);
  
  try {
    if (data.startsWith('admin_approve_')) {
      if (!isAdmin(userId, chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "只有管理员可以操作" });
        return;
      }
      
      const targetUserId = parseInt(data.split('_')[2]);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "已批准成员" });
      
      await bot.editMessageText(`✅ ${getUserDisplayName(callbackQuery.from)} 已批准新成员加入`, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
      
      bot.sendMessage(chatId, `🎉 欢迎新成员加入群组！`);
      
      if (settings.pendingVerifications.has(targetUserId)) {
        clearTimeout(settings.pendingVerifications.get(targetUserId).timer);
        settings.pendingVerifications.delete(targetUserId);
      }
      
      logAdminAction(userId, 'admin_approve', targetUserId, chatId);
    }
    
    else if (data.startsWith('admin_reject_')) {
      if (!isAdmin(userId, chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "只有管理员可以操作" });
        return;
      }
      
      const targetUserId = parseInt(data.split('_')[2]);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "已拒绝成员" });
      
      await bot.editMessageText(`❌ ${getUserDisplayName(callbackQuery.from)} 已拒绝新成员加入`, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
      
      await bot.banChatMember(chatId, targetUserId);
      
      if (settings.pendingVerifications.has(targetUserId)) {
        clearTimeout(settings.pendingVerifications.get(targetUserId).timer);
        settings.pendingVerifications.delete(targetUserId);
      }
      
      logAdminAction(userId, 'admin_reject', targetUserId, chatId);
    }
    
    else if (data.startsWith('approve_')) {
      if (!isAdmin(userId, chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "只有管理员可以审批" });
        return;
      }
      
      const targetUserId = parseInt(data.split('_')[1]);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "成员已批准" });
      
      await bot.editMessageText(`✅ ${getUserDisplayName(callbackQuery.from)} 已批准新成员加入`, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id
      });
      
      bot.sendMessage(chatId, `🎉 欢迎新成员加入群组！`);
      
      if (settings.pendingApprovals) {
        settings.pendingApprovals.delete(targetUserId);
      }
      
      logAdminAction(userId, 'approve', targetUserId, chatId);
    }
    
    else if (data.startsWith('reject_')) {
      if (!isAdmin(userId, chatId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: "只有管理员可以审批" });
        return;
      }
      
      const targetUserId = parseInt(data.split('_')[1]);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "成员已拒绝" });
      
      await bot.editMessageText(`❌ ${getUserDisplayName(callbackQuery.from)} 已拒绝新成员加入`, {
        chat_id: chatId,
        message_id: callbackQuery.message.message_id
      });
      
      await bot.banChatMember(chatId, targetUserId);
      
      if (settings.pendingApprovals) {
        settings.pendingApprovals.delete(targetUserId);
      }
      
      logAdminAction(userId, 'reject', targetUserId, chatId);
    }
  } catch (error) {
    log(errorLogStream, "处理回调时出错", { 
      data, 
      error: error.message, 
      stack: error.stack 
    });
    bot.answerCallbackQuery(callbackQuery.id, { text: "处理请求时出错" });
  }
});

// 处理轮询错误
bot.on('polling_error', (error) => {
  log(errorLogStream, `[Polling Error]: ${error.code} - ${error.message}`, { stack: error.stack });
});

// 记录未捕获的异常
process.on('uncaughtException', (error) => {
  log(errorLogStream, "未捕获的异常", { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason, promise) => {
  log(errorLogStream, "未处理的Promise拒绝", { reason: reason instanceof Error ? reason.stack : reason });
});

log(adminLogStream, "人机验证群组管理系统已启动");