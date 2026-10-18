import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, Role, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { detectContactInfo } from '../safety/contact-info';
import { isAllowedIntroVideoUrl } from '../teachers/verification';
import { SEED_TOPICS, SEED_VIDEOS } from './topics.seed';

type Lang = 'uz' | 'ru' | 'en';
export const VIDEO_LANGS: Lang[] = ['uz', 'ru', 'en'];
export const MAX_VIDEOS_PER_TEACHER_PER_TOPIC = 3;

const langOf = (l: string): Lang => (l === 'ru' || l === 'en' ? l : 'uz');
const pick = <T>(o: Record<string, T>, l: Lang): T => (o[l] ?? o.en) as T;

/** The 11-character YouTube id from a watch / short / embed / youtu.be link, or null (Vimeo and unknown shapes). */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host.endsWith('youtube.com')) id = u.searchParams.get('v') ?? (/^\/(embed|shorts|live)\/([^/?]+)/.exec(u.pathname)?.[2] ?? null);
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The numeric id of a Vimeo link (vimeo.com/123 or player.vimeo.com/video/123), or null. */
export function vimeoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith('vimeo.com')) return null;
    const m = /\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The address the phone shows INSIDE the app (privacy-friendly YouTube player, no related videos from other channels). Built here, never taken from user input. */
export function embedUrl(url: string, youtube: string | null): string | null {
  if (youtube) return `https://www.youtube-nocookie.com/embed/${youtube}?rel=0&modestbranding=1&playsinline=1&iv_load_policy=3`;
  const v = vimeoId(url);
  return v ? `https://player.vimeo.com/video/${v}?title=0&byline=0&portrait=0` : null;
}

/** Fisher–Yates on a copy. */
function shuffled<T>(a: T[]): T[] {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

@Injectable()
export class TopicsService implements OnModuleInit {
  private log = new Logger('Topics');
  constructor(private prisma: PrismaService, private clock: ClockService) {}

  /** The starter topics and their questions are written once and kept up to date on every start (idempotent). */
  async onModuleInit() {
    try {
      let pos = 0;
      for (const t of SEED_TOPICS) {
        const topic = await this.prisma.topic.upsert({
          where: { slug: t.slug },
          create: { slug: t.slug, subject: t.subject, level: t.level, position: pos, titles: t.title, summaries: t.summary },
          update: { subject: t.subject, level: t.level, position: pos, titles: t.title, summaries: t.summary },
        });
        pos++;
        let i = 0;
        for (const qn of t.questions) {
          const id = `${t.slug}-${i + 1}`;
          await this.prisma.topicQuestion.upsert({
            where: { id },
            create: { id, topicId: topic.id, position: i, texts: qn.text, options: qn.options as Prisma.InputJsonValue, correct: qn.correct },
            update: { topicId: topic.id, position: i, texts: qn.text, options: qn.options as Prisma.InputJsonValue, correct: qn.correct },
          });
          i++;
        }
      }
      const topics = new Map((await this.prisma.topic.findMany({ select: { id: true, slug: true } })).map((t) => [t.slug, t.id]));
      for (const v of SEED_VIDEOS) {
        const topicId = topics.get(v.topic);
        if (!topicId) continue;
        const have = await this.prisma.topicVideo.findFirst({ where: { topicId, videoId: v.id }, select: { id: true } });
        const data = { title: v.title, lang: v.lang, author: v.author, curated: true, url: `https://youtu.be/${v.id}`, videoId: v.id };
        if (have) await this.prisma.topicVideo.update({ where: { id: have.id }, data });
        else await this.prisma.topicVideo.create({ data: { ...data, topicId, addedById: 'school17' } });
      }
    } catch (e) {
      this.log.warn(`seed skipped: ${(e as Error).message}`);
    }
  }

  private async bySlug(slug: string) {
    const t = await this.prisma.topic.findUnique({ where: { slug } });
    if (!t) throw new NotFoundException('Not found');
    return t;
  }

  // ---------- reading ----------

  async list(actor: Actor, f: { subject?: string; level?: string; q?: string }) {
    const l = langOf(actor.locale);
    const rows = await this.prisma.topic.findMany({
      where: { ...(f.subject ? { subject: f.subject } : {}), ...(f.level ? { level: f.level } : {}) },
      orderBy: { position: 'asc' },
      include: { _count: { select: { questions: true } }, videos: { where: { hidden: false }, select: { id: true } } },
    });
    const needle = (f.q ?? '').trim().toLowerCase();
    const mine = await this.prisma.topicAttempt.groupBy({ by: ['topicId'], where: { userId: actor.id }, _max: { score: true } });
    const best = new Map(mine.map((m) => [m.topicId, m._max.score ?? 0]));
    return rows
      .map((t) => ({ t, title: pick(t.titles as Record<string, string>, l), all: Object.values(t.titles as Record<string, string>).join(' ').toLowerCase() }))
      .filter((x) => !needle || x.all.includes(needle))
      .map(({ t, title }) => ({ slug: t.slug, subject: t.subject, level: t.level, title, videos: t.videos.length, questions: t._count.questions, best: best.has(t.id) ? best.get(t.id)! : null }));
  }

  async detail(actor: Actor, slug: string) {
    const l = langOf(actor.locale);
    const t = await this.bySlug(slug);
    const [videos, qCount, teachers, lb] = await Promise.all([
      this.prisma.topicVideo.findMany({ where: { topicId: t.id, hidden: false }, orderBy: [{ score: 'desc' }, { curated: 'desc' }, { createdAt: 'desc' }], take: 60, include: { votes: { where: { userId: actor.id }, select: { userId: true } } } }),
      this.prisma.topicQuestion.count({ where: { topicId: t.id } }),
      this.prisma.teacherProfile.findMany({
        where: { verificationStatus: VerificationStatus.VERIFIED, user: { status: 'ACTIVE' }, subjects: { has: t.subject } },
        orderBy: [{ ratingBayes: 'desc' }, { ratingCount: 'desc' }], take: 5,
        select: { id: true, headline: true, photoFileId: true, ratingCount: true, ratingSum: true, user: { select: { name: true } } },
      }),
      this.leaderboard(actor, t.id),
    ]);
    // most useful first; at equal votes, videos in the person's own language come before the others (stable sort keeps the picked-first order)
    videos.sort((x, y) => y.score - x.score || Number(y.lang === l) - Number(x.lang === l));
    const authors = await this.prisma.teacherProfile.findMany({ where: { userId: { in: videos.map((v) => v.addedById) } }, select: { id: true, userId: true, user: { select: { name: true } } } });
    const by = new Map(authors.map((a) => [a.userId, a]));
    return {
      slug: t.slug, subject: t.subject, level: t.level,
      title: pick(t.titles as Record<string, string>, l), summary: pick(t.summaries as Record<string, string>, l),
      questions: qCount,
      videos: videos.map((v) => ({
        id: v.id, title: v.title, lang: v.lang, url: v.url, videoId: v.videoId, embed: embedUrl(v.url, v.videoId), votes: v.score, voted: v.votes.length > 0, mine: v.addedById === actor.id,
        curated: v.curated, author: v.author,
        by: !v.curated && by.get(v.addedById) ? { teacherId: by.get(v.addedById)!.id, name: by.get(v.addedById)!.user.name } : null,
      })),
      teachers: teachers.map((p) => ({ id: p.id, name: p.user.name, headline: p.headline, hasPhoto: !!p.photoFileId, rating: p.ratingCount ? Math.round((p.ratingSum / p.ratingCount) * 10) / 10 : null })),
      leaderboard: lb,
    };
  }

  /** Top five best scores (first name and initial only) plus where the caller stands. */
  private async leaderboard(actor: Actor, topicId: string) {
    const all = await this.prisma.topicAttempt.groupBy({ by: ['userId'], where: { topicId }, _max: { score: true }, orderBy: { _max: { score: 'desc' } }, take: 5000 });
    const top = all.slice(0, 5);
    const users = await this.prisma.user.findMany({ where: { id: { in: top.map((x) => x.userId) } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const mine = all.find((x) => x.userId === actor.id);
    const myBest = mine?._max.score ?? null;
    const below = myBest === null ? 0 : all.filter((x) => (x._max.score ?? 0) < myBest).length;
    return {
      players: all.length,
      top: top.map((x, i) => ({ rank: i + 1, name: displayName(names.get(x.userId) ?? null, true), score: x._max.score ?? 0, mine: x.userId === actor.id })),
      best: myBest,
      percentile: myBest !== null && all.length >= 5 ? Math.round((below / all.length) * 100) : null, // "better than N% of players"
    };
  }

  // ---------- videos ----------

  async addVideo(actor: Actor, slug: string, input: { url: string; title: string; lang: string }) {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Only verified teachers can add videos');
    const profile = await this.prisma.teacherProfile.findUnique({ where: { userId: actor.id }, select: { verificationStatus: true, subjects: true } });
    if (profile?.verificationStatus !== VerificationStatus.VERIFIED) throw new ForbiddenException('Only verified teachers can add videos');
    const t = await this.bySlug(slug);
    if (!profile.subjects.includes(t.subject)) throw new ForbiddenException({ message: 'You can add videos to topics of the subjects you teach', code: 'NOT_YOUR_SUBJECT' });
    const url = input.url.trim();
    if (!isAllowedIntroVideoUrl(url)) throw new BadRequestException({ message: 'Only YouTube or Vimeo links are accepted', code: 'VIDEO_URL_NOT_ALLOWED' });
    const title = input.title.trim().replace(/\s+/g, ' ');
    if (title.length < 3 || title.length > 120) throw new BadRequestException('Title must be 3 to 120 characters');
    if (detectContactInfo(title).found) throw new BadRequestException({ message: 'Please keep phone numbers and links out of the title', code: 'CONTACT_INFO_NOT_ALLOWED' });
    if (!VIDEO_LANGS.includes(input.lang as Lang)) throw new BadRequestException('Unknown language');
    const videoId = youtubeId(url);
    if (videoId && (await this.prisma.topicVideo.findFirst({ where: { topicId: t.id, videoId, hidden: false }, select: { id: true } }))) throw new ConflictException({ message: 'This video is already on the topic', code: 'DUPLICATE_VIDEO' });
    const mine = await this.prisma.topicVideo.count({ where: { topicId: t.id, addedById: actor.id, hidden: false } });
    if (mine >= MAX_VIDEOS_PER_TEACHER_PER_TOPIC) throw new ConflictException({ message: `You can add up to ${MAX_VIDEOS_PER_TEACHER_PER_TOPIC} videos to one topic`, code: 'TOO_MANY_VIDEOS' });
    const v = await this.prisma.topicVideo.create({ data: { topicId: t.id, addedById: actor.id, url, videoId, title, lang: input.lang, createdAt: this.clock.now() } });
    return { id: v.id };
  }

  async removeVideo(actor: Actor, id: string) {
    const v = await this.prisma.topicVideo.findUnique({ where: { id } });
    if (!v || v.addedById !== actor.id) throw new NotFoundException('Not found');
    await this.prisma.topicVideo.delete({ where: { id } });
    return { ok: true };
  }

  /** One vote per person; voting again takes it back. Nobody votes for their own video. */
  async vote(actor: Actor, id: string) {
    const v = await this.prisma.topicVideo.findFirst({ where: { id, hidden: false } });
    if (!v) throw new NotFoundException('Not found');
    if (v.addedById === actor.id) throw new ForbiddenException('You cannot vote for your own video');
    const key = { videoId_userId: { videoId: id, userId: actor.id } };
    const had = await this.prisma.topicVideoVote.findUnique({ where: key });
    if (had) await this.prisma.$transaction([this.prisma.topicVideoVote.delete({ where: key }), this.prisma.topicVideo.update({ where: { id }, data: { score: { decrement: 1 } } })]);
    else await this.prisma.$transaction([this.prisma.topicVideoVote.create({ data: { videoId: id, userId: actor.id } }), this.prisma.topicVideo.update({ where: { id }, data: { score: { increment: 1 } } })]);
    const now = await this.prisma.topicVideo.findUniqueOrThrow({ where: { id }, select: { score: true } });
    return { voted: !had, votes: now.score };
  }

  async setHidden(admin: Actor, id: string, hidden: boolean) {
    if (admin.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const r = await this.prisma.topicVideo.updateMany({ where: { id }, data: { hidden } });
    if (!r.count) throw new NotFoundException('Not found');
    return { ok: true };
  }

  // ---------- the check test ----------

  async quiz(actor: Actor, slug: string) {
    const l = langOf(actor.locale);
    const t = await this.bySlug(slug);
    const qs = shuffled(await this.prisma.topicQuestion.findMany({ where: { topicId: t.id }, orderBy: { position: 'asc' } })).slice(0, 5);
    if (!qs.length) throw new NotFoundException('No questions yet');
    return { slug, title: pick(t.titles as Record<string, string>, l), questions: qs.map((q) => ({ id: q.id, text: pick(q.texts as Record<string, string>, l), options: this.optionsOf(q.options, l) })) };
  }

  private optionsOf(raw: unknown, l: Lang): string[] {
    return Array.isArray(raw) ? (raw as string[]) : pick(raw as Record<string, string[]>, l);
  }

  async submit(actor: Actor, slug: string, answers: { id: string; choice: number }[]) {
    const t = await this.bySlug(slug);
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > 20) throw new BadRequestException('Send your answers');
    const ids = Array.from(new Set(answers.map((a) => a.id)));
    const qs = await this.prisma.topicQuestion.findMany({ where: { topicId: t.id, id: { in: ids } } });
    if (qs.length !== ids.length) throw new BadRequestException('Unknown question');
    const byId = new Map(qs.map((q) => [q.id, q]));
    const seen = new Set<string>();
    const results: { id: string; chosen: number; correct: number; right: boolean }[] = [];
    for (const a of answers) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const q = byId.get(a.id)!;
      results.push({ id: q.id, chosen: Number.isInteger(a.choice) ? a.choice : -1, correct: q.correct, right: a.choice === q.correct });
    }
    const score = results.filter((r) => r.right).length;
    await this.prisma.topicAttempt.create({ data: { topicId: t.id, userId: actor.id, score, total: results.length, createdAt: this.clock.now() } });
    const lb = await this.leaderboard(actor, t.id);
    return { score, total: results.length, results, best: lb.best, percentile: lb.percentile, players: lb.players };
  }
}
