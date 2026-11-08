/*
 * Otimizador PVRP (Periodic Vehicle Routing Problem) — ALNS + busca local.
 * Autocontido: roda dentro de um Web Worker (criado via Blob a partir de SolverFactory.toString())
 * ou no Node, para testes.
 *
 * Problema P:
 *  n               nº de locais (0 = garagem)
 *  dist, time      Float64Array n*n  (km, minutos) — podem ser assimétricas
 *  D, V            nº de dias úteis no horizonte, nº de veículos
 *  dayNum          Int32Array D      (nº do dia corrido de cada dia útil, para calcular intervalos)
 *  vehicles        [{capacity (kg), costPerKm (R$), maxMin (jornada em min, inclui volta à garagem), baseMin (min fixos na garagem por rota)}]
 *  avail           Uint8Array D*V    (1 = veículo disponível no dia)
 *  tasks           [{loc, dem, svc, options:[[d,...],...], allowedV:[0|1..], prevOpt, changePen,
 *                    chainPrev, chainNext, gapMin, gapMax, targetOpt, init:{opt, v:[], ord:[]}|null}]
 *  params          {Pcap, Ptime, Pun, Pgap, timeLimitMs, maxIter, seed}
 */
function SolverFactory() {
  'use strict';

  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  // ------------------------------------------------------------------------------------------
  // Estado da solução
  // ------------------------------------------------------------------------------------------
  function createState(P) {
    const { n, dist, time, D, V, vehicles, avail, tasks, dayNum } = P;
    const prm = P.params;
    const NT = tasks.length;
    const routes = new Array(D * V);
    for (let d = 0; d < D; d++) for (let v = 0; v < V; v++)
      routes[d * V + v] = { d, v, stops: [], dist: 0, time: 0, load: 0, cost: 0 };
    const dayVer = new Int32Array(D);
    const opt = new Int32Array(NT).fill(-1);
    const vis = new Array(NT).fill(null);   // visitas atuais da tarefa: [{t, loc, dem, svc, r}]
    const lost = new Int32Array(NT);        // visitas perdidas (dia sem veículo) da opção atual

    const cacheC = new Float64Array(NT * D);
    const cacheV = new Int8Array(NT * D);
    const cacheP = new Int16Array(NT * D);
    const cacheVer = new Int32Array(NT * D).fill(-1);

    function rcost(v, dd, tt, ll) {
      const veh = vehicles[v];
      let c = dd * veh.costPerKm;
      if (ll > veh.capacity) c += (ll - veh.capacity) * prm.Pcap;
      if (tt > veh.maxMin) c += (tt - veh.maxMin) * prm.Ptime;
      // balanceamento: rota acima da jornada-alvo custa um pouco (incentiva dividir o trabalho entre os veículos)
      if (veh.softMin && tt > veh.softMin) c += (Math.min(tt, veh.maxMin) - veh.softMin) * (prm.Pfolga || 0);
      return c;
    }

    function evalRoute(rt) {
      let a = 0, dsum = 0, tsum = 0, load = 0;
      const st = rt.stops;
      for (let i = 0; i < st.length; i++) {
        const s = st[i];
        dsum += dist[a * n + s.loc]; tsum += time[a * n + s.loc] + s.svc; load += s.dem; a = s.loc;
      }
      dsum += dist[a * n]; tsum += time[a * n];
      if (st.length) tsum += vehicles[rt.v].baseMin || 0;   // carga/descarga na garagem
      rt.dist = dsum; rt.time = tsum; rt.load = load; rt.cost = rcost(rt.v, dsum, tsum, load);
    }

    // Melhor inserção de um ponto (x, dem, svc) no dia d. Resultado em insBest/insV/insP.
    let insBest = 0, insV = -1, insP = -1;
    function bestDayInsLoc(x, dem, svc, allowedV, d) {
      let best = Infinity, bv = -1, bp = -1;
      for (let v = 0; v < V; v++) {
        if (!avail[d * V + v] || !allowedV[v]) continue;
        const rt = routes[d * V + v];
        const st = rt.stops, L = st.length;
        let a = 0;
        for (let p = 0; p <= L; p++) {
          const b = p < L ? st[p].loc : 0;
          const dd = dist[a * n + x] + dist[x * n + b] - dist[a * n + b];
          const dt = time[a * n + x] + time[x * n + b] - time[a * n + b] + svc + (L === 0 ? (vehicles[v].baseMin || 0) : 0);
          const c = rcost(v, rt.dist + dd, rt.time + dt, rt.load + dem) - rt.cost;
          if (c < best) { best = c; bv = v; bp = p; }
          a = b;
        }
      }
      insBest = best; insV = bv; insP = bp;
      return best;
    }

    function dayIns(t, d) {
      const k = t * D + d;
      if (cacheVer[k] === dayVer[d]) { insBest = cacheC[k]; insV = cacheV[k]; insP = cacheP[k]; return insBest; }
      const T = tasks[t];
      bestDayInsLoc(T.loc, T.dem, T.svc, T.allowedV, d);
      cacheC[k] = insBest; cacheV[k] = insV; cacheP[k] = insP; cacheVer[k] = dayVer[d];
      return insBest;
    }

    function dayOf(t) { return tasks[t].options[opt[t]][0]; }

    function gapPair(tEarly, dEarly, tLate, dLate) {
      const TL = tasks[tLate];
      const g = dayNum[dLate] - dayNum[dEarly];
      let viol = 0;
      if (g < TL.gapMin) viol += TL.gapMin - g;
      if (g > TL.gapMax) viol += g - TL.gapMax;
      return viol * prm.Pgap;
    }

    function gapPenFor(t, d) {
      const T = tasks[t];
      let c = 0;
      if (T.chainPrev >= 0 && opt[T.chainPrev] >= 0) c += gapPair(T.chainPrev, dayOf(T.chainPrev), t, d);
      if (T.chainNext >= 0 && opt[T.chainNext] >= 0) c += gapPair(t, d, T.chainNext, dayOf(T.chainNext));
      return c;
    }

    function optCost(t, o) {
      const T = tasks[t];
      const days = T.options[o];
      let c = 0;
      for (let i = 0; i < days.length; i++) {
        const ci = dayIns(t, days[i]);
        c += (ci === Infinity) ? prm.Pun : ci;
      }
      if (T.prevOpt >= 0 && o !== T.prevOpt) c += T.changePen;
      if (T.optPen) c += T.optPen[o];
      if (days.length === 1 && (T.chainPrev >= 0 || T.chainNext >= 0)) c += gapPenFor(t, days[0]);
      return c;
    }

    function unassignedCost(t) { return prm.Pun * Math.max(1, tasks[t].options[0] ? avgLen(t) : 1); }
    function avgLen(t) { const o = tasks[t].options; return o.length ? o[0].length : 1; }

    // --- undo log (para rejeitar movimentos do recozimento simulado) ---
    let undoR = new Map(), undoT = new Map();
    function touchR(r) {
      if (!undoR.has(r)) { const rt = routes[r]; undoR.set(r, { stops: rt.stops.slice(), dist: rt.dist, time: rt.time, load: rt.load, cost: rt.cost }); }
    }
    function touchT(t) { if (!undoT.has(t)) undoT.set(t, { opt: opt[t], vis: vis[t], lost: lost[t] }); }
    function commit() { undoR = new Map(); undoT = new Map(); }
    function revert() {
      for (const [r, s] of undoR) {
        const rt = routes[r];
        rt.stops = s.stops; rt.dist = s.dist; rt.time = s.time; rt.load = s.load; rt.cost = s.cost;
        dayVer[rt.d]++;
      }
      for (const [t, s] of undoT) { opt[t] = s.opt; vis[t] = s.vis; lost[t] = s.lost; }
      commit();
    }

    function insertVisitAt(t, d, v, pos) {
      const T = tasks[t];
      const r = d * V + v;
      touchR(r);
      const vObj = { t, loc: T.loc, dem: T.dem, svc: T.svc, r };
      routes[r].stops.splice(pos, 0, vObj);
      evalRoute(routes[r]);
      dayVer[d]++;
      return vObj;
    }

    // Insere a tarefa t na opção o, na melhor posição de cada dia.
    function insertTask(t, o) {
      touchT(t);
      const days = tasks[t].options[o];
      const list = [];
      let lostN = 0;
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        const c = dayIns(t, d);
        if (c === Infinity) { lostN++; continue; }
        list.push(insertVisitAt(t, d, insV, insP));
      }
      opt[t] = o; vis[t] = list; lost[t] = lostN;
    }

    function removeTask(t) {
      if (opt[t] < 0) return;
      touchT(t);
      const list = vis[t];
      for (let i = 0; i < list.length; i++) {
        const vo = list[i];
        touchR(vo.r);
        const rt = routes[vo.r];
        const idx = rt.stops.indexOf(vo);
        if (idx >= 0) { rt.stops.splice(idx, 1); evalRoute(rt); dayVer[rt.d]++; }
      }
      opt[t] = -1; vis[t] = null; lost[t] = 0;
    }

    // --- custo total ---
    function totalCost() {
      let c = 0;
      for (let r = 0; r < routes.length; r++) c += routes[r].cost;
      for (let t = 0; t < NT; t++) {
        const T = tasks[t];
        if (!T.options.length) continue;
        if (opt[t] < 0) { c += unassignedCost(t); continue; }
        c += lost[t] * prm.Pun;
        if (T.prevOpt >= 0 && opt[t] !== T.prevOpt) c += T.changePen;
        if (T.optPen) c += T.optPen[opt[t]];
        if (T.chainPrev >= 0 && opt[T.chainPrev] >= 0) c += gapPair(T.chainPrev, dayOf(T.chainPrev), t, dayOf(t));
      }
      return c;
    }

    // --- busca local intra-rota: 2-opt e or-opt com avaliação O(1) (válida p/ matriz assimétrica) ---
    const fwdD = new Float64Array(512), revD = new Float64Array(512), fwdT = new Float64Array(512), revT = new Float64Array(512);
    const nodes = new Int32Array(512);
    function improveRoute(r) {
      const rt = routes[r];
      if (rt.stops.length < 2) return false;
      let changed = false;
      for (let guard = 0; guard < 200; guard++) {
        const st = rt.stops, L = st.length;
        nodes[0] = 0; for (let i = 0; i < L; i++) nodes[i + 1] = st[i].loc; nodes[L + 1] = 0;
        fwdD[0] = revD[0] = fwdT[0] = revT[0] = 0;
        for (let m = 0; m <= L; m++) {
          const a = nodes[m], b = nodes[m + 1];
          fwdD[m + 1] = fwdD[m] + dist[a * n + b]; revD[m + 1] = revD[m] + dist[b * n + a];
          fwdT[m + 1] = fwdT[m] + time[a * n + b]; revT[m + 1] = revT[m] + time[b * n + a];
        }
        const base = rt.cost;
        let found = false;
        // 2-opt: inverte nodes[i..j]
        for (let i = 1; i < L && !found; i++) {
          for (let j = i + 1; j <= L; j++) {
            const a = nodes[i - 1], ni = nodes[i], nj = nodes[j], b = nodes[j + 1];
            const dd = dist[a * n + nj] + (revD[j] - revD[i]) + dist[ni * n + b] - (dist[a * n + ni] + (fwdD[j] - fwdD[i]) + dist[nj * n + b]);
            const dt = time[a * n + nj] + (revT[j] - revT[i]) + time[ni * n + b] - (time[a * n + ni] + (fwdT[j] - fwdT[i]) + time[nj * n + b]);
            if (rcost(rt.v, rt.dist + dd, rt.time + dt, rt.load) < base - 1e-7) {
              touchR(r);
              const seg = rt.stops.slice(i - 1, j).reverse();
              rt.stops.splice(i - 1, j - i + 1, ...seg);
              found = true; break;
            }
          }
        }
        // or-opt: move segmento nodes[i..j] (até 3 pontos) para entre nodes[k] e nodes[k+1]
        for (let len = 1; len <= 3 && !found; len++) {
          for (let i = 1; i + len - 1 <= L && !found; i++) {
            const j = i + len - 1;
            const p = nodes[i - 1], q = nodes[j + 1], ni = nodes[i], nj = nodes[j];
            const remD = dist[p * n + q] - dist[p * n + ni] - dist[nj * n + q];
            const remT = time[p * n + q] - time[p * n + ni] - time[nj * n + q];
            const inD = fwdD[j] - fwdD[i], inRD = revD[j] - revD[i];
            const inT = fwdT[j] - fwdT[i], inRT = revT[j] - revT[i];
            for (let k = 0; k <= L; k++) {
              if (k >= i - 1 && k <= j) continue;
              const x = nodes[k], y = nodes[k + 1];
              const baseD = remD - dist[x * n + y], baseT = remT - time[x * n + y];
              // normal
              let dd = baseD + dist[x * n + ni] + dist[nj * n + y];
              let dt = baseT + time[x * n + ni] + time[nj * n + y];
              let rev = false;
              let ok = rcost(rt.v, rt.dist + dd, rt.time + dt, rt.load) < base - 1e-7;
              if (!ok && len > 1) {
                dd = baseD + dist[x * n + nj] + inRD - inD + dist[ni * n + y];
                dt = baseT + time[x * n + nj] + inRT - inT + time[ni * n + y];
                ok = rcost(rt.v, rt.dist + dd, rt.time + dt, rt.load) < base - 1e-7;
                rev = true;
              }
              if (ok) {
                touchR(r);
                const seg = rt.stops.splice(i - 1, len);
                if (rev) seg.reverse();
                const insAt = k < i - 1 ? k : k - len;
                rt.stops.splice(insAt, 0, ...seg);
                found = true; break;
              }
            }
          }
        }
        if (!found) break;
        evalRoute(rt); dayVer[rt.d]++; changed = true;
      }
      return changed;
    }

    // --- troca entre veículos do mesmo dia (relocate inter-rotas) ---
    function interRelocateDay(d) {
      if (V < 2) return;
      let improved = true, guard = 0;
      while (improved && guard++ < 30) {
        improved = false;
        for (let v1 = 0; v1 < V && !improved; v1++) {
          const r1 = d * V + v1, rt1 = routes[r1];
          for (let i = 0; i < rt1.stops.length && !improved; i++) {
            const s = rt1.stops[i];
            const T = tasks[s.t];
            const a = i > 0 ? rt1.stops[i - 1].loc : 0, b = i < rt1.stops.length - 1 ? rt1.stops[i + 1].loc : 0;
            const dd = dist[a * n + b] - dist[a * n + s.loc] - dist[s.loc * n + b];
            const dt = time[a * n + b] - time[a * n + s.loc] - time[s.loc * n + b] - s.svc - (rt1.stops.length === 1 ? (vehicles[v1].baseMin || 0) : 0);
            const gain = rt1.cost - rcost(v1, rt1.dist + dd, rt1.time + dt, rt1.load - s.dem);
            for (let v2 = 0; v2 < V; v2++) {
              if (v2 === v1 || !avail[d * V + v2] || !T.allowedV[v2]) continue;
              const rt2 = routes[d * V + v2];
              const st = rt2.stops; let aa = 0;
              for (let p = 0; p <= st.length; p++) {
                const bb = p < st.length ? st[p].loc : 0;
                const ed = dist[aa * n + s.loc] + dist[s.loc * n + bb] - dist[aa * n + bb];
                const et = time[aa * n + s.loc] + time[s.loc * n + bb] - time[aa * n + bb] + s.svc + (st.length === 0 ? (vehicles[v2].baseMin || 0) : 0);
                const c = rcost(v2, rt2.dist + ed, rt2.time + et, rt2.load + s.dem) - rt2.cost;
                if (c < gain - 1e-7) {
                  touchR(r1); touchR(d * V + v2); touchT(s.t);
                  rt1.stops.splice(i, 1); evalRoute(rt1);
                  const nvo = { t: s.t, loc: s.loc, dem: s.dem, svc: s.svc, r: d * V + v2 };
                  vis[s.t] = vis[s.t].map(x => (x === s ? nvo : x));
                  rt2.stops.splice(p, 0, nvo); evalRoute(rt2);
                  dayVer[d]++; improved = true; break;
                }
                aa = bb;
              }
              if (improved) break;
            }
          }
        }
      }
    }

    function snapshot() {
      return { routes: routes.map(rt => rt.stops.map(s => s.t)), opt: opt.slice(), lost: lost.slice() };
    }
    function restore(snap) {
      for (let r = 0; r < routes.length; r++) routes[r].stops = [];
      for (let t = 0; t < NT; t++) { opt[t] = snap.opt[t]; vis[t] = opt[t] >= 0 ? [] : null; lost[t] = snap.lost[t]; }
      for (let r = 0; r < routes.length; r++) {
        const rt = routes[r];
        for (const t of snap.routes[r]) {
          const T = tasks[t];
          const vo = { t, loc: T.loc, dem: T.dem, svc: T.svc, r };
          rt.stops.push(vo); vis[t].push(vo);
        }
        evalRoute(rt); dayVer[rt.d]++;
      }
      commit();
    }

    return {
      P, routes, opt, vis, lost, dayVer, rcost, evalRoute, bestDayInsLoc, dayIns, optCost, unassignedCost,
      insertTask, removeTask, insertVisitAt, totalCost, improveRoute, interRelocateDay, touchR, touchT, commit, revert,
      snapshot, restore, getIns: () => ({ c: insBest, v: insV, p: insP }), undoRoutes: () => undoR, dayOf,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Construção da solução inicial (warm start a partir do plano anterior, se houver)
  // ------------------------------------------------------------------------------------------
  function buildInitial(S, rand) {
    const P = S.P, tasks = P.tasks, V = P.V;
    // 1) coloca as visitas do plano anterior exatamente como estavam
    const perRoute = new Map();
    for (let t = 0; t < tasks.length; t++) {
      const T = tasks[t];
      if (!T.init || T.init.opt < 0 || T.init.opt >= T.options.length) continue;
      const days = T.options[T.init.opt];
      S.opt[t] = T.init.opt; S.vis[t] = []; S.lost[t] = 0;
      for (let i = 0; i < days.length; i++) {
        const v = T.init.v ? T.init.v[i] : -1;
        const d = days[i];
        if (v >= 0 && P.avail[d * V + v] && T.allowedV[v]) {
          const r = d * V + v;
          if (!perRoute.has(r)) perRoute.set(r, []);
          perRoute.get(r).push({ t, ord: T.init.ord ? T.init.ord[i] : 0 });
        } else {
          (T._pending || (T._pending = [])).push(d);
        }
      }
    }
    for (const [r, list] of perRoute) {
      list.sort((a, b) => a.ord - b.ord);
      const rt = S.routes[r];
      for (const it of list) {
        const T = tasks[it.t];
        const vo = { t: it.t, loc: T.loc, dem: T.dem, svc: T.svc, r };
        rt.stops.push(vo); S.vis[it.t].push(vo);
      }
      S.evalRoute(rt); S.dayVer[rt.d]++;
    }
    // dias do plano anterior que ficaram sem veículo (ex.: veículo quebrou): insere na melhor posição
    for (let t = 0; t < tasks.length; t++) {
      const T = tasks[t];
      if (!T._pending) continue;
      for (const d of T._pending) {
        const c = S.dayIns(t, d);
        if (c === Infinity) { S.lost[t]++; continue; }
        const g = S.getIns();
        S.vis[t].push(S.insertVisitAt(t, d, g.v, g.p));
      }
      delete T._pending;
    }
    S.commit();
    // 2) demais tarefas: inserção gulosa, mais restritas primeiro
    const rest = [];
    for (let t = 0; t < tasks.length; t++) if (S.opt[t] < 0 && tasks[t].options.length) rest.push(t);
    rest.sort((a, b) => (tasks[b].options[0].length - tasks[a].options[0].length) || (tasks[a].options.length - tasks[b].options.length) || (rand() - 0.5));
    for (const t of rest) greedyInsertOne(S, t);
    S.commit();
    for (let r = 0; r < S.routes.length; r++) S.improveRoute(r);
    for (let d = 0; d < P.D; d++) S.interRelocateDay(d);
    for (let r = 0; r < S.routes.length; r++) S.improveRoute(r);
    S.commit();
  }

  function greedyInsertOne(S, t) {
    const T = S.P.tasks[t];
    let best = S.unassignedCost(t), bo = -1;
    for (let o = 0; o < T.options.length; o++) {
      const c = S.optCost(t, o);
      if (c < best) { best = c; bo = o; }
    }
    if (bo >= 0) S.insertTask(t, bo);
  }

  // ------------------------------------------------------------------------------------------
  // Operadores ALNS
  // ------------------------------------------------------------------------------------------
  function prepNeighbors(P) {
    const { n, dist } = P;
    const K = Math.min(40, n - 1);
    const nbr = new Array(n);
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    for (let i = 0; i < n; i++) {
      const arr = idx.filter(j => j !== i && j !== 0);
      arr.sort((a, b) => (dist[i * n + a] + dist[a * n + i]) - (dist[i * n + b] + dist[b * n + i]));
      nbr[i] = arr.slice(0, K);
    }
    const locTasks = new Array(n);
    for (let i = 0; i < n; i++) locTasks[i] = [];
    P.tasks.forEach((T, t) => locTasks[T.loc].push(t));
    return { nbr, locTasks };
  }

  function solveSync(P, hooks) {
    hooks = hooks || {};
    const prm = P.params;
    const rand = makeRng(prm.seed || 12345);
    const t0 = now();
    const S = createState(P);
    buildInitial(S, rand);
    const tInit = now() - t0;
    const NB = prepNeighbors(P);
    const tasks = P.tasks, NT = tasks.length;

    let cur = S.totalCost();
    let best = cur, bestSnap = S.snapshot();
    const initialCost = cur;
    const history = [[Math.round(now() - t0), best]];

    const destroyOps = ['aleatoria', 'relacionada', 'rota', 'pior', 'cadeia', 'penalizadas'];
    const repairOps = ['gulosa', 'arrependimento'];
    const wD = destroyOps.map(() => 1), wR = repairOps.map(() => 1);
    const sD = destroyOps.map(() => 0), sR = repairOps.map(() => 0);
    const cD = destroyOps.map(() => 0), cR = repairOps.map(() => 0);
    function pick(w) { let s = 0; for (const x of w) s += x; let r = rand() * s; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; } return w.length - 1; }

    const assignedList = () => { const a = []; for (let t = 0; t < NT; t++) if (S.opt[t] >= 0) a.push(t); return a; };
    const movable = [];
    for (let t = 0; t < NT; t++) if (tasks[t].options.length > 0) movable.push(t);

    const qMin = Math.min(4, movable.length), qMax = Math.max(qMin, Math.min(40, Math.ceil(movable.length * 0.08)));
    const T0 = Math.max(1, 0.03 * cur / Math.log(2)), Tend = T0 / 2000;
    const limit = prm.timeLimitMs || 10000, maxIter = prm.maxIter || 1e9;
    let iter = 0, lastProg = now(), stopped = false;
    let ultMelhoraIter = 0, ultMelhoraT = now(), reinicios = 0;
    // perturbação forte a partir da melhor solução: retira cadeias inteiras de ~15% dos clientes e reconstrói
    function reiniciar() {
      S.restore(bestSnap); cur = best;
      const alvo = Math.ceil(movable.length * 0.15), removed = new Set();
      while (removed.size < alvo) { for (const t of cadeia(movable[(rand() * movable.length) | 0])) if (S.opt[t] >= 0) removed.add(t); }
      const arr = [...removed]; for (const t of arr) S.removeTask(t);
      repair(rand() < 0.5 ? 0 : 1, arr.concat(semAlocacao().filter(t => !removed.has(t))));
      for (const r of new Set([...S.undoRoutes().keys()])) S.improveRoute(r);
      S.commit(); cur = S.totalCost();
      if (cur < best - 1e-6) { best = cur; bestSnap = S.snapshot(); history.push([Math.round(now() - t0), best]); }
      reinicios++; ultMelhoraIter = iter; ultMelhoraT = now();
    }

    // cadeia de visitas do mesmo cliente (periodicidade): do primeiro ao último elemento
    function cadeia(t) {
      let h = t; while (tasks[h].chainPrev >= 0) h = tasks[h].chainPrev;
      const out = []; for (let x = h; x >= 0; x = tasks[x].chainNext) out.push(x);
      return out;
    }
    function penalizada(t) {
      const T = tasks[t];
      if (S.opt[t] < 0) return true;
      if (T.optPen && T.optPen[S.opt[t]] > 0) return true;
      if (S.lost[t] > 0) return true;
      if (T.chainPrev >= 0 && S.opt[T.chainPrev] >= 0) {
        const g = P.dayNum[S.dayOf(t)] - P.dayNum[S.dayOf(T.chainPrev)];
        if (g < T.gapMin || g > T.gapMax) return true;
      }
      return false;
    }
    function semAlocacao() { const a = []; for (const t of movable) if (S.opt[t] < 0) a.push(t); return a.length > 12 ? a.sort(() => rand() - 0.5).slice(0, 12) : a; }
    function listaPenalizadas() { const a = []; for (const t of movable) if (penalizada(t)) a.push(t); return a; }
    // acrescenta tarefas vizinhas (no mapa) que estão nos mesmos dias, para abrir espaço
    function vizinhasNosDias(t, dias, removed, limite) {
      const sl = tasks[t].loc;
      for (const loc of NB.nbr[sl]) {
        if (removed.size >= limite) return;
        for (const u of NB.locTasks[loc]) {
          if (removed.size >= limite) return;
          if (S.opt[u] < 0 || !tasks[u].options.length) continue;
          if (dias.has(S.dayOf(u)) && rand() < 0.6) removed.add(u);
        }
      }
    }

    function destroy(op, q) {
      const removed = new Set();
      if (op === 4 || op === 5) {
        const pen = listaPenalizadas();
        const sementes = [];
        if (op === 5 && pen.length) { for (let k = 0; k < Math.max(1, q / 6) && pen.length; k++) sementes.push(pen.splice((rand() * pen.length) | 0, 1)[0]); }
        else if (op === 4) sementes.push(pen.length && rand() < 0.7 ? pen[(rand() * pen.length) | 0] : movable[(rand() * movable.length) | 0]);
        else sementes.push(movable[(rand() * movable.length) | 0]);
        for (const sd of sementes) {
          const ch = op === 4 ? cadeia(sd) : [tasks[sd].chainPrev, sd, tasks[sd].chainNext].filter(x => x >= 0);
          const dias = new Set();
          for (const t of ch) { if (S.opt[t] >= 0) { removed.add(t); for (const d of tasks[t].options[S.opt[t]]) dias.add(d); } for (const o of tasks[t].options) for (const d of o) if (o.length === 1) dias.add(d); }
          vizinhasNosDias(sd, dias, removed, removed.size + Math.max(3, q / sementes.length));
        }
      } else if (op === 0) {
        for (let k = 0; k < q * 3 && removed.size < q; k++) { const t = movable[(rand() * movable.length) | 0]; if (S.opt[t] >= 0) removed.add(t); }
      } else if (op === 1) {
        const al = assignedList(); if (!al.length) return [];
        const seed = al[(rand() * al.length) | 0];
        const sl = tasks[seed].loc;
        const sd = S.dayOf(seed);
        removed.add(seed);
        const cand = [];
        for (const loc of NB.nbr[sl]) {
          for (const t of NB.locTasks[loc]) {
            if (S.opt[t] < 0 || !tasks[t].options.length) continue;
            const dd = Math.abs(P.dayNum[S.dayOf(t)] - P.dayNum[sd]);
            if (dd > 10) continue;
            cand.push([t, P.dist[sl * P.n + loc] + dd * 1.5]);
          }
        }
        cand.sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < cand.length && removed.size < q; i++) if (rand() < 0.8) removed.add(cand[i][0]);
      } else if (op === 2) {
        const nonEmpty = S.routes.filter(rt => rt.stops.length);
        if (!nonEmpty.length) return [];
        const rt = nonEmpty[(rand() * nonEmpty.length) | 0];
        const st = rt.stops.slice();
        const take = Math.min(st.length, Math.max(q, 3));
        const start = (rand() * st.length) | 0;
        for (let i = 0; i < take; i++) { const s = st[(start + i) % st.length]; if (tasks[s.t].options.length) removed.add(s.t); }
      } else {
        const sav = [];
        for (const rt of S.routes) {
          const st = rt.stops;
          for (let i = 0; i < st.length; i++) {
            const s = st[i];
            if (tasks[s.t].options[0].length !== 1) continue;
            const a = i > 0 ? st[i - 1].loc : 0, b = i < st.length - 1 ? st[i + 1].loc : 0;
            const dd = P.dist[a * P.n + b] - P.dist[a * P.n + s.loc] - P.dist[s.loc * P.n + b];
            const dt = P.time[a * P.n + b] - P.time[a * P.n + s.loc] - P.time[s.loc * P.n + b] - s.svc;
            sav.push([s.t, rt.cost - S.rcost(rt.v, rt.dist + dd, rt.time + dt, rt.load - s.dem)]);
          }
        }
        sav.sort((a, b) => b[1] - a[1]);
        while (removed.size < q && sav.length) {
          const k = Math.floor(Math.pow(rand(), 3) * sav.length);
          removed.add(sav[k][0]); sav.splice(k, 1);
        }
      }
      const arr = [...removed];
      for (const t of arr) S.removeTask(t);
      return arr;
    }

    function repair(op, list) {
      if (op === 0) {
        list.sort((a, b) => (tasks[b].options[0].length - tasks[a].options[0].length) || (tasks[a].options.length - tasks[b].options.length) || (rand() - 0.5));
        for (const t of list) greedyInsertOne(S, t);
      } else {
        let rem = list.slice();
        while (rem.length) {
          let bt = -1, bReg = -Infinity, bo = -1, bi = -1;
          for (let i = 0; i < rem.length; i++) {
            const t = rem[i], T = tasks[t];
            let c1 = S.unassignedCost(t), c2 = Infinity, o1 = -1;
            for (let o = 0; o < T.options.length; o++) {
              const c = S.optCost(t, o);
              if (c < c1) { c2 = c1; c1 = c; o1 = o; } else if (c < c2) c2 = c;
            }
            const reg = (c2 === Infinity ? 1e6 : c2 - c1);
            if (reg > bReg) { bReg = reg; bt = t; bo = o1; bi = i; }
          }
          if (bo >= 0) S.insertTask(bt, bo);
          rem.splice(bi, 1);
        }
      }
    }

    // "Dividir rota": passa um setor (metade das paradas, por ângulo em relação à garagem) de uma rota longa
    // para um veículo livre no mesmo dia. Inserir visita a visita nunca chega aqui, porque a primeira
    // visita no veículo parado paga sozinha a ida e volta à garagem.
    function splitMove() {
      if (!P.coords || P.V < 2) return false;
      const cands = [];
      for (const rt of S.routes) {
        const veh = P.vehicles[rt.v];
        if (rt.stops.length < 6 || rt.time <= (veh.softMin || veh.maxMin) * 0.85) continue;
        for (let v2 = 0; v2 < P.V; v2++) {
          if (v2 === rt.v || !P.avail[rt.d * P.V + v2]) continue;
          const r2 = S.routes[rt.d * P.V + v2];
          if (r2.stops.length === 0) cands.push([rt, r2]);
        }
      }
      if (!cands.length) return false;
      const [r1, r2] = cands[(rand() * cands.length) | 0];
      const dep = P.depot, ang = (s) => Math.atan2(P.coords[s.loc][0] - dep[0], P.coords[s.loc][1] - dep[1]);
      const ord = r1.stops.filter(s => tasks[s.t].allowedV[r2.v]).sort((a, b) => ang(a) - ang(b));
      if (ord.length < 3) return false;
      const k = Math.max(1, Math.round(ord.length * (0.35 + 0.3 * rand())));
      const ini = (rand() * ord.length) | 0;
      const mover = new Set();
      for (let i = 0; i < k; i++) mover.add(ord[(ini + i) % ord.length]);
      const i1 = r1.d * P.V + r1.v, i2 = r2.d * P.V + r2.v;
      S.touchR(i1); S.touchR(i2);
      const fica = [];
      for (const s of r1.stops) {
        if (!mover.has(s)) { fica.push(s); continue; }
        S.touchT(s.t);
        const nvo = { t: s.t, loc: s.loc, dem: s.dem, svc: s.svc, r: i2 };
        S.vis[s.t] = S.vis[s.t].map(x => (x === s ? nvo : x));
        r2.stops.push(nvo);
      }
      r1.stops = fica;
      S.evalRoute(r1); S.evalRoute(r2); S.dayVer[r1.d]++;
      return true;
    }

    // "Mover grupo": muda para OUTRO dia, de uma vez, um grupo de paradas próximas entre si de uma rota
    // (ex.: os clientes de Araxá da mesma viagem). Visita a visita isso nunca compensa, porque a primeira
    // paga sozinha a viagem inteira.
    function moverGrupo() {
      const rts = S.routes.filter(rt => rt.stops.length >= 2);
      if (!rts.length) return false;
      const r1 = rts[(rand() * rts.length) | 0];
      const seedStop = r1.stops[(rand() * r1.stops.length) | 0];
      const T0s = tasks[seedStop.t];
      if (T0s.options[0].length !== 1 || T0s.options.length < 2) return false;
      const outros = T0s.options.map(o => o[0]).filter(d => d !== r1.d);
      if (!outros.length) return false;
      const d2 = outros[(rand() * outros.length) | 0];
      const raio = 3 + rand() * 20; // km
      const grupo = [];
      for (const s of r1.stops) {
        const T = tasks[s.t];
        if (T.options[0].length !== 1) continue;
        if (P.dist[seedStop.loc * P.n + s.loc] > raio) continue;
        const o = T.options.findIndex(op => op[0] === d2);
        if (o >= 0) grupo.push([s.t, o]);
      }
      if (grupo.length < 2) return false;
      for (const [t] of grupo) S.removeTask(t);
      for (const [t, o] of grupo) S.insertTask(t, o);
      return true;
    }

    function step() {
      iter++;
      const q = qMin + ((rand() * (qMax - qMin + 1)) | 0);
      let dOp = -1, rOp = -1;
      const u = rand();
      if (!((u < 0.08 && splitMove()) || (u >= 0.08 && u < 0.2 && moverGrupo()))) {
        dOp = pick(wD); rOp = pick(wR);
        const removed = destroy(dOp, q);
        // visitas sem alocação nunca eram reconsideradas: entram em toda reconstrução
        for (const t of semAlocacao()) if (!removed.includes(t)) removed.push(t);
        repair(rOp, removed);
      }
      const touched = new Set([...S.undoRoutes().keys()]);
      const days = new Set();
      for (const r of touched) days.add(S.routes[r].d);
      for (const d of days) S.interRelocateDay(d);
      for (const r of new Set([...S.undoRoutes().keys()])) S.improveRoute(r);
      const nc = S.totalCost();
      const el = now() - t0;
      const Tm = T0 * Math.pow(Tend / T0, Math.min(1, el / limit));
      let score = 0;
      if (nc < best - 1e-6) {
        best = nc; cur = nc; S.commit(); bestSnap = S.snapshot(); score = 33;
        history.push([Math.round(el), best]); ultMelhoraIter = iter; ultMelhoraT = now();
      } else if (nc < cur - 1e-6) { cur = nc; S.commit(); score = 9; }
      else if (rand() < Math.exp(-(nc - cur) / Tm)) { cur = nc; S.commit(); score = 13; }
      else S.revert();
      if (dOp >= 0) { sD[dOp] += score; sR[rOp] += score; cD[dOp]++; cR[rOp]++; }
      // estagnou (sem melhorar o melhor por um bom tempo): recomeça perturbando a melhor solução
      if (iter - ultMelhoraIter > 1500 && now() - ultMelhoraT > Math.max(5000, 0.06 * limit) && limit - (now() - t0) > 5000) reiniciar();
      if (iter % 100 === 0) {
        for (let i = 0; i < wD.length; i++) { if (cD[i]) wD[i] = Math.max(0.1, 0.8 * wD[i] + 0.2 * sD[i] / cD[i]); sD[i] = 0; cD[i] = 0; }
        for (let i = 0; i < wR.length; i++) { if (cR[i]) wR[i] = Math.max(0.1, 0.8 * wR[i] + 0.2 * sR[i] / cR[i]); sR[i] = 0; cR[i] = 0; }
      }
    }

    function finish() {
      S.restore(bestSnap);
      const res = report(S);
      res.stats = { iter, ms: Math.round(now() - t0), initMs: Math.round(tInit), initialCost, history, stopped, reinicios };
      return res;
    }

    // Execução em fatias (permite ao worker receber "parar" e reportar progresso)
    return {
      runSlice(sliceMs) {
        const ts = now();
        while (now() - ts < sliceMs) {
          if (!movable.length) return true;
          if (iter >= maxIter || now() - t0 >= limit) return true;
          step();
        }
        if (hooks.progress && now() - lastProg > 250) {
          lastProg = now();
          hooks.progress({ iter, ms: Math.round(now() - t0), best, cur, limit });
        }
        return iter >= maxIter || now() - t0 >= limit;
      },
      stop() { stopped = true; },
      melhor() { return { cost: best, snap: bestSnap }; },
      // adota uma solução melhor vinda de outra rodada (mesmo problema) e continua dela
      adotar(snap, custo) {
        if (!(custo < best - 1e-6)) return false;
        S.restore(snap); cur = custo; best = custo; bestSnap = snap; ultMelhoraIter = iter; ultMelhoraT = now();
        history.push([Math.round(now() - t0), best]); return true;
      },
      finish,
    };
  }

  function report(S) {
    const P = S.P, tasks = P.tasks;
    const routes = S.routes.map(rt => ({
      d: rt.d, v: rt.v, tasks: rt.stops.map(s => s.t),
      km: rt.dist, min: rt.time, load: rt.load, cost: rt.cost,
      fuel: rt.dist * P.vehicles[rt.v].costPerKm,
      overMin: Math.max(0, rt.time - P.vehicles[rt.v].maxMin),
      overKg: Math.max(0, rt.load - P.vehicles[rt.v].capacity),
      acimaAlvo: P.vehicles[rt.v].softMin ? Math.max(0, Math.min(rt.time, P.vehicles[rt.v].maxMin) - P.vehicles[rt.v].softMin) : 0,
    }));
    let km = 0, fuel = 0, overMin = 0, overKg = 0;
    for (const r of routes) { km += r.km; fuel += r.fuel; overMin += r.overMin; overKg += r.overKg; }
    const unassigned = [], changed = [], gapIssues = [], late = [];
    let lostVisits = 0;
    for (let t = 0; t < tasks.length; t++) {
      const T = tasks[t];
      if (!T.options.length) continue;
      if (S.opt[t] < 0) { unassigned.push(t); continue; }
      lostVisits += S.lost[t];
      if (T.prevOpt >= 0 && S.opt[t] !== T.prevOpt) changed.push(t);
      if (T.optPen && T.optPen[S.opt[t]] > 0) late.push(t);
      if (T.chainPrev >= 0 && S.opt[T.chainPrev] >= 0) {
        const g = P.dayNum[S.dayOf(t)] - P.dayNum[S.dayOf(T.chainPrev)];
        if (g < T.gapMin || g > T.gapMax) gapIssues.push({ t, gap: g });
      }
    }
    return { routes, opt: Array.from(S.opt), km, fuel, overMin, overKg, unassigned, changed, gapIssues, late, lostVisits, cost: S.totalCost() };
  }

  // Avalia o custo de encaixar candidatos (ex.: cliente novo) no plano atual, sem reotimizar.
  function evaluateCandidates(P, candidates) {
    const rand = makeRng(P.params.seed || 1);
    const S = createState(P);
    buildInitial(S, rand);
    const out = [];
    for (const c of candidates) {
      let tot = 0, km = 0, ok = true;
      const where = [];
      for (const d of c.days) {
        const x = S.bestDayInsLoc(c.loc, c.dem, c.svc, c.allowedV, d);
        if (x === Infinity) { ok = false; break; }
        const g = S.getIns();
        const rt = S.routes[d * P.V + g.v];
        const prevLoc = g.p > 0 ? rt.stops[g.p - 1].loc : 0, nextLoc = g.p < rt.stops.length ? rt.stops[g.p].loc : 0;
        km += P.dist[prevLoc * P.n + c.loc] + P.dist[c.loc * P.n + nextLoc] - P.dist[prevLoc * P.n + nextLoc];
        tot += x;
        where.push({ d, v: g.v, pos: g.p, prevTask: g.p > 0 ? rt.stops[g.p - 1].t : -1, nextTask: g.p < rt.stops.length ? rt.stops[g.p].t : -1 });
      }
      out.push({ ok, cost: tot, km, where });
    }
    return out;
  }

  // Referência "sem otimização": cada visita na data-alvo, veículos divididos por setor angular
  // e sequência pelo vizinho mais próximo (imita uma montagem manual razoável).
  function baseline(P) {
    const { n, dist, D, V, avail, tasks, vehicles } = P;
    const S = createState(P);
    const byDay = Array.from({ length: D }, () => []);
    for (let t = 0; t < tasks.length; t++) {
      const T = tasks[t];
      if (!T.options.length) continue;
      const o = T.targetOpt >= 0 ? T.targetOpt : 0;
      for (const d of T.options[o]) byDay[d].push(t);
    }
    const depLat = P.depot ? P.depot[0] : 0, depLng = P.depot ? P.depot[1] : 0;
    let km = 0, fuel = 0, cost = 0, overMin = 0;
    for (let d = 0; d < D; d++) {
      const vs = []; for (let v = 0; v < V; v++) if (avail[d * V + v]) vs.push(v);
      if (!vs.length || !byDay[d].length) continue;
      const items = byDay[d].map(t => ({ t, ang: P.coords ? Math.atan2(P.coords[tasks[t].loc][0] - depLat, P.coords[tasks[t].loc][1] - depLng) : 0 }));
      items.sort((a, b) => a.ang - b.ang);
      const per = Math.ceil(items.length / vs.length);
      for (let k = 0; k < vs.length; k++) {
        const chunk = items.slice(k * per, (k + 1) * per).map(x => x.t);
        const rt = S.routes[d * V + vs[k]];
        let cur = 0; const left = chunk.slice();
        while (left.length) {
          let bi = 0, bd = Infinity;
          for (let i = 0; i < left.length; i++) { const dd = dist[cur * n + tasks[left[i]].loc]; if (dd < bd) { bd = dd; bi = i; } }
          const t = left.splice(bi, 1)[0];
          rt.stops.push({ t, loc: tasks[t].loc, dem: tasks[t].dem, svc: tasks[t].svc, r: d * V + vs[k] });
          cur = tasks[t].loc;
        }
        S.evalRoute(rt);
        S.improveRoute(d * V + vs[k]);
        km += rt.dist; fuel += rt.dist * vehicles[rt.v].costPerKm; cost += rt.cost; overMin += Math.max(0, rt.time - vehicles[rt.v].maxMin);
      }
    }
    return { km, fuel, cost, overMin };
  }

  // Sequencia uma única rota (usado ao confirmar o dia): inserção mais barata + 2-opt/or-opt.
  function sequenceRoute(P, locs, dems, svcs, v) {
    const tasks = locs.map((loc, i) => ({ loc, dem: dems[i], svc: svcs[i], options: [[0]], allowedV: P.vehicles.map((_, k) => (k === v ? 1 : 0)), prevOpt: -1, changePen: 0, chainPrev: -1, chainNext: -1, gapMin: 0, gapMax: 1e9 }));
    const Q = Object.assign({}, P, { D: 1, tasks, avail: new Uint8Array(P.V).fill(1), dayNum: new Int32Array(1), params: Object.assign({}, P.params, { Pun: 1e9 }) });
    const S = createState(Q);
    for (let t = 0; t < tasks.length; t++) S.insertTask(t, 0);
    S.improveRoute(v);
    S.commit();
    const rt = S.routes[v];
    return { order: rt.stops.map(s => s.t), km: rt.dist, min: rt.time, load: rt.load };
  }

  async function solveAsync(P, hooks) {
    const run = solveSync(P, hooks);
    for (;;) {
      const done = run.runSlice(60);
      if (done) break;
      if (hooks && hooks.shouldStop && hooks.shouldStop()) { run.stop(); break; }
      await new Promise(r => setTimeout(r, 0));
    }
    return run.finish();
  }

  return { solveSync, solveAsync, evaluateCandidates, baseline, sequenceRoute, makeRng };
}

// Bootstrap do Web Worker (quando carregado como worker via Blob)
function SolverWorkerMain(self) {
  const S = SolverFactory();
  let stopFlag = false, runAtual = null;
  function revive(P) {
    P.dist = new Float64Array(P.dist); P.time = new Float64Array(P.time);
    P.avail = new Uint8Array(P.avail); P.dayNum = new Int32Array(P.dayNum);
    return P;
  }
  self.onmessage = async (e) => {
    const m = e.data;
    try {
      if (m.type === 'stop') { stopFlag = true; return; }
      // cooperação entre rodadas paralelas: informar a melhor solução / adotar a melhor de outra rodada
      if (m.type === 'melhor') { if (runAtual) { const b = runAtual.melhor(); self.postMessage({ type: 'melhor', cost: b.cost, snap: b.snap }); } return; }
      if (m.type === 'adotar') { if (runAtual) runAtual.adotar(m.snap, m.cost); return; }
      if (m.type === 'solve') {
        stopFlag = false;
        const P = revive(m.problem);
        const base = S.baseline(P);
        const run = runAtual = S.solveSync(P, { progress: (p) => self.postMessage({ type: 'progress', id: m.id, ...p }) });
        for (;;) {
          if (run.runSlice(60)) break;
          if (stopFlag) { run.stop(); break; }
          await new Promise(r => setTimeout(r, 0));
        }
        const res = run.finish();
        runAtual = null;
        res.baseline = base;
        self.postMessage({ type: 'done', id: m.id, result: res });
      } else if (m.type === 'evaluate') {
        const P = revive(m.problem);
        self.postMessage({ type: 'done', id: m.id, result: S.evaluateCandidates(P, m.candidates) });
      } else if (m.type === 'sequence') {
        const P = revive(m.problem);
        self.postMessage({ type: 'done', id: m.id, result: S.sequenceRoute(P, m.locs, m.dems, m.svcs, m.v) });
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
    }
  };
}

if (typeof module !== 'undefined') module.exports = { SolverFactory };
