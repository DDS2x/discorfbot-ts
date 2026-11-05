import "dotenv/config";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
} from "discord.js";
import * as database from "./database.js";

const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error("В .env не задан TOKEN");

const DAY_MS = 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const myStatus = new SlashCommandBuilder()
  .setName("my_status")
  .setDescription("Проверить, видит ли бот вашу активность");

async function checkActivity(): Promise<void> {
  console.log("Выполняется проверка активности в базе...");
  const now = new Date();
  const users = database.getAllUsers();

  for (const guild of client.guilds.cache.values()) {
    for (const row of users) {
      let member;
      try {
        member = await guild.members.fetch(row.user_id);
      } catch (err) {
        if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMember) {
          database.deleteUser(row.user_id);
        }
        continue;
      }

      if (member.user.bot) continue;

      const lastMsg = database.parseDate(row.last_message_date);

      if (!row.warned && now.getTime() - lastMsg.getTime() > 30 * DAY_MS) {
        try {
          await member.send("эй. Ты скоро напишешь? :(");
          console.log(`Предупреждение отправлено в ЛС пользователю ${member.user.username}`);
        } catch {
          console.log(`Не удалось написать в ЛС ${member.user.username} (закрытый профиль)`);
        }
        database.setWarned(row.user_id, database.formatDate(now));
      } else if (row.warned && row.warned_date) {
        const warnedDate = database.parseDate(row.warned_date);
        if (now.getTime() - warnedDate.getTime() > 4 * DAY_MS) {
          try {
            await member.kick("Неактивность более 30 дней + 4 дня игнора");
            console.log(`🛑 Пользователь ${member.user.username} успешно кикнут за неактивность!`);
            database.deleteUser(row.user_id);
          } catch {
            console.log(`Не хватает прав, чтобы кикнуть ${member.user.username}. Проверьте роли бота!`);
          }
        }
      }
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  database.initDb();
  console.log(`Бот-чистильщик ${c.user.tag} успешно ожил!`);

  await c.application.commands.set([myStatus.toJSON()]);

  for (const guild of c.guilds.cache.values()) {
    const me = guild.members.me;
    const channel = guild.channels.cache.find(
      (ch) =>
        ch.type === ChannelType.GuildText &&
        me !== null &&
        ch.permissionsFor(me).has(PermissionFlagsBits.SendMessages),
    );
    if (channel?.isTextBased()) {
      await channel.send("Всем привет!");
      console.log(`Отправлено приветствие в канал: #${channel.name}`);
      break;
    }
  }

  void checkActivity();
  setInterval(() => void checkActivity(), DAY_MS);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  database.updateActivity(message.author.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "my_status") return;
  database.updateActivity(interaction.user.id);
  await interaction.reply({
    content: "Твоя активность обновлена в базе! Таймер сброшен. 😎",
    flags: MessageFlags.Ephemeral,
  });
});

await client.login(TOKEN);
