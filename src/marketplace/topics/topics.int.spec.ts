import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';
import { SEED_TOPICS, SEED_VIDEOS } from './topics.seed';
import { embedUrl, vimeoId, youtubeId } from './topics.service';

describe('topics: pure rules', () => {
  it('reads the YouTube id from every common link shape and nothing from other links', () => {
    assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=5'), 'dQw4w9WgXcQ');
    assert.equal(youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youtubeId('https://vimeo.com/123456'), null);
    assert.equal(youtubeId('https://www.youtube.com/watch?v=short'), null);
    assert.equal(youtubeId('not a url'), null);
  });
  it('embed addresses are built from the id, never from the link the teacher typed', () => {
    assert.equal(embedUrl('https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ')?.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?'), true);
    assert.equal(vimeoId('https://vimeo.com/123456789'), '123456789');
    assert.equal(vimeoId('https://player.vimeo.com/video/123456789'), '123456789');
    assert.equal(vimeoId('https://example.com/123456789'), null);
    assert.equal(embedUrl('https://vimeo.com/123456789', null), 'https://player.vimeo.com/video/123456789?title=0&byline=0&portrait=0');
    assert.equal(embedUrl('https://example.com/x', null), null);
  });
  it('the picked videos are well formed: known topic, 11-character id, no duplicates, every topic has at least two', () => {
    const slugs = new Set(SEED_TOPICS.map((x) => x.slug));
    const ids = new Set<string>();
    for (const v of SEED_VIDEOS) {
      assert.ok(slugs.has(v.topic), v.topic);
      assert.match(v.id, /^[\w-]{11}$/);
      assert.ok(['uz', 'ru', 'en'].includes(v.lang));
      assert.ok(v.title.length >= 3 && v.author.length >= 2);
      assert.equal(ids.has(`${v.topic}/${v.id}`), false, 'duplicate');
      ids.add(`${v.topic}/${v.id}`);
    }
    for (const t of SEED_TOPICS) assert.ok(SEED_VIDEOS.filter((v) => v.topic === t.slug).length >= 2, t.slug);
  });
  it('the starter content is consistent: every correct index exists and every language is filled', () => {
    for (const t of SEED_TOPICS) {
      assert.ok(t.title.en && t.title.ru && t.title.uz, t.slug);
      assert.ok(t.summary.en && t.summary.ru && t.summary.uz, t.slug);
      assert.equal(t.questions.length, 4, t.slug);
      for (const q of t.questions) {
        assert.ok(q.text.en && q.text.ru && q.text.uz, t.slug);
        for (const l of ['en', 'ru', 'uz'] as const) {
          const o = Array.isArray(q.options) ? q.options : q.options[l];
          assert.equal(o.length, 4, `${t.slug} ${l}`);
          assert.ok(q.correct >= 0 && q.correct < o.length, `${t.slug} ${l}`);
          assert.equal(new Set(o).size, 4, `${t.slug} ${l} options are distinct`);
        }
      }
    }
  });
});

const rid = () => Array.from({ length: 11 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[Math.floor(Math.random() * 64)]).join('');

describe('topics (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => { t = await createTestApp(); admin = await makeAdmin(t); });
  after(async () => { await t.close(); });

  it('the starter topics are there and can be searched and filtered; the list needs a sign-in', async () => {
    const pupil = await makeUser(t, Role.STUDENT);
    const all = (await api(t, pupil.token).get('/topics')).body;
    assert.ok(all.length >= 10);
    assert.ok(all.every((x: any) => x.slug && x.title && x.questions === 4 && x.best === null));
    const math = (await api(t, pupil.token).get('/topics?subject=math')).body;
    assert.ok(math.length >= 4 && math.every((x: any) => x.subject === 'math'));
    const found = (await api(t, pupil.token).get('/topics?q=newton')).body;
    assert.deepEqual(found.map((x: any) => x.slug), ['newtons-laws']);
    assert.equal((await fetch(t.baseUrl + '/topics')).status, 401);
  });

  it('a topic page shows the verified teachers of that subject and its video list; unknown slugs are 404', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } }); // teaches math
    await t.prisma.teacherProfile.update({ where: { id: x.profileId }, data: { ratingBayes: Date.now() / 1000, ratingCount: 50, ratingSum: 245 } }); // the shared test database holds many math teachers: be at the top
    const pupil = await makeUser(t, Role.STUDENT);
    const d = (await api(t, pupil.token).get('/topics/fractions')).body;
    assert.equal(d.slug, 'fractions');
    assert.equal(d.questions, 4);
    assert.ok(d.videos.length >= 2, 'picked videos are there from the start');
    assert.ok(d.videos.every((v: any) => v.embed && v.embed.startsWith('https://')));
    assert.equal(d.videos[0].lang, 'uz', 'a pupil using Uzbek sees the Uzbek videos first (equal votes)');
    assert.ok(d.videos.some((v: any) => v.curated && v.author && v.by === null), 'picked videos credit the channel, not a teacher');
    assert.equal(d.teachers[0].id, x.profileId, 'best-rated first');
    assert.equal(d.teachers[0].rating, 4.9);
    assert.equal((await api(t, pupil.token).get('/topics/nope-nope')).status, 404);
  });

  it('only verified teachers add videos; links are YouTube/Vimeo only; no duplicates, no contact details, at most three each', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const draft = await makeTeacher(t, { submit: true });
    const pupil = await makeUser(t, Role.STUDENT);
    const base = '/topics/percentages/videos';
    const id1 = rid();
    const ok = { url: `https://www.youtube.com/watch?v=${id1}`, title: 'Percent of a number in 5 minutes', lang: 'uz' };
    assert.equal((await api(t, pupil.token).post(base, ok)).status, 403, 'pupils cannot add');
    assert.equal((await api(t, draft.user.token).post(base, ok)).status, 403, 'unverified teachers cannot add');
    assert.equal((await api(t, x.user.token).post(base, { ...ok, url: 'https://example.com/video.mp4' })).status, 400);
    assert.equal((await api(t, x.user.token).post(base, { ...ok, title: 'Call me +998 90 123 45 67' })).status, 400);
    assert.equal((await api(t, x.user.token).post(base, { ...ok, title: 'ab' })).status, 400);
    assert.equal((await api(t, x.user.token).post(base, { ...ok, lang: 'xx' })).status, 400);
    const english = await t.prisma.topic.findUniqueOrThrow({ where: { slug: 'articles' } }); // x teaches math only
    assert.equal(english.subject, 'english');
    assert.equal((await api(t, x.user.token).post('/topics/articles/videos', ok)).status, 403, 'only for the subjects you teach');
    assert.equal((await api(t, x.user.token).post(base, ok)).status, 201);
    assert.equal((await api(t, x.user.token).post(base, { ...ok, url: `https://youtu.be/${id1}` })).status, 409, 'same video, other link shape');
    assert.equal((await api(t, x.user.token).post(base, { ...ok, url: `https://youtu.be/${rid()}`, title: 'Second one' })).status, 201);
    assert.equal((await api(t, x.user.token).post(base, { ...ok, url: `https://vimeo.com/${Math.floor(Math.random() * 1e9)}`, title: 'Third one' })).status, 201);
    assert.equal((await api(t, x.user.token).post(base, { ...ok, url: `https://youtu.be/${rid()}`, title: 'Fourth one' })).status, 409, 'three per topic');
    const d = (await api(t, pupil.token).get('/topics/percentages')).body;
    const mineHere = d.videos.filter((v: any) => v.by?.teacherId === x.profileId);
    assert.equal(mineHere.length, 3);
  });

  it('votes: one per person, a second tap takes it back, never for your own video; the best-voted video comes first; the owner can remove', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const a = await makeUser(t, Role.STUDENT);
    const b = await makeUser(t, Role.STUDENT);
    const mk = async (u: string, title: string) => (await api(t, x.user.token).post('/topics/linear-equations/videos', { url: `https://youtu.be/${u}`, title, lang: 'en' })).body.id as string;
    const v1 = await mk(rid(), 'First video');
    const v2 = await mk(rid(), 'Second video');
    assert.equal((await api(t, x.user.token).post(`/topics/videos/${v1}/vote`)).status, 403, 'not for your own video');
    assert.deepEqual((await api(t, a.token).post(`/topics/videos/${v2}/vote`)).body, { voted: true, votes: 1 });
    assert.deepEqual((await api(t, b.token).post(`/topics/videos/${v2}/vote`)).body, { voted: true, votes: 2 });
    assert.deepEqual((await api(t, b.token).post(`/topics/videos/${v2}/vote`)).body, { voted: false, votes: 1 }, 'tap again to take it back');
    const list = (await api(t, a.token).get('/topics/linear-equations')).body.videos;
    assert.ok(list.findIndex((v: any) => v.id === v2) < list.findIndex((v: any) => v.id === v1), 'more votes come first');
    assert.equal(list.find((v: any) => v.id === v2).voted, true);
    assert.equal((await api(t, x.user.token).get('/topics/linear-equations')).body.videos.find((v: any) => v.id === v1).mine, true, 'the author sees which ones are theirs');
    const other = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, other.user.token).del(`/topics/videos/${v1}`)).status, 404, 'only the owner removes');
    assert.equal((await api(t, x.user.token).del(`/topics/videos/${v1}`)).status, 200);
    assert.equal((await api(t, a.token).get('/topics/linear-equations')).body.videos.some((v: any) => v.id === v1), false);
  });

  it('an admin can hide and restore a video', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const pupil = await makeUser(t, Role.STUDENT);
    const id = (await api(t, x.user.token).post('/topics/quadratic-equations/videos', { url: `https://youtu.be/${rid()}`, title: 'Articles explained', lang: 'en' })).body.id;
    assert.equal((await api(t, pupil.token).post(`/admin/market/topics/videos/${id}/hide`)).status, 401, 'users are not admins');
    assert.equal((await api(t, admin.token).post(`/admin/market/topics/videos/${id}/hide`)).status, 200);
    const has = async () => (await api(t, pupil.token).get('/topics/quadratic-equations')).body.videos.some((v: any) => v.id === id);
    assert.equal(await has(), false);
    assert.equal((await api(t, admin.token).post(`/admin/market/topics/videos/${id}/restore`)).status, 200);
    assert.equal(await has(), true);
  });

  it('the test: questions never carry the answer; scoring is on the server; unknown or foreign questions are refused; results rank people', async () => {
    const quiz = (await api(t, (await makeUser(t, Role.STUDENT)).token).get('/topics/ohms-law/quiz')).body;
    assert.equal(quiz.questions.length, 4);
    for (const q of quiz.questions) {
      assert.ok(q.text && q.options.length === 4);
      assert.equal('correct' in q, false, 'the answer must not be sent to the phone');
    }
    const rows = await t.prisma.topicQuestion.findMany({ where: { topic: { slug: 'ohms-law' } } });
    const right = new Map(rows.map((r) => [r.id, r.correct]));

    const players: { token: string }[] = [];
    for (let i = 0; i < 6; i++) players.push(await makeUser(t, Role.STUDENT));
    // players 0..4 answer k questions right (4,3,2,1,0); the sixth is the one we inspect (3 right)
    const submit = async (u: { token: string }, k: number) => {
      const q = (await api(t, u.token).get('/topics/ohms-law/quiz')).body.questions;
      const answers = q.map((x: any, i: number) => ({ id: x.id, choice: i < k ? right.get(x.id)! : (right.get(x.id)! + 1) % 4 }));
      return api(t, u.token).post('/topics/ohms-law/quiz', { answers });
    };
    for (let i = 0; i < 5; i++) assert.equal((await submit(players[i], 4 - i)).body.score, 4 - i);
    const r = (await submit(players[5], 3)).body;
    assert.equal(r.score, 3);
    assert.equal(r.total, 4);
    assert.equal(r.results.length, 4);
    assert.ok(r.results.every((x: any) => x.correct >= 0), 'the answers come back after the attempt, for review');
    assert.equal(r.best, 3);
    assert.equal(typeof r.percentile, 'number');
    assert.ok(r.percentile > 0 && r.percentile < 100);

    const d = (await api(t, players[5].token).get('/topics/ohms-law')).body.leaderboard;
    assert.equal(d.best, 3);
    assert.ok(d.top.length <= 5 && d.top[0].score >= d.top[d.top.length - 1].score);
    assert.equal((await api(t, players[5].token).get('/topics')).body.find((x: any) => x.slug === 'ohms-law').best, 3);

    assert.equal((await api(t, players[0].token).post('/topics/ohms-law/quiz', { answers: [{ id: 'nope-1', choice: 0 }] })).status, 400);
    assert.equal((await api(t, players[0].token).post('/topics/ohms-law/quiz', { answers: [{ id: 'fractions-1', choice: 0 }] })).status, 400, 'a question from another topic');
    assert.equal((await api(t, players[0].token).post('/topics/ohms-law/quiz', { answers: [] })).status, 400);
  });

  it('share pages are public, show only public facts and escape everything', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const topic = await fetch(t.baseUrl + '/t/fractions');
    const html = await topic.text();
    assert.equal(topic.status, 200);
    assert.ok(topic.headers.get('content-type')!.startsWith('text/html'));
    assert.ok(html.includes('og:title') && html.includes('Fractions') && html.includes('school17://market/topic/fractions'));
    const unknown = await (await fetch(t.baseUrl + '/t/<script>alert(1)</script>')).text();
    assert.equal(unknown.includes('<script>'), false);
    const teacher = await (await fetch(t.baseUrl + '/p/' + x.profileId)).text();
    assert.ok(teacher.includes('school17://market/teacher/' + x.profileId));
    const draft = await makeTeacher(t, { submit: true });
    const hidden = await (await fetch(t.baseUrl + '/p/' + draft.profileId)).text();
    assert.equal(hidden.includes(draft.profileId), false, 'unverified teachers are not previewed');
  });

  it('deleting an account removes a person test scores, votes, comments and videos', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const pupil = await makeUser(t, Role.STUDENT);
    const vid = (await api(t, x.user.token).post('/topics/fractions/videos', { url: `https://youtu.be/${rid()}`, title: 'Fractions for beginners', lang: 'en' })).body.id as string;
    await api(t, pupil.token).post(`/topics/videos/${vid}/vote`);
    const q = (await api(t, pupil.token).get('/topics/fractions/quiz')).body.questions;
    assert.equal((await api(t, pupil.token).post('/topics/fractions/quiz', { answers: q.map((a: any) => ({ id: a.id, choice: 0 })) })).status, 200);
    assert.equal((await api(t, pupil.token).post(`/teachers/${x.profileId}/comments`, { text: 'A nice teacher indeed', rating: 5 })).status, 201);
    assert.equal((await api(t, pupil.token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
    assert.equal(await t.prisma.topicAttempt.count({ where: { userId: pupil.id } }), 0);
    assert.equal(await t.prisma.topicVideoVote.count({ where: { userId: pupil.id } }), 0);
    assert.equal(await t.prisma.teacherComment.count({ where: { authorId: pupil.id } }), 0);
    // the teacher deletes too: the videos they added go as well, the picked ones stay
    assert.equal((await api(t, x.user.token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
    assert.equal(await t.prisma.topicVideo.count({ where: { addedById: x.user.id } }), 0);
    assert.ok((await t.prisma.topicVideo.count({ where: { curated: true } })) > 0);
  });
});
