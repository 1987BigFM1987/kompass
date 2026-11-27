/*
 * Kompass Coach: die Rechenlogik für Ziel, Trend, Korridor, Feiern und Wochenrückblick.
 * Dieselbe Datei läuft in der App (coach.js) und im Apps Script (Datei „Coach“).
 * Nur reine Funktionen auf einfachen Daten, damit App, Telegram und Wandtablet immer dasselbe sagen.
 *
 * Datenformate (wie sie getState liefert):
 *   weights:  [[datum, kg, fett, muskel, quelle, notiz], …]
 *   phases:   [{ name, start, end, tab, rate:[lo,hi], ziel:{ kg, wege:[[datum,kg],…], anlass, anlassDatum } }]
 *   sessions: [{ id, d, plan, min, note, knie, km }]   plan A/B = Kraft, F = Fußball, L = Laufen
 *   days:     [{ date, type, n, kcalExtra, feier, plan }]   n = gegessene Mahlzeiten
 *   events:   [{ s, e, t, art }]   s/e = erster und letzter Tag, art = feier | urlaub | fussball
 *   umfang:   [[datum, cm], …]
 */
var Coach = (function () {
  var DAY = 864e5;
  function ms(s) { var p = String(s).split('-'); return Date.UTC(+p[0], p[1] - 1, +p[2]); }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  function add(s, n) { return iso(ms(s) + n * DAY); }
  function diff(a, b) { return Math.round((ms(b) - ms(a)) / DAY); }
  function wday(s) { return new Date(ms(s)).getUTCDay(); }
  function monday(s) { return add(s, -((wday(s) + 6) % 7)); }
  function r1(v) { return Math.round(v * 10) / 10 + 0; }
  function nf(v, d) { d = d == null ? 1 : d; var s = Math.abs(v).toFixed(d).replace('.', ','); return (v < 0 && Number(s.replace(',', '.')) !== 0 ? '−' : '') + s; }
  function sg(v, d) { var a = Number(Math.abs(v).toFixed(d == null ? 1 : d)); return (a === 0 ? '±' : v > 0 ? '+' : '−') + nf(a, d); }
  function dm(s) { return s.slice(8, 10) + '.' + s.slice(5, 7) + '.'; }
  var WT = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

  function kgMap(weights) { var m = {}; (weights || []).forEach(function (w) { if (w && w[0] && w[1]) m[w[0]] = +w[1]; }); return m; }
  function phaseAt(phases, d) { var o = null; (phases || []).forEach(function (p) { if (p.start <= d && (!p.end || p.end >= d)) o = p; }); return o; }
  function nextPhase(phases, d) { var o = null; (phases || []).forEach(function (p) { if (p.start > d && !o) o = p; }); return o; }

  /* ---------- Zielpfad ---------- */
  /** Linie vom ersten Wiegen der Phase über die Zwischenziele bis zum Ziel am Phasenende. */
  function path(phase, m) {
    if (!phase || !phase.ziel || !phase.end) return null;
    var start = null;
    for (var i = 0; i <= 3 && !start; i++) { var d = add(phase.start, i); if (m[d]) start = [d, m[d]]; }
    if (phase.ziel.start) start = [phase.start, phase.ziel.start];
    if (!start) return null;
    var pts = [start].concat((phase.ziel.wege || []).filter(function (w) { return w[0] > start[0] && w[0] < phase.end; }));
    pts.push([phase.end, phase.ziel.kg]);
    return { pts: pts, kg: phase.ziel.kg, end: phase.end, anlass: phase.ziel.anlass || '', anlassDatum: phase.ziel.anlassDatum || phase.end };
  }
  function planAt(p, d) {
    if (!p) return null;
    var a = p.pts;
    if (d <= a[0][0]) return a[0][1];
    for (var i = 1; i < a.length; i++) if (d <= a[i][0]) { var f = diff(a[i - 1][0], d) / diff(a[i - 1][0], a[i][0]); return a[i - 1][1] + f * (a[i][1] - a[i - 1][1]); }
    return a[a.length - 1][1];
  }
  /** Tiefstwert der letzten sieben Tage, so wie das Ziel gemeint ist („Tiefstwert unter der Woche“). */
  function weekLow(m, d) {
    var best = null;
    for (var i = 0; i < 7; i++) { var x = add(d, -i); if (m[x] && (!best || m[x] < best.kg)) best = { d: x, kg: m[x] }; }
    return best;
  }
  function weekAvg(m, from, to) { var s = 0, n = 0; for (var d = from; d <= to; d = add(d, 1)) if (m[d]) { s += m[d]; n++; } return n ? s / n : null; }

  /* ---------- Wochenrate ---------- */
  /**
   * Ausgleichsgerade über die gewogenen Tage der letzten 14 Tage, in kg pro Woche.
   * In einer Phase mit Korridor zählt die erste Woche nicht mit, denn die ist vor allem Wasser.
   */
  function rate(m, phase, d) {
    var from = add(d, -13);
    var skip = phase && phase.rate ? add(phase.start, 7) : null;
    if (skip && skip > from) from = skip;
    var xs = [], ys = [];
    for (var x = from; x <= d; x = add(x, 1)) if (m[x]) { xs.push(diff(from, x)); ys.push(m[x]); }
    var span = xs.length ? xs[xs.length - 1] - xs[0] : 0;
    var readyOn = skip ? add(skip, 6) : null;
    if (xs.length < 6 || span < 6) return { ready: false, n: xs.length, from: from, readyOn: readyOn && readyOn > d ? readyOn : add(d, 6 - span) };
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length, my = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var num = 0, den = 0;
    for (var i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    return { ready: true, n: xs.length, from: from, rate: r1(num / den * 7) };
  }

  /** Bewertung der Rate gegen den Korridor der Phase. */
  function verdict(r, phase, d, phases) {
    if (!phase || !phase.rate) return null;
    var lo = phase.rate[0], hi = phase.rate[1];
    if (!r || !r.ready) return { key: 'early', tone: 'neutral', in: null, text: 'Die erste Woche einer Phase ist vor allem Wasser, darum bewertet Kompass sie nicht. Ein Urteil gibt es ab ' + WT[wday(r.readyOn)] + ', ' + dm(r.readyOn) };
    var v = r.rate, cut = hi <= 0;
    var nx = nextPhase(phases, d), soon = nx && diff(d, nx.start) <= 7 ? ' Die nächste Phase startet ohnehin in ' + diff(d, nx.start) + ' Tagen.' : '';
    var far = (v - hi > Math.abs(hi)) || (lo - v > Math.abs(lo)) ? 'Deutlich' : 'Etwas';
    if (v > hi) return { key: cut ? (v > 0 ? 'gain' : 'slow') : 'fast', tone: 'warn', in: false, text: cut
      ? (v > 0 ? 'Du nimmst gerade zu statt ab. Bleibt das eine Woche so, 100 bis 150 kcal weniger.' + soon : far + ' langsamer abgenommen als geplant. Bleibt das zwei Wochen so, 100 bis 150 kcal weniger.' + soon)
      : far + ' schneller zugenommen als geplant. Das wäre ein Signal für 100 bis 150 kcal weniger.' + soon };
    if (v < lo) return { key: cut ? 'fast' : 'slow', tone: 'warn', in: false, text: cut
      ? far + ' schneller abgenommen als geplant. Bleibt das zwei Wochen so, 100 bis 150 kcal mehr, damit die Muskeln bleiben.'
      : 'Langsamer zugenommen als geplant. Bleibt das zwei Wochen so, 100 bis 150 kcal mehr.' };
    return { key: 'ok', tone: 'good', in: true, text: 'Genau im Korridor. So weitermachen.' };
  }

  /** Abstand zum Zielpfad: Wochentiefstwert gegen den Plan von heute. Negativ heißt: vor dem Plan. */
  function track(m, phase, d) {
    var p = path(phase, m); if (!p) return null;
    var low = weekLow(m, d), plan = planAt(p, d);
    var delta = low ? r1(low.kg - plan) : null;
    return { path: p, low: low, plan: r1(plan), delta: delta, tageBis: diff(d, p.anlassDatum), wocheNr: Math.floor(diff(phase.start, d) / 7) + 1 };
  }
  function trackText(t) {
    if (!t || t.delta == null) return '';
    if (Math.abs(t.delta) < 0.25) return 'Du liegst genau auf dem Plan.';
    return t.delta < 0 ? 'Du liegst ' + nf(-t.delta) + ' kg vor dem Plan.' : 'Du liegst ' + nf(t.delta) + ' kg hinter dem Plan.';
  }

  /* ---------- Kalender ---------- */
  function eventsOn(events, d, art) { return (events || []).filter(function (e) { return e.s <= d && e.e >= d && (!art || e.art === art); }); }
  /** Nächste Feier ab heute bis in drei Tagen, mit Abstand in Tagen. */
  function nextFeier(events, d) {
    var o = null;
    (events || []).forEach(function (e) { if (e.art === 'feier' && e.e >= d && e.s <= add(d, 3) && (!o || e.s < o.s)) o = e; });
    return o ? { t: o.t, s: o.s, in: Math.max(0, diff(d, o.s)) } : null;
  }
  /** Gestern oder vorgestern gefeiert? Dann ist ein Sprung auf der Waage Wasser. */
  function afterFeier(events, d) {
    var o = null;
    (events || []).forEach(function (e) { if (e.art === 'feier' && e.e < d && e.e >= add(d, -2)) o = e; });
    return o ? { t: o.t, e: o.e, ago: diff(o.e, d) } : null;
  }
  var FEIER = {
    vorher: 'Tagsüber eiweißreich und eher leicht essen, die Kohlenhydrate sparst du dir für den Abend auf. Vor dem Losgehen eine Portion Eiweiß, dann greifst du am Buffet weniger zu. Alkohol begrenzen und zwischendurch Wasser trinken.',
    danach: 'Die Waage zeigt heute und morgen mehr. Das ist Wasser und Salz, kein Fett. Iss ganz normal nach Plan weiter, nichts einsparen.',
  };

  /* ---------- Wochenrückblick ---------- */
  /**
   * Fasst die Woche ab Montag mon zusammen.
   * o = { weights, phases, sessions, days, umfang, events, meals }  (meals = Mahlzeiten im Plan)
   */
  function week(o, mon) {
    var m = kgMap(o.weights), sun = add(mon, 6), prev = add(mon, -7);
    var phase = phaseAt(o.phases, sun);
    var ses = (o.sessions || []).filter(function (s) { return s.d >= mon && s.d <= sun; });
    var kraft = ses.filter(function (s) { return /^[AB]/.test(s.plan); }).length;
    var sport = ses.filter(function (s) { return /^[FL]/.test(s.plan); });
    var days = (o.days || []).filter(function (x) { return x.date >= mon && x.date <= sun; });
    var logged = days.filter(function (x) { return x.n > 0 || x.kcalExtra > 0 || x.plan; }).length;
    var onPlan = days.filter(function (x) { return (x.plan || (o.meals && x.n >= o.meals)) && (x.kcalExtra || 0) <= 150; }).length;
    var extra = days.reduce(function (a, x) { return a + (x.kcalExtra || 0); }, 0);
    var feiern = (o.events || []).filter(function (e) { return e.art === 'feier' && e.s <= sun && e.e >= mon; }).map(function (e) { return e.t; });
    var tr = track(m, phase, sun), r = rate(m, phase, sun), v = verdict(r, phase, sun, o.phases);
    var u = (o.umfang || []).filter(function (x) { return x[0] <= sun; }).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
    var bauch = null;
    if (u.length && u[u.length - 1][0] >= mon) { var cur = u[u.length - 1], before = u.length > 1 ? u[u.length - 2] : null; bauch = { cm: cur[1], delta: before ? r1(cur[1] - before[1]) : null }; }
    var avg = weekAvg(m, mon, sun), pavg = weekAvg(m, prev, add(prev, 6));
    var tipp;
    if (kraft < 2) tipp = kraft === 0 ? 'Keine einzige Krafteinheit. Leg dir zwei feste Termine, etwa Montag und Donnerstag. Das ist in der Diät dein wichtigster Hebel, damit die Muskeln bleiben.' : 'Nur eine Krafteinheit. Plan die zweite fest ein, zum Beispiel Donnerstag. Bei wenig Zeit reicht die Kurzfassung.';
    else if (v && v.key !== 'ok' && v.key !== 'early') tipp = v.text;
    else if (logged < 5) tipp = 'Trag das Essen an mindestens fünf Tagen ein. Sonst sieht man nicht, ob es am Plan liegt oder an der Umsetzung.';
    else if (extra > 1500) tipp = 'Die Extras summieren sich auf ' + Math.round(extra / 100) * 100 + ' kcal. Das ist fast ein ganzer Tag. Bei Feiern vorher leichter essen hilft.';
    else tipp = 'Eine runde Woche. Genau so weiter.';
    return {
      von: mon, bis: sun, schnitt: avg != null ? r1(avg) : null, vorwoche: pavg != null ? r1(pavg) : null,
      tief: tr && tr.low ? tr.low.kg : null, plan: tr ? tr.plan : null, delta: tr ? tr.delta : null,
      rate: r.ready ? r.rate : null, urteil: v ? v.key : null,
      kraft: kraft, fussball: sport.filter(function (s) { return s.plan[0] === 'F'; }).length, laufen: sport.filter(function (s) { return s.plan[0] === 'L'; }).length,
      essenTage: logged, planTage: onPlan, extraKcal: Math.round(extra), feiern: feiern, bauch: bauch, tipp: tipp,
    };
  }
  function weekText(w) {
    var a = ['Wochenrückblick ' + dm(w.von) + ' bis ' + dm(w.bis)];
    if (w.schnitt != null) a.push('Gewicht: Schnitt ' + nf(w.schnitt) + ' kg' + (w.vorwoche != null ? ' (' + sg(w.schnitt - w.vorwoche) + ' zur Vorwoche)' : '') + (w.tief != null ? ', Tiefstwert ' + nf(w.tief) + ' kg' : '') + '.');
    if (w.delta != null) a.push('Plan: ' + nf(w.plan) + ' kg. ' + (Math.abs(w.delta) < 0.25 ? 'Genau im Plan.' : w.delta < 0 ? nf(-w.delta) + ' kg vor dem Plan.' : nf(w.delta) + ' kg hinter dem Plan.'));
    var sp = [];
    if (w.fussball) sp.push(w.fussball + ' × Fußball');
    if (w.laufen) sp.push(w.laufen + ' × Laufen');
    a.push('Training: ' + w.kraft + ' von 2 Krafteinheiten' + (sp.length ? ', dazu ' + sp.join(' und ') : '') + '.');
    a.push('Essen: an ' + w.essenTage + ' von 7 Tagen eingetragen, ' + w.planTage + ' davon nach Plan' + (w.extraKcal ? ', Extras ' + w.extraKcal + ' kcal' : '') + '.');
    if (w.bauch) a.push('Bauchumfang: ' + nf(w.bauch.cm) + ' cm' + (w.bauch.delta != null ? ' (' + sg(w.bauch.delta) + ')' : '') + '.');
    a.push(w.tipp);
    return a.join('\n');
  }

  /* ---------- Zustand für das Haus (Telegram, Wandtablet) ---------- */
  /** o wie bei week, dazu today, day (heutiger Tag aus App_Tage) und sessions mit Datum. */
  function status(o) {
    var d = o.today, m = kgMap(o.weights), phase = phaseAt(o.phases, d);
    var t = track(m, phase, d), r = rate(m, phase, d), v = verdict(r, phase, d, o.phases);
    var mon = monday(d);
    var kraftW = (o.sessions || []).filter(function (s) { return /^[AB]/.test(s.plan) && s.d >= mon && s.d <= d; });
    var kraftAll = (o.sessions || []).filter(function (s) { return /^[AB]/.test(s.plan) && s.d <= d; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    var last = kraftAll.length ? kraftAll[kraftAll.length - 1] : null;
    var nextType = last && last.plan[0] === 'A' ? 'B' : 'A';
    var heuteSport = (o.sessions || []).filter(function (s) { return s.d === d; });
    var fussball = eventsOn(o.events, d, 'fussball').length > 0 || heuteSport.some(function (s) { return s.plan[0] === 'F'; });
    var day = o.day || null, essenOffen = !day || !(day.n > 0 || day.kcalExtra > 0 || day.plan);
    var feier = nextFeier(o.events, d), nach = afterFeier(o.events, d);
    var seit = last ? diff(last.d, d) : null;
    var faellig = kraftW.length < 2 && !heuteSport.length && !fussball && (seit == null || seit >= 2) && wday(d) !== 0;
    var s = {
      heute: d, phase: phase ? phase.name : '', woche: t ? t.wocheNr : null,
      gewicht: m[d] || null, tief: t && t.low ? t.low.kg : null, plan: t ? t.plan : null, delta: t ? t.delta : null,
      ziel: t ? t.path.kg : null, start: t ? t.path.pts[0][1] : null, anlass: t ? t.path.anlass : '', tageBis: t ? t.tageBis : null,
      rate: r.ready ? r.rate : null, urteil: v ? v.key : null, urteilText: v ? v.text : '',
      kraftWoche: kraftW.length, letzteKraft: last ? last.d : null, naechste: nextType, trainingFaellig: faellig,
      fussballHeute: fussball, essenOffen: essenOffen, feier: feier, nachFeier: nach,
    };
    s.text = texts(s, o);
    return s;
  }
  function texts(s, o) {
    var morgen = [];
    if (s.gewicht) morgen.push('Guten Morgen. Heute ' + nf(s.gewicht) + ' kg' + (s.tief != null && s.tief !== s.gewicht ? ', Wochentief ' + nf(s.tief) + ' kg' : '') + '.');
    if (s.delta != null) morgen.push('Plan für heute: ' + nf(s.plan) + ' kg. ' + trackText({ delta: s.delta }));
    if (s.nachFeier) morgen.push(FEIER.danach);
    if (s.feier && s.feier.in === 0) morgen.push('Heute ' + s.feier.t + '. ' + FEIER.vorher);
    else if (s.feier && s.feier.in === 1) morgen.push('Morgen ' + s.feier.t + '. ' + FEIER.vorher);
    if (s.fussballHeute) morgen.push('Heute ist Fußball, das zählt als Trainingstag.');
    if (s.tageBis != null && s.tageBis > 0) morgen.push('Noch ' + s.tageBis + ' Tage bis ' + (s.anlass || 'zum Ziel') + '.');
    var kn = s.naechste === 'A' ? 'Ganzkörper A' : 'Ganzkörper B';
    return {
      morgen: morgen.join(' '),
      abend: 'Dein Essen für heute ist noch offen. Ein Tipp auf „Alles wie geplant“ reicht, Abweichungen schreibst du dazu.',
      training: 'Diese Woche ' + s.kraftWoche + ' von 2 Krafteinheiten' + (s.letzteKraft ? ', die letzte am ' + dm(s.letzteKraft) : '.') + ' Heute würde ' + kn + ' passen. Wenig Zeit? Die Kurzfassung dauert etwa 30 Minuten.',
    };
  }

  return {
    add: add, diff: diff, monday: monday, wday: wday, nf: nf, sg: sg, dm: dm, r1: r1,
    kgMap: kgMap, phaseAt: phaseAt, nextPhase: nextPhase,
    path: path, planAt: planAt, weekLow: weekLow, weekAvg: weekAvg,
    rate: rate, verdict: verdict, track: track, trackText: trackText,
    eventsOn: eventsOn, nextFeier: nextFeier, afterFeier: afterFeier, FEIER: FEIER,
    week: week, weekText: weekText, status: status,
  };
})();
if (typeof module !== 'undefined') module.exports = Coach;
