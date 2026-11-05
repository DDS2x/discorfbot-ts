import { EmbedBuilder, type GuildMember } from "discord.js";
import * as database from "./database.js";

// ====================== НАСТРОЙКИ (меняйте здесь) ======================

export type Branch = "amd" | "intel" | "nvidia";

export interface Card {
  name: string;
  /** Сколько всего XP нужно, чтобы получить эту карту */
  xpNeeded: number;
  /** Шанс, что карта окажется майненой (0..1) */
  minedChance: number;
}

export const BRANCHES: Record<Branch, { label: string; color: number; cards: Card[] }> = {
  amd: {
    label: "AMD",
    color: 0xed1c24,
    cards: [
      { name: "RX 580", xpNeeded: 300, minedChance: 0.99 },
      { name: "RX 5700 XT", xpNeeded: 800, minedChance: 0.4 },
      { name: "RX 6700 XT", xpNeeded: 1600, minedChance: 0.25 },
      { name: "RX 6800 XT", xpNeeded: 3000, minedChance: 0.2 },
      { name: "RX 7900 XTX", xpNeeded: 5200, minedChance: 0.02 },
      { name: "RX 9070 XT", xpNeeded: 8500, minedChance: 0.01 },
    ],
  },
  intel: {
    label: "Intel",
    color: 0x0071c5,
    cards: [
      { name: "Arc A380", xpNeeded: 300, minedChance: 0.01 },
      { name: "Arc A580", xpNeeded: 800, minedChance: 0.01 },
      { name: "Arc A750", xpNeeded: 1600, minedChance: 0.02 },
      { name: "Arc A770", xpNeeded: 3000, minedChance: 0.02 },
      { name: "Arc B580", xpNeeded: 5200, minedChance: 0.01 },
      { name: "Arc B770", xpNeeded: 8500, minedChance: 0.01 },
    ],
  },
  nvidia: {
    label: "NVIDIA",
    color: 0x76b900,
    cards: [
      { name: "GTX 1060", xpNeeded: 300, minedChance: 0.6 },
      { name: "GTX 1660 Super", xpNeeded: 800, minedChance: 0.15 },
      { name: "RTX 2070", xpNeeded: 1600, minedChance: 0.1 },
      { name: "RTX 3070", xpNeeded: 3000, minedChance: 0.35 },
      { name: "RTX 4080", xpNeeded: 5200, minedChance: 0.02 },
      { name: "RTX 5090", xpNeeded: 8500, minedChance: 0.01 },
    ],
  },
};

export const XP_MIN = 15;
export const XP_MAX = 25;
/** Не чаще одного начисления XP за сообщения раз в это время (защита от спама) */
export const COOLDOWN_MS = 60_000;

/** Штраф к прокачке (в процентах) за майненую карту */
export const MINED_PENALTY = 15;
/** Максимальный суммарный штраф */
export const MAX_PENALTY = 50;

export const DEFECTS = [
  { id: "fans", label: "Убитые кулеры", chance: 0.12, penalty: 5 },
  { id: "paste", label: "Высохшая термопаста", chance: 0.12, penalty: 5 },
  { id: "artifacts", label: "Артефакты на экране", chance: 0.08, penalty: 10 },
  { id: "vram", label: "Умирающая память", chance: 0.06, penalty: 10 },
] as const;

// ========================================================================

const ROLE_PREFIX = "🎮 ";

export function isBranch(value: string): value is Branch {
  return value in BRANCHES;
}

/** Номер ступени: 0 — без карты, 1..N — карта cards[tier-1] */
export function tierForXp(branch: Branch, xp: number): number {
  return BRANCHES[branch].cards.filter((c) => xp >= c.xpNeeded).length;
}

export function penaltyPercent(row: database.GpuRow): number {
  let p = row.mined ? MINED_PENALTY : 0;
  for (const id of row.defects.split(",")) {
    p += DEFECTS.find((d) => d.id === id)?.penalty ?? 0;
  }
  return Math.min(p, MAX_PENALTY);
}

function rollCard(card: Card): { mined: number; defects: string } {
  return {
    mined: Math.random() < card.minedChance ? 1 : 0,
    defects: DEFECTS.filter((d) => Math.random() < d.chance)
      .map((d) => d.id)
      .join(","),
  };
}

const lastXpAt = new Map<string, number>();

export interface XpResult {
  row: database.GpuRow;
  /** Новая карта, если уровень повысился */
  newCard?: Card;
}

/** Начисляет XP за сообщение. Возвращает undefined, если игра не начата или кулдаун. */
export function addMessageXp(userId: string): XpResult | undefined {
  const row = database.getGpu(userId);
  if (!row || !isBranch(row.branch)) return undefined;

  const cards = BRANCHES[row.branch].cards;
  const maxXp = cards[cards.length - 1].xpNeeded;
  if (row.xp >= maxXp) return undefined;

  const now = Date.now();
  if (now - (lastXpAt.get(userId) ?? 0) < COOLDOWN_MS) return undefined;
  lastXpAt.set(userId, now);

  const oldTier = tierForXp(row.branch, row.xp);
  const base = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
  const gained = Math.max(1, Math.round((base * (100 - penaltyPercent(row))) / 100));
  row.xp = Math.min(maxXp, row.xp + gained);

  const newTier = tierForXp(row.branch, row.xp);
  let newCard: Card | undefined;
  if (newTier > oldTier) {
    newCard = cards[newTier - 1];
    const rolled = rollCard(newCard);
    row.mined = rolled.mined;
    row.defects = rolled.defects;
  }
  database.saveGpu(row);
  return { row, newCard };
}

/** Выдаёт роль с названием карты и снимает прошлые карточные роли */
export async function syncRole(member: GuildMember, row: database.GpuRow): Promise<void> {
  if (!isBranch(row.branch)) return;
  const tier = tierForXp(row.branch, row.xp);
  if (tier === 0) return;

  const branch = BRANCHES[row.branch];
  const roleName = ROLE_PREFIX + branch.cards[tier - 1].name;
  const allNames = new Set(
    Object.values(BRANCHES).flatMap((b) => b.cards.map((c) => ROLE_PREFIX + c.name)),
  );

  let role = member.guild.roles.cache.find((r) => r.name === roleName);
  role ??= await member.guild.roles.create({
    name: roleName,
    colors: { primaryColor: branch.color },
    hoist: false,
    reason: "GPU-прокачка",
  });

  const stale = member.roles.cache.filter((r) => allNames.has(r.name) && r.id !== role.id);
  if (stale.size > 0) await member.roles.remove(stale);
  if (!member.roles.cache.has(role.id)) await member.roles.add(role);
}

export function describeDefects(row: database.GpuRow): string {
  const lines: string[] = [];
  if (row.mined) lines.push(`⛏️ Майненая (−${MINED_PENALTY}%)`);
  for (const id of row.defects.split(",")) {
    const d = DEFECTS.find((x) => x.id === id);
    if (d) lines.push(`🔧 ${d.label} (−${d.penalty}%)`);
  }
  return lines.length ? lines.join("\n") : "Нет, карта в идеале ✨";
}

export function profileEmbed(row: database.GpuRow, displayName: string): EmbedBuilder {
  const branchKey = isBranch(row.branch) ? row.branch : "amd";
  const branch = BRANCHES[branchKey];
  const tier = tierForXp(branchKey, row.xp);
  const next = branch.cards[tier];
  const prevXp = tier === 0 ? 0 : branch.cards[tier - 1].xpNeeded;

  let progress = "🏆 Максимальная карта достигнута!";
  if (next) {
    const ratio = (row.xp - prevXp) / (next.xpNeeded - prevXp);
    const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
    progress = `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}  ${row.xp}/${next.xpNeeded} XP\nДалее: **${next.name}**`;
  }

  const embed = new EmbedBuilder()
    .setColor(branch.color)
    .setTitle(`Видеокарта — ${displayName}`)
    .addFields(
      { name: "Ветка", value: branch.label, inline: true },
      {
        name: "Карта",
        value: tier === 0 ? "Нет (встройка)" : `**${branch.cards[tier - 1].name}**`,
        inline: true,
      },
      { name: "Прогресс", value: progress },
    );
  if (tier > 0) {
    embed.addFields({
      name: `Состояние (штраф к XP: −${penaltyPercent(row)}%)`,
      value: describeDefects(row),
    });
  }
  return embed;
}
