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
import * as gpu from "./gpu.js";

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

const startGpu = new SlashCommandBuilder()
  .setName("start-gpu")
  .setDescription("Начать прокачку видеокарты")
  .addStringOption((o) =>
    o
      .setName("branch")
      .setDescription("Ветка развития")
      .setRequired(true)
      .addChoices(
        ...Object.entries(gpu.BRANCHES).map(([value, b]) => ({ name: b.label, value })),
      ),
  );

const gpuCmd = new SlashCommandBuilder()
  .setName("gpu")
  .setDescription("Показать видеокарту и прогресс")
  .addUserOption((o) => o.setName("user").setDescription("Чья карта (по умолчанию ваша)"))
  .addBooleanOption((o) => o.setName("public").setDescription("Показать всем в чате"));

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

  await c.application.commands.set([myStatus.toJSON(), startGpu.toJSON(), gpuCmd.toJSON()]);

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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  database.updateActivity(message.author.id);

  if (!message.member) return;
  try {
    const result = gpu.addMessageXp(message.author.id);
    if (!result?.newCard) return;

    await gpu.syncRole(message.member, result.row).catch((e) => console.log("Не удалось выдать роль:", e.message));
    // Приватно: в ЛС (ephemeral в обычном чате у ботов невозможен)
    await message.author
      .send(
        `🎉 Ваша видеокарта была обновлена! Теперь у вас **${result.newCard.name}**.\n` +
          `Состояние:\n${gpu.describeDefects(result.row)}`,
      )
      .catch(() => undefined);
  } catch (e) {
    console.log("Ошибка начисления XP:", e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "my_status") {
    database.updateActivity(interaction.user.id);
    await interaction.reply({
      content: "Твоя активность обновлена в базе! Таймер сброшен. 😎",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "start-gpu") {
    if (database.getGpu(interaction.user.id)) {
      await interaction.reply({
        content: "Вы уже начали игру! Посмотреть прогресс: `/gpu`",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const branch = interaction.options.getString("branch", true);
    if (!gpu.isBranch(branch)) return;
    database.createGpu(interaction.user.id, branch);
    await interaction.reply({
      content:
        `Вы выбрали ветку **${gpu.BRANCHES[branch].label}**. Пока у вас встройка — копите XP ` +
        `сообщениями на **${gpu.BRANCHES[branch].cards[0].name}**! Прогресс: \`/gpu\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "gpu") {
    const target = interaction.options.getUser("user") ?? interaction.user;
    const isPublic = interaction.options.getBoolean("public") ?? false;
    const row = database.getGpu(target.id);
    if (!row) {
      await interaction.reply({
        content:
          target.id === interaction.user.id
            ? "Вы ещё не начали игру. Команда: `/start-gpu`"
            : `${target.username} ещё не начал(а) игру.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      embeds: [gpu.profileEmbed(row, target.username)],
      flags: isPublic ? undefined : MessageFlags.Ephemeral,
    });
  }
});

await client.login(TOKEN);
