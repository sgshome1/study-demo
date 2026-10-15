/* ============================================================
   智能学习系统 · 在线演示版静态数据层（static-api.js）
   仅在 *.github.io 域名下生效：接管 /api/* 请求，改为读取静态数据，
   并在浏览器本地保存练习记录（错题 / 进度 / 积分）。
   本地与局域网访问不加载本层，一切走真实后端。
   ============================================================ */
(function () {
  if (!/\.github\.io$/i.test(location.hostname)) return;

  var ROOT = location.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '');
  var LS = 'studydemo_state_v1';

  function ok(data) { return { success: true, code: '0', message: 'success', data: data === undefined ? null : data }; }
  function fail(code, msg) { return { success: false, code: String(code), message: msg, data: null }; }

  var cache = {};
  function loadJSON(rel) {
    if (!cache[rel]) cache[rel] = fetch(ROOT + '/' + rel).then(function (r) { if (!r.ok) throw new Error('数据文件缺失：' + rel); return r.json(); });
    return cache[rel];
  }
  function live(name) { return loadJSON('data/live/' + name + '.json'); }

  /* ---------------- 本地状态 ---------------- */
  var st = null;
  function defaults() {
    return { seeded: 0, attempts: [], wrongs: {}, qseen: {}, msgRead: [], messages: [], tasksDone: [], progress: {},
      blindbox: {}, pointsDelta: 0, pointsLog: [], avatar: null, prefs: null, moments: [], likes: {}, comments: {},
      deleted: [], certs: [], feedbacks: [], hw: [], roomMsgs: {}, friendsAdded: [], friendsRemoved: [], friendApplied: [],
      assess: [], medal: null };
  }
  function readState() {
    if (st) return st;
    st = defaults();
    try { var raw = localStorage.getItem(LS); if (raw) { var obj = JSON.parse(raw); for (var k in st) if (obj[k] !== undefined) st[k] = obj[k]; } } catch (e) {}
    return st;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(st)); } catch (e) {} }

  var ready = null;
  function bootstrap() {
    if (ready) return ready;
    ready = (async function () {
      var s = readState();
      if (!s.seeded) {
        try {
          var wr = await live('wrongs');
          var list = (wr && wr.data && wr.data.list) || [];
          for (var i = 0; i < list.length; i++) {
            var r = list[i];
            var qid = r.question_id;
            s.wrongs[qid] = { question_id: qid, wrong_count: r.wrong_count, stage: r.stage || 0, next_at: r.next_at || 0, reviewed_at: r.reviewed_at || 0, mastered: 0, last_at: r.last_at || 0 };
            s.qseen[qid] = { question_id: qid, stem: r.stem, type: r.type, options: r.options, answer: r.answer, analysis: r.analysis, difficulty: r.difficulty || 1, kname: r.kname, sname: r.sname, grade: r.grade };
          }
        } catch (e) {}
        s.seeded = 1; save();
      }
    })();
    return ready;
  }

  /* ---------------- 目录索引 / 分册题目包 ---------------- */
  var catIdx = null;
  async function catalog() {
    if (catIdx) return catIdx;
    var cat = (await live('catalog')).data || [];
    var idx = { subjects: cat, kp: {}, chapter: {}, kpList: [] };
    for (var si = 0; si < cat.length; si++) {
      var subj = cat[si];
      for (var ci = 0; ci < subj.chapters.length; ci++) {
        var ch = subj.chapters[ci];
        idx.chapter[ch.id] = { id: ch.id, name: ch.name, grade: ch.grade, sname: subj.name, pk: ch.pk, courses: ch.courses || [] };
        var kps = ch.kpoints || [];
        for (var ki = 0; ki < kps.length; ki++) {
          var kp = kps[ki];
          var meta = { id: kp.id, name: kp.name, cname: ch.name, grade: ch.grade, sname: subj.name, pk: ch.pk, qn: kp.qn || 0, chapterId: ch.id };
          idx.kp[kp.id] = meta;
          idx.kpList.push(meta);
        }
      }
    }
    catIdx = idx;
    return idx;
  }
  var packs = {};
  var qidx = {};
  async function kpData(kid) {
    var meta = (await catalog()).kp[kid];
    if (!meta || !meta.pk) return { q: [], m: [] };
    if (!packs[meta.pk]) packs[meta.pk] = loadJSON('data/packs/pack-' + meta.pk + '.json');
    var pack = await packs[meta.pk];
    if (!pack.__parsed) {
      for (var k in pack.kp) {
        var e = pack.kp[k];
        for (var i = 0; i < e.q.length; i++) qidx[e.q[i].id] = { row: e.q[i], kid: Number(k) };
      }
      pack.__parsed = 1;
    }
    return pack.kp[kid] || { q: [], m: [] };
  }

  /* ---------------- 艾宾浩斯错题逻辑（与本地版一致） ---------------- */
  var REVIEW_DAYS = [1, 2, 4, 7];
  var REVIEW_GOAL = 5;
  function dayStart(ts) { var d = new Date(ts == null ? Date.now() : ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function endOfToday() { var d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
  function scheduleNext(stage, base) { return dayStart(base) + REVIEW_DAYS[Math.max(0, Math.min(stage, REVIEW_DAYS.length) - 1)] * 86400000; }
  function wrongAnswer(qid) {
    var w = st.wrongs[qid] || { question_id: qid, wrong_count: 0, stage: 0, mastered: 0, next_at: 0, reviewed_at: 0, last_at: 0 };
    w.wrong_count = (w.wrong_count || 0) + 1;
    w.mastered = 0; w.stage = 0;
    w.last_at = Date.now();
    w.next_at = dayStart(Date.now()) + 86400000;
    st.wrongs[qid] = w;
    return w;
  }
  function reviewCorrect(qid) {
    var w = st.wrongs[qid];
    if (!w || w.mastered) return null;
    if ((w.next_at || 0) > endOfToday()) return { advanced: false, stage: w.stage || 0, notDue: true };
    var ns = (w.stage || 0) + 1;
    w.reviewed_at = Date.now();
    if (ns >= REVIEW_GOAL) { w.stage = ns; w.mastered = 1; return { advanced: true, stage: ns, mastered: true }; }
    w.stage = ns;
    w.next_at = scheduleNext(ns, Date.now());
    return { advanced: true, stage: ns, nextAt: w.next_at };
  }
  function normAns(v) { return String(v == null ? '' : v).replace(/；/g, ';').replace(/[\s;]/g, '').toLowerCase(); }
  function isCorrect(q, answer) { return normAns(answer) === normAns(q.answer); }

  function localStats(kid) {
    var alln = 0, okn = 0;
    for (var i = 0; i < st.attempts.length; i++) { var a = st.attempts[i]; if (a.kpointId === kid) { alln++; if (a.correct) okn++; } }
    return { alln: alln, okn: okn };
  }
  async function mergedMastery(kid, qn) {
    var base = null;
    if (!cache['__bm']) cache['__bm'] = loadJSON('data/baseline-mastery.json');
    try { base = (await cache['__bm'])[kid] || null; } catch (e) { base = null; }
    var b = base || { alln: 0, okn: 0 };
    var l = localStats(kid);
    var okn = b.okn + l.okn;
    return { alln: b.alln + l.alln, okn: okn, mastery: qn ? Math.round(Math.min(1, okn / qn) * 100) : 0 };
  }
  function pushAttempt(kid, qid, correct, spentMs) {
    st.attempts.push({ questionId: qid, kpointId: kid, correct: correct ? 1 : 0, spentMs: Math.min(Math.max(0, Number(spentMs) || 0), 1800000), ts: Date.now() });
  }
  function cacheQuestion(qrow, kid) {
    var meta = catIdx && catIdx.kp[kid] ? catIdx.kp[kid] : null;
    var prev = st.qseen[qrow.id] || {};
    st.qseen[qrow.id] = { question_id: qrow.id, stem: qrow.stem, type: qrow.type, options: qrow.options, answer: qrow.answer, analysis: qrow.analysis, difficulty: qrow.difficulty || 1,
      kname: prev.kname || (meta ? meta.name : ''), sname: prev.sname || (meta ? meta.sname : ''), grade: prev.grade || (meta ? meta.grade : '') };
  }
  async function addPoints(amount, reason) { st.pointsDelta += amount; st.pointsLog.unshift({ amount: amount, reason: reason, created_at: Date.now() }); }
  async function basePoints() { try { return ((await live('points')).data || {}).points || 0; } catch (e) { return 0; } }

  /* ---------------- 题目索引补充（错题场景查询题目归属） ---------------- */
  var qmapP = null;
  function qmapLoad() { if (!qmapP) qmapP = loadJSON('data/qmap.json'); return qmapP; }

  function buildCourses(baseList) {
    return (baseList || []).map(function (c) {
      var pos = st.progress[c.id] !== undefined ? st.progress[c.id] : (c.position || 0);
      return Object.assign({}, c, { position: pos });
    });
  }

  /* ---------------- 接口路由 ---------------- */
  async function handle(path, b) {
    await bootstrap();
    var C = await catalog();

    if (path === '/ping') return ok({ build: 1, title: '智能学习系统（在线演示版）' });
    if (path === '/login') {
      var me0 = (await live('me')).data || {};
      var user0 = Object.assign({}, me0.user || { id: 1, name: '演示学生', role: 'student', phone: '13800000000' });
      user0.avatar = st.avatar || user0.avatar || null;
      return ok({ token: 'demo-token', user: user0 });
    }
    if (path === '/sms/send') return ok({ devCode: '123456' });
    if (path === '/reset-password') return ok({ reset: true });
    if (path === '/me') { var me1 = (await live('me')).data; me1.user.avatar = st.avatar || me1.user.avatar; return ok({ user: me1.user, org: me1.org }); }
    if (path === '/me/avatar') { st.avatar = b.avatar || null; save(); return ok({ avatar: st.avatar }); }
    if (path === '/me/password') return fail(400, '演示版不支持修改密码（请在你自己的系统里修改）');
    if (path === '/me/prefs') { return ok(Object.assign({}, (await live('prefs')).data, st.prefs || {})); }
    if (path === '/me/prefs/save') { st.prefs = Object.assign({}, st.prefs || {}, b); save(); return ok({ saved: true }); }
    if (path === '/agreement') return ok((await live('agreement')).data);

    if (path === '/catalog') return ok(C.subjects);
    if (path === '/courses') return ok(buildCourses((await live('courses')).data));
    if (path === '/courses/progress') { st.progress[b.courseId] = Number(b.position || 0); save(); return ok({ saved: true }); }

    if (path === '/tasks') {
      return ok(((await live('tasks')).data || []).map(function (t) { return Object.assign({}, t, { done: (t.done || st.tasksDone.indexOf(t.id) >= 0) ? 1 : 0 }); }));
    }
    if (path === '/tasks/done') { if (st.tasksDone.indexOf(b.id) < 0) st.tasksDone.push(b.id); save(); return ok({ done: true }); }
    if (path === '/messages') {
      var ms = ((await live('messages')).data || []).concat(st.messages || []);
      ms = ms.map(function (m) { return Object.assign({}, m, { read: (m.read || st.msgRead.indexOf(m.id) >= 0) ? 1 : 0 }); });
      ms.sort(function (a, c) { return (c.created_at || 0) - (a.created_at || 0); });
      return ok(ms);
    }
    if (path === '/messages/read') { if (st.msgRead.indexOf(b.id) < 0) st.msgRead.push(b.id); save(); return ok({ read: true }); }

    if (path === '/report') {
      var days = Number(b.days || 7);
      var base = (await live(days >= 30 ? 'report30' : 'report7')).data;
      var since = Date.now() - days * 86400000;
      var total = base.total, right = base.right, secs = base.seconds;
      var localSecs = 0, localRows = [];
      for (var i = 0; i < st.attempts.length; i++) { var a = st.attempts[i]; if (a.ts >= since) { localRows.push(a); total++; if (a.correct) right++; secs += a.spentMs / 1000; localSecs += a.spentMs / 1000; } }
      function label(ts) { var d = new Date(ts); return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0'); }
      var trend = (base.trend || []).map(function (t2) { return Object.assign({}, t2); });
      var byLabel = {}; for (var ti = 0; ti < trend.length; ti++) byLabel[trend[ti].date] = trend[ti];
      var lc = {}, lt = {};
      for (var li = 0; li < localRows.length; li++) { var lb = label(localRows[li].ts); lt[lb] = (lt[lb] || 0) + 1; if (localRows[li].correct) lc[lb] = (lc[lb] || 0) + 1; }
      for (var key in lt) { var tt = byLabel[key]; if (tt) { var rc = Math.round((tt.acc || 0) / 100 * tt.count) + (lc[key] || 0); tt.count += lt[key]; tt.acc = tt.count ? Math.round(rc / tt.count * 100) : 0; } }
      var mAll = (base.mastery || []).map(function (m) { return Object.assign({}, m); });
      var mById = {}; for (var mi = 0; mi < mAll.length; mi++) mById[mAll[mi].id] = mAll[mi];
      for (var ai = 0; ai < localRows.length; ai++) { var row = mById[localRows[ai].kpointId]; if (row && localRows[ai].correct) row.okn = (row.okn || 0) + 1; }
      for (var mk in mById) { var r2 = mById[mk]; r2.mastery = r2.qn ? Math.round(Math.min(1, (r2.okn || 0) / r2.qn) * 100) : 0; }
      return ok({ days: days, total: total, right: right, accuracy: total ? Math.round(right / total * 100) : 0, seconds: Math.round(secs), videoSeconds: base.videoSeconds || 0, practiceSeconds: Math.round((base.practiceSeconds || 0) + localSecs), mastery: mAll, trend: trend });
    }

    if (path === '/recommend') {
      if (!cache['__bm']) cache['__bm'] = loadJSON('data/baseline-mastery.json');
      var bm = {}; try { bm = await cache['__bm']; } catch (e) {}
      var scored = [];
      for (var qi = 0; qi < C.kpList.length; qi++) {
        var kp2 = C.kpList[qi];
        if (!kp2.qn) continue;
        var b2 = bm[kp2.id] || { alln: 0, okn: 0 };
        var l2 = localStats(kp2.id);
        var alln = b2.alln + l2.alln, okn = b2.okn + l2.okn;
        scored.push({ id: kp2.id, name: kp2.name, cname: kp2.cname, sname: kp2.sname, mastery: Math.round(Math.min(1, okn / kp2.qn) * 100), alln: alln });
      }
      var undone = scored.filter(function (r) { return r.alln === 0; });
      var weak = scored.filter(function (r) { return r.alln > 0 && r.mastery < 80; }).sort(function (a3, c3) { return a3.mastery - c3.mastery; });
      var next = undone[0] || weak[0] || null;
      var weakTop = weak.slice(0, 30).map(function (r) { return { id: r.id, name: r.name, cname: r.cname, sname: r.sname, mastery: r.mastery }; });
      return ok({ next: next, undone: undone.length, weak: weak.length, done: scored.filter(function (r) { return r.mastery >= 80; }).length, total: scored.length, weakTop: weakTop });
    }

    if (path === '/kpoint') {
      var kid = Number(b.kpointId);
      var meta = C.kp[kid];
      if (!meta) return fail(404, '知识点不存在（演示数据）');
      var kd = await kpData(kid);
      var ch = C.chapter[meta.chapterId];
      var courses = (ch.courses || []).filter(function (c) { return c.kpoint_id === kid; });
      var note = null;
      if (!courses.length && (ch.courses || []).length) { courses = ch.courses.slice(0, 6); note = '以下为本章其他知识点的视频'; }
      var qn = kd.q.filter(function (q) { return q.type === 'single' || q.type === 'multi' || q.type === 'fill'; }).length;
      var mm = await mergedMastery(kid, qn);
      var last = null;
      for (var ai2 = st.assess.length - 1; ai2 >= 0; ai2--) { if (st.assess[ai2].kpoint_id === kid) { last = st.assess[ai2]; break; } }
      return ok({ kpoint: { id: kid, chapter_id: meta.chapterId, name: meta.name, cname: meta.cname, sname: meta.sname }, courses: courses, coursesNote: note,
        materials: kd.m, examples: kd.q.filter(function (q) { return q.type === 'solve'; }).slice(0, 20).map(function (q) { return { id: q.id, stem: q.stem, analysis: q.analysis, difficulty: q.difficulty }; }),
        mastery: mm.mastery, questionCount: qn, lastAssess: last });
    }

    if (path === '/practice/start') {
      var count0 = Math.min(Number(b.count || 10), 20);
      if (b.wrongOnly && !b.kpointId) {
        var free = !!b.free, eot = endOfToday();
        var ids = [];
        for (var qid in st.wrongs) { var w = st.wrongs[qid]; if (w.mastered) continue; if (!free && (w.next_at || 0) > eot) continue; ids.push(qid); }
        ids.sort(function (a4, c4) { var wa = st.wrongs[a4], wc = st.wrongs[c4]; if (free) return (wc.last_at || 0) - (wa.last_at || 0); var d = (wa.next_at || 0) - (wc.next_at || 0); if (d) return d; return (wc.last_at || 0) - (wa.last_at || 0); });
        ids = ids.slice(0, count0);
        if (!ids.length) return fail(404, free ? '还没有未掌握的错题' : '今天没有到期的错题，明天再来');
        var qs = [];
        for (var ii = 0; ii < ids.length; ii++) {
          var qq = st.qseen[ids[ii]]; var ww = st.wrongs[ids[ii]];
          if (!qq) continue;
          var opts = null; try { opts = qq.options ? JSON.parse(qq.options) : null; } catch (e) {}
          qs.push({ id: qq.question_id, type: qq.type, stem: qq.stem, options: opts, difficulty: qq.difficulty || 1, stage: ww.stage || 0 });
        }
        return ok({ kpoint: { id: 0, name: free ? '错题加练' : '错题复习' }, questions: qs });
      }
      var kid2 = Number(b.kpointId);
      var meta2 = C.kp[kid2];
      if (!meta2) return fail(404, '知识点不存在');
      var kd2 = await kpData(kid2);
      var list = kd2.q.filter(function (q) { return q.type === 'single' || q.type === 'multi' || q.type === 'fill'; });
      if (b.wrongOnly) { var wid = {}; for (var qid2 in st.wrongs) if (!st.wrongs[qid2].mastered) wid[qid2] = 1; list = list.filter(function (q) { return wid[q.id]; }); }
      var n2 = Math.min(Number(b.count || 5), list.length);
      var outQ = list.slice(0, n2).map(function (q) { var o = null; try { o = q.options ? JSON.parse(q.options) : null; } catch (e) {} var w2 = st.wrongs[q.id]; return { id: q.id, type: q.type, stem: q.stem, options: o, difficulty: q.difficulty, stage: w2 ? (w2.stage || 0) : 0 }; });
      return ok({ kpoint: { id: kid2, name: meta2.name }, questions: outQ });
    }

    if (path === '/practice/submit') {
      var qid3 = Number(b.questionId);
      var hit = qidx[qid3] || (st.qseen[qid3] ? { row: st.qseen[qid3], kid: null } : null);
      if (!hit) return fail(404, '题目不存在');
      var row3 = hit.row;
      var kidM = hit.kid;
      if (kidM == null) { try { kidM = (await qmapLoad())[qid3] || 0; } catch (e) { kidM = 0; } }
      var correct = isCorrect(row3, b.answer);
      pushAttempt(kidM, qid3, correct, b.spentMs);
      var review = null;
      if (correct) review = reviewCorrect(qid3);
      else { wrongAnswer(qid3); cacheQuestion(row3, kidM); }
      save();
      return ok({ correct: correct, answer: row3.answer, analysis: row3.analysis, review: review });
    }

    if (path === '/wrongs') {
      var eot2 = endOfToday();
      var rows2 = [], masteredN = 0;
      for (var qid4 in st.wrongs) {
        var w4 = st.wrongs[qid4];
        if (w4.mastered) { masteredN++; continue; }
        var s4 = st.qseen[qid4] || {};
        rows2.push({ question_id: Number(qid4), wrong_count: w4.wrong_count, stage: w4.stage || 0, next_at: w4.next_at || 0, reviewed_at: w4.reviewed_at || 0, mastered: 0, last_at: w4.last_at || 0, due: (w4.next_at || 0) <= eot2,
          stem: s4.stem, type: s4.type, options: s4.options, answer: s4.answer, analysis: s4.analysis, kname: s4.kname, sname: s4.sname, grade: s4.grade });
      }
      rows2.sort(function (a5, c5) { var da = a5.due ? 0 : 1, dc = c5.due ? 0 : 1; if (da !== dc) return da - dc; var n5 = (a5.next_at || 0) - (c5.next_at || 0); if (n5) return n5; return (c5.last_at || 0) - (a5.last_at || 0); });
      return ok({ list: rows2, stats: { due: rows2.filter(function (r) { return r.due; }).length, active: rows2.length, mastered: masteredN } });
    }
    if (path === '/wrongs/remove') { var w5 = st.wrongs[b.questionId]; if (w5) { w5.mastered = 1; save(); } return ok({ removed: true }); }
    if (path === '/wrongs/print') {
      var ids5 = (b.questionIds || []).map(Number);
      var items = [];
      if (ids5.length) { for (var pi = 0; pi < ids5.length; pi++) { var rp = st.qseen[ids5[pi]]; if (rp) items.push({ id: rp.question_id, stem: rp.stem, options: rp.options, answer: rp.answer, analysis: rp.analysis }); } }
      else { for (var qid5 in st.wrongs) { if (st.wrongs[qid5].mastered) continue; var rp2 = st.qseen[qid5]; if (rp2) items.push({ id: rp2.question_id, stem: rp2.stem, options: rp2.options, answer: rp2.answer, analysis: rp2.analysis }); } }
      return ok({ title: '错题打印', date: new Date().toLocaleDateString('zh-CN'), questions: items });
    }

    if (path === '/assess/start') {
      var kid6 = Number(b.kpointId);
      var kd6 = await kpData(kid6);
      var list6 = kd6.q.filter(function (q) { return q.type === 'single' || q.type === 'multi' || q.type === 'fill'; });
      if (!list6.length) return fail(404, '该知识点还没有可判分的题目');
      var pick6 = list6.slice(0, b.count ? Number(b.count) : 10);
      return ok({ kpointId: kid6, total: pick6.length, questions: pick6.map(function (q) { var o = null; try { o = q.options ? JSON.parse(q.options) : null; } catch (e) {} return { id: q.id, type: q.type, stem: q.stem, options: o, difficulty: q.difficulty }; }) });
    }
    if (path === '/assess/submit') {
      var kid7 = Number(b.kpointId), answers = b.answers || [], correct7 = 0;
      for (var ai7 = 0; ai7 < answers.length; ai7++) {
        var sqid = Number(answers[ai7].questionId);
        var hit7 = qidx[sqid] || (st.qseen[sqid] ? { row: st.qseen[sqid] } : null);
        if (!hit7) continue;
        var ok7 = isCorrect(hit7.row, answers[ai7].answer);
        if (ok7) correct7++;
        pushAttempt(kid7, sqid, ok7, answers[ai7].spentMs);
        if (!ok7) { wrongAnswer(sqid); cacheQuestion(hit7.row, kid7); } else reviewCorrect(sqid);
      }
      var total7 = answers.length || 1;
      var score7 = Math.round(correct7 / total7 * 100);
      var passed7 = score7 >= 80;
      st.assess.push({ user_id: 1, kpoint_id: kid7, total: answers.length, correct: correct7, score: score7, created_at: Date.now() });
      if (passed7) await addPoints(10, '测评得分 ' + score7 + '，奖励'); else await addPoints(3, '完成一次测评');
      save();
      return ok({ correct: correct7, total: answers.length, score: score7, passed: passed7, mastered: passed7, points: (await basePoints()) + st.pointsDelta });
    }

    if (path === '/blindbox') {
      var today = new Date().toISOString().slice(0, 10);
      var got = st.blindbox[today];
      if (got) return ok({ opened: true, today: today, kpoint: got.kpoint, amount: got.amount });
      var b0 = (await live('blindbox')).data;
      return ok({ opened: false, today: today, kpoint: b0.kpoint, amount: 0 });
    }
    if (path === '/blindbox/open') {
      var today2 = new Date().toISOString().slice(0, 10);
      if (st.blindbox[today2]) return fail(400, '今天已经开过啦，明天再来');
      var kp8 = C.kpList[Math.floor(Math.random() * C.kpList.length)];
      var amount8 = 1 + Math.floor(Math.random() * 10);
      st.blindbox[today2] = { kpoint: { id: kp8.id, name: kp8.name }, amount: amount8 };
      await addPoints(amount8, '酷大宝盲盒');
      save();
      return ok({ amount: amount8, kpoint: { id: kp8.id, name: kp8.name }, points: (await basePoints()) + st.pointsDelta });
    }
    if (path === '/points') {
      var pl = (await live('points')).data;
      return ok({ points: (pl.points || 0) + st.pointsDelta, list: (st.pointsLog || []).concat(pl.list || []) });
    }
    if (path === '/points/rank') {
      var rk = (await live(b && b.type === 'week' ? 'rank-week' : 'rank-total')).data;
      var list8 = (rk.list || []).map(function (r) { return Object.assign({}, r, { points: (r.points || 0) + (r.mine ? st.pointsDelta : 0) }); });
      list8.sort(function (a6, c6) { return c6.points - a6.points; });
      for (var ri = 0; ri < list8.length; ri++) list8[ri].rank = ri + 1;
      return ok({ type: rk.type, list: list8 });
    }
    if (path === '/medals') {
      var md = (await live('medals')).data;
      if (md && typeof md === 'object') md.current = st.medal || md.current || null;
      return ok(md);
    }
    if (path === '/medals/set') { st.medal = b.medalId; save(); return ok({ set: b.medalId }); }

    if (path === '/friends') { var fl = ((await live('friends')).data || []).concat(st.friendsAdded || []); fl = fl.filter(function (f) { return st.friendsRemoved.indexOf(f.fid) < 0; }); return ok(fl); }
    if (path === '/friends/mayknow') { var mk = ((await live('mayknow')).data || []); return ok(mk.filter(function (u2) { return st.friendApplied.indexOf(u2.id) < 0; })); }
    if (path === '/friends/apply') { if (st.friendApplied.indexOf(b.friendId) < 0) st.friendApplied.push(b.friendId); save(); return ok({ applied: true }); }
    if (path === '/friends/agree') { return ok({ agreed: true }); }
    if (path === '/friends/remove') { if (st.friendsRemoved.indexOf(b.id) < 0) st.friendsRemoved.push(b.id); save(); return ok({ removed: true }); }

    if (path === '/moments') {
      var base9 = ((await live('moments')).data || []).filter(function (m) { return st.deleted.indexOf(m.id) < 0; });
      var all9 = base9.concat(st.moments || []);
      all9 = all9.map(function (m) {
        var liked = !!st.likes[m.id];
        var delta = (liked && !m.liked) ? 1 : ((!liked && m.liked) ? -1 : 0);
        return Object.assign({}, m, { liked: liked, likes: Math.max(0, (m.likes || 0) + delta), comments: (m.comments || []).concat(st.comments[m.id] || []) });
      });
      all9.sort(function (a7, c7) { return (c7.created_at || 0) - (a7.created_at || 0); });
      return ok(all9);
    }
    if (path === '/moments/create') {
      st.moments.unshift({ id: Date.now(), user_id: 1, body: b.body, images: b.images || [], created_at: Date.now(), user: { id: 1, name: '演示学生', avatar: st.avatar || null }, mine: true, isFriend: false, likes: 0, liked: false, comments: [] });
      save(); return ok({ id: st.moments[0].id });
    }
    if (path === '/moments/delete') { st.deleted.push(b.id); st.moments = (st.moments || []).filter(function (m) { return m.id !== b.id; }); save(); return ok({ deleted: true }); }
    if (path === '/moments/like') { var cur = !!st.likes[b.id]; st.likes[b.id] = !cur; save(); return ok({ liked: !cur }); }
    if (path === '/moments/comment') {
      if (!st.comments[b.id]) st.comments[b.id] = [];
      st.comments[b.id].push({ id: Date.now(), moment_id: b.id, user_id: 1, body: b.body, created_at: Date.now(), name: '演示学生', avatar: st.avatar || null });
      save(); return ok({ commented: true });
    }

    if (path === '/homework') { return ok(((await live('homework')).data || []).concat(st.hw || [])); }
    if (path === '/homework/submit') {
      st.hw.unshift({ id: Date.now(), user_id: 1, title: b.title || b.name || '作业', url: '', size: b.size || 0, status: 'submitted', review: null, created_at: Date.now() });
      st.messages.unshift({ id: Date.now() + 1, user_id: 1, title: '作业已提交', body: '《' + (b.title || b.name || '作业') + '》提交成功（在线演示版仅记录在你自己的浏览器里）。', created_at: Date.now(), read: 0 });
      save(); return ok({ id: st.hw[0].id });
    }
    if (path === '/classrooms') { return ok((await live('classrooms')).data); }
    if (path === '/classroom/messages') {
      var rid = Number(b.roomId);
      var baseRm = ((await live('room-messages')).data || {})[rid] || [];
      return ok(baseRm.concat(st.roomMsgs[rid] || []));
    }
    if (path === '/classroom/send') {
      var rid2 = Number(b.roomId);
      if (!st.roomMsgs[rid2]) st.roomMsgs[rid2] = [];
      st.roomMsgs[rid2].push({ id: Date.now(), room_id: rid2, user_id: 1, name: '演示学生', body: b.body, created_at: Date.now() });
      save(); return ok({ sent: true });
    }
    if (path === '/recordings') { return ok((await live('recordings')).data); }
    if (path === '/teacher/cert/mine') { return ok(((await live('cert')).data || []).concat(st.certs || [])); }
    if (path === '/teacher/cert') { st.certs.unshift(Object.assign({ id: Date.now(), user_id: 1, status: 'pending', created_at: Date.now() }, b)); save(); return ok({ id: st.certs[0].id }); }
    if (path === '/feedback/mine') { return ok(((await live('feedback')).data || []).concat(st.feedbacks || [])); }
    if (path === '/feedback') { st.feedbacks.unshift(Object.assign({ id: Date.now(), user_id: 1, status: 'new', created_at: Date.now() }, b)); save(); return ok({ id: st.feedbacks[0].id }); }
    if (path === '/areas') {
      var ar = (await live('areas')).data;
      if (b && b.parentId) return ok(ar.children[b.parentId] || []);
      return ok(ar.root || []);
    }
    if (path === '/study/summary') {
      var sm = (await live('summary')).data;
      var add = 0, daysSet = {};
      for (var si2 = 0; si2 < st.attempts.length; si2++) { add += st.attempts[si2].spentMs / 1000; daysSet[new Date(st.attempts[si2].ts).toDateString()] = 1; }
      return ok({ seconds: Math.round((sm.seconds || 0) + add), days: (sm.days || 0) + Math.max(0, Object.keys(daysSet).length - 1) });
    }

    if (path.indexOf('/admin/') === 0) return fail(403, '在线演示版不开放管理后台');
    return fail(404, '演示版未实现该接口：' + path);
  }

  /* ---------------- 接管 fetch ---------------- */
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (url.indexOf('/api/') === 0) {
      var qpos = url.indexOf('?');
      var path = url.slice(4, qpos >= 0 ? qpos : url.length);
      if (path === '/ping' && !catIdx) { /* 首次 ping 前不阻塞 */ }
      var body2 = null;
      if (init && init.body) { try { body2 = JSON.parse(init.body); } catch (e) {} }
      return Promise.resolve().then(function () { return handle(path, body2 || {}); }).then(function (data) {
        return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }).catch(function (e) {
        return new Response(JSON.stringify(fail(500, '演示数据加载失败：' + String(e && e.message || e))), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      });
    }
    return origFetch ? origFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
  };

  /* ---------------- 演示标识与样式 ---------------- */
  function injectUI() {
    var css = document.createElement('style');
    css.textContent = '.demoph{display:inline-block;padding:0 8px;margin:0 2px;border-radius:6px;background:rgba(120,120,128,.14);color:#6E6E73;font-size:12px;line-height:20px;font-style:normal}';
    document.head.appendChild(css);
    var tries = 0;
    var t = setInterval(function () {
      var box = document.querySelector('.login-box');
      if (box && !box.getAttribute('data-demo-tip')) {
        box.setAttribute('data-demo-tip', '1');
        var tip = document.createElement('div');
        tip.className = 'muted';
        tip.style.cssText = 'margin-top:14px;text-align:center';
        tip.textContent = '这是在线演示版：随便点，不会影响任何真实数据';
        box.appendChild(tip);
        clearInterval(t);
      }
      if (++tries > 60) clearInterval(t);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectUI); else injectUI();

  console.log('[demo] 在线演示版数据层已启用');
})();
