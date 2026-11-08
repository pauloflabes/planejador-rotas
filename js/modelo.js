/*
 * Modelo de dados: datas/feriados, dados fictícios, matriz de distâncias e
 * montagem do problema PVRP a partir do estado da aplicação.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- datas
  const MS_DIA = 86400000;
  function dnum(s) { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / MS_DIA); }
  function dstr(n) { const dt = new Date(n * MS_DIA); return dt.toISOString().slice(0, 10); }
  function wday(n) { return new Date(n * MS_DIA).getUTCDay(); } // 0=dom
  const DIAS_SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function fmtCurto(s) { const n = dnum(s); const [y, m, d] = s.split('-'); return `${DIAS_SEM[wday(n)]} ${d}/${m}`; }
  function fmtData(s) { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; }

  function pascoa(ano) {
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return dnum(`${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`);
  }

  function feriadosPadrao(anos) {
    const out = [];
    for (const ano of anos) {
      const fixos = [['01-01', 'Confraternização Universal'], ['04-21', 'Tiradentes'], ['05-01', 'Dia do Trabalho'],
        ['09-07', 'Independência'], ['10-12', 'N. Sra. Aparecida'], ['11-02', 'Finados'], ['11-15', 'Proclamação da República'],
        ['11-20', 'Consciência Negra'], ['12-25', 'Natal']];
      for (const [md, nome] of fixos) out.push({ data: `${ano}-${md}`, nome, cidade: '' });
      const p = pascoa(ano);
      out.push({ data: dstr(p - 48), nome: 'Carnaval (ponto facultativo)', cidade: '' });
      out.push({ data: dstr(p - 47), nome: 'Carnaval (ponto facultativo)', cidade: '' });
      out.push({ data: dstr(p - 2), nome: 'Sexta-feira Santa', cidade: '' });
      out.push({ data: dstr(p + 60), nome: 'Corpus Christi', cidade: '' });
      out.push({ data: `${ano}-05-02`, nome: 'Aniversário de Uberaba (conferir calendário municipal)', cidade: 'Uberaba' });
    }
    return out.sort((a, b) => a.data.localeCompare(b.data));
  }

  // ---------------------------------------------------------------- frequências
  const FREQ = {
    '2x': { nome: '2x por semana', intervalo: 3.5, tol: 0 },
    semanal: { nome: 'Semanal', intervalo: 7, tol: 1 },
    quinzenal: { nome: 'Quinzenal', intervalo: 14, tol: 2 },
    mensal: { nome: 'Mensal', intervalo: 30, tol: 4 },
    bimestral: { nome: 'Bimestral', intervalo: 60, tol: 6 },
    trimestral: { nome: 'Trimestral', intervalo: 91, tol: 7 },
    semestral: { nome: 'Semestral', intervalo: 182, tol: 10 },
    diario: { nome: 'Diário (dias úteis)', intervalo: 1, tol: 0 },
    demanda: { nome: 'Conforme necessidade', intervalo: null, tol: 0 },
  };
  const PADROES_2X = [[1, 4], [2, 5]]; // seg+qui, ter+sex

  // ---------------------------------------------------------------- distâncias
  function haversine(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  // Tempo de deslocamento (min) a partir da distância: os primeiros 10 km na velocidade urbana,
  // o restante na velocidade de rodovia (parâmetros configuráveis).
  function tempoDesloc(km, p) {
    const vu = (p && p.velUrbana) || 35, vr = (p && p.velRodovia) || 70;
    return (Math.min(km, 10) / vu + Math.max(0, km - 10) / vr) * 60;
  }
  // Estimativa por linha reta × fator de desvio.
  function estimativa(a, b, p) {
    const km = haversine(a, b) * ((p && p.fatorDesvio) || 1.35);
    return [km, tempoDesloc(km, p)];
  }
  const precoComb = (v, p) => (v.combustivel === 'diesel' ? p.precoDiesel : p.precoGasolina);
  const servicoDe = (c, p) => (c.servico !== null && c.servico !== undefined && c.servico !== '' ? Number(c.servico) : p.tempoParada);

  // Atualiza estados salvos por versões anteriores (parâmetros novos, combustível, jornada)
  function migrar(st) {
    const p = st.params, d = PARAMS_PADRAO;
    if (p.precoDiesel === undefined) p.precoDiesel = p.diesel !== undefined ? p.diesel : d.precoDiesel;
    delete p.diesel;
    for (const k of Object.keys(d)) if (p[k] === undefined) p[k] = d[k];
    if (!st.migr2) {
      if (p.Ptime <= 2) p.Ptime = d.Ptime;          // jornada passa a ser praticamente rígida
      st.veiculos.forEach(v => { delete v.jornada; });
      st.clientes.forEach(c => { if (c.origem === 'meuResíduo' && c.servico === 8) c.servico = null; });
      st.migr2 = true;
    }
    if (!st.migr3) {  // otimizador mais robusto: até 5 min do zero e 1 min na reotimização diária
      if (p.tempoCompleto < 300) p.tempoCompleto = 300;
      if (p.tempoDiario < 60) p.tempoDiario = 60;
      st.migr3 = true;
    }
    st.veiculos.forEach(v => { if (!v.combustivel) v.combustivel = 'gasolina'; });
    return st;
  }

  // Parâmetros de cálculo (valores padrão). Tempo de parada e velocidade calibrados com as coletas de set–out/2026
  // (≈5,7 min por parada e ≈39 km/h entre paradas; ≈1h20 até Araxá), arredondados para o lado conservador.
  const PARAMS_PADRAO = {
    precoGasolina: 6.39, precoDiesel: 6.29, jornadaH: 7, jornadaAlvoH: 6, Pfolga: 0.5, tempoParada: 6, velUrbana: 35, velRodovia: 85, tempoGaragem: 0,
    aviso: 5, penMudancaProx: 8, penMudancaLonge: 1.5, Pcap: 50, Ptime: 50, Pun: 400, Pgap: 4, Patraso: 150, atrasoMax: 5,
    tempoDiario: 60, tempoCompleto: 300, fatorDesvio: 1.35, seed: 7,
  };

  const GARAGEM = { nome: 'Garagem', endereco: 'Av. Hiroschi Aramaki, 230 — Residencial 2000, Uberaba/MG', lat: -19.77139, lng: -47.88806 };

  function estadoInicial(hoje) {
    hoje = hoje || new Date().toISOString().slice(0, 10);
    const ano = Number(hoje.slice(0, 4));
    return {
      versao: 1,
      atualizadoEm: new Date().toISOString(),
      garagem: Object.assign({}, GARAGEM),
      params: {
        hoje, cidadeBase: 'Uberaba', horizonte: 60, sabado: false, ...PARAMS_PADRAO,
      },
      migr2: true, migr3: true,
      // valores provisórios: ajuste capacidade e consumo em "Frota e eventos"
      veiculos: [
        { id: 'v1_CPN3G98', nome: 'CPN3G98', placa: 'CPN3G98', capacidade: 1500, consumo: 8, combustivel: 'gasolina', tipos: ['saude', 'industrial'] },
        { id: 'v2_RUV0C87', nome: 'RUV0C87', placa: 'RUV0C87', capacidade: 1500, consumo: 8, combustivel: 'gasolina', tipos: ['saude', 'industrial'] },
      ],
      clientes: [],
      feriados: feriadosPadrao([ano, ano + 1]),
      indisponibilidades: [],
      avulsas: [],
      confirmados: {},
      plano: null,
    };
  }

  // ---------------------------------------------------------------- calendário
  function calendario(st) {
    const p = st.params;
    const base = (p.cidadeBase || '').toLowerCase();
    const ferFrota = new Map(), ferCidade = new Map();
    for (const f of st.feriados) {
      const c = (f.cidade || '').trim().toLowerCase();
      if (!c || c === base) ferFrota.set(f.data, f.nome);
      else { if (!ferCidade.has(c)) ferCidade.set(c, new Map()); ferCidade.get(c).set(f.data, f.nome); }
    }
    function diaUtilFrota(s) { const w = wday(dnum(s)); if (w === 0 || (w === 6 && !p.sabado)) return false; return !ferFrota.has(s); }
    function diaUtilCliente(s, cidade) { if (!diaUtilFrota(s)) return false; const m = ferCidade.get((cidade || '').toLowerCase()); return !(m && m.has(s)); }
    function motivo(s) { const w = wday(dnum(s)); if (ferFrota.has(s)) return ferFrota.get(s); if (w === 0) return 'domingo'; if (w === 6 && !p.sabado) return 'sábado'; return ''; }
    return { diaUtilFrota, diaUtilCliente, motivo };
  }

  function ultimoConfirmado(st) {
    const ks = Object.keys(st.confirmados || {}).sort();
    return ks.length ? ks[ks.length - 1] : null;
  }

  // ---------------------------------------------------------------- montagem do problema
  function montarProblema(st, matriz) {
    const p = st.params;
    const cal = calendario(st);
    const hojeN = dnum(p.hoje);
    const uc = ultimoConfirmado(st);
    const ini = Math.max(hojeN, uc ? dnum(uc) : -1) + 1;
    const fim = ini + p.horizonte - 1;
    const dias = [];
    for (let n = ini; n <= fim; n++) if (cal.diaUtilFrota(dstr(n))) dias.push(dstr(n));
    const idxDia = new Map(dias.map((s, i) => [s, i]));
    const D = dias.length;

    const clientes = st.clientes.filter(c => c.ativo && temCoord(c));
    const ids = ['__garagem__'].concat(clientes.map(c => c.id));
    const coords = [[st.garagem.lat, st.garagem.lng]].concat(clientes.map(c => [c.lat, c.lng]));
    const n = ids.length;
    const dist = new Float64Array(n * n), time = new Float64Array(n * n);
    let fonte = 'estimativa', faltantes = 0;
    const mIdx = matriz && matriz.ids ? new Map(matriz.ids.map((x, i) => [x, i])) : null;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let ok = false;
      if (mIdx) {
        const a = mIdx.get(ids[i]), b = mIdx.get(ids[j]);
        if (a !== undefined && b !== undefined && matriz.coords[a][0] === coords[i][0] && matriz.coords[a][1] === coords[i][1]
          && matriz.coords[b][0] === coords[j][0] && matriz.coords[b][1] === coords[j][1]) {
          const k = a * matriz.ids.length + b;
          const dv = matriz.dist[k];
          if (dv >= 0) { dist[i * n + j] = dv; time[i * n + j] = tempoDesloc(dv, p); ok = true; }
        }
      }
      if (!ok) { const e = estimativa(coords[i], coords[j], p); dist[i * n + j] = e[0]; time[i * n + j] = e[1]; faltantes++; }
    }
    if (mIdx) fonte = faltantes === 0 ? 'ruas' : 'misto';

    const V = st.veiculos.length;
    const vehicles = st.veiculos.map(v => ({ capacity: v.capacidade, costPerKm: precoComb(v, p) / v.consumo, maxMin: p.jornadaH * 60, softMin: Math.min(p.jornadaAlvoH || p.jornadaH, p.jornadaH) * 60, baseMin: Number(p.tempoGaragem) || 0 }));
    const avail = new Uint8Array(D * V);
    for (let d = 0; d < D; d++) for (let v = 0; v < V; v++) {
      const vid = st.veiculos[v].id;
      const fora = st.indisponibilidades.some(x => x.veiculoId === vid && dias[d] >= x.de && dias[d] <= x.ate);
      avail[d * V + v] = fora ? 0 : 1;
    }
    const dayNum = new Int32Array(dias.map(dnum));

    // índice do plano anterior: cliente -> [{dia, v, ord}]
    const prevIdx = new Map();
    if (st.plano && st.plano.dias) {
      for (const [dia, rotas] of Object.entries(st.plano.dias)) {
        if (!idxDia.has(dia)) continue;
        rotas.forEach((rt) => {
          const v = st.veiculos.findIndex(x => x.id === rt.veiculoId);
          rt.clientes.forEach((cid, ord) => {
            if (!prevIdx.has(cid)) prevIdx.set(cid, []);
            prevIdx.get(cid).push({ dia, d: idxDia.get(dia), v, ord });
          });
        });
      }
    }

    const tasks = [], meta = [];
    const aviso = p.aviso;
    const locOf = new Map(clientes.map((c, i) => [c.id, i + 1]));
    function mudPen(d) { return d < aviso ? p.penMudancaProx : p.penMudancaLonge; }

    for (const c of clientes) {
      const loc = locOf.get(c.id);
      const allowedV = st.veiculos.map(v => (v.tipos || []).includes(c.tipo) ? 1 : 0);
      if (!allowedV.some(Boolean)) continue;
      const okDia = (s) => cal.diaUtilCliente(s, c.cidade);
      const prev = prevIdx.get(c.id) || [];
      const f = FREQ[c.freq];
      if (!f) continue;
      if (c.freq === 'diario') {
        const ds = dias.map((s, i) => [s, i]).filter(([s]) => okDia(s)).map(x => x[1]);
        if (!ds.length) continue;
        const init = prev.length ? { opt: 0, v: ds.map(d => { const x = prev.find(y => y.d === d); return x ? x.v : -1; }), ord: ds.map(d => { const x = prev.find(y => y.d === d); return x ? x.ord : 0; }) } : null;
        tasks.push({ loc, dem: c.kg, svc: servicoDe(c, p), options: [ds], allowedV, prevOpt: -1, changePen: 0, chainPrev: -1, chainNext: -1, gapMin: 0, gapMax: 1e9, targetOpt: 0, init });
        meta.push({ clienteId: c.id, tipo: 'diario' });
        continue;
      }
      if (c.freq === '2x') {
        const opts = [];
        for (const pad of PADROES_2X) {
          const set = [];
          // percorre semanas (segunda-feira de cada semana)
          let seg = ini - ((wday(ini) + 6) % 7);
          for (; seg <= fim; seg += 7) {
            const usados = new Set();
            const ultimoDiaSem = seg + 4 + (p.sabado ? 1 : 0);
            for (const wd of pad) {
              let nn = seg + wd - 1;
              if (nn < ini || nn > fim) continue;
              // feriado: empurra para o próximo dia útil da mesma semana
              while (nn <= ultimoDiaSem && (!okDia(dstr(nn)) || usados.has(nn))) nn++;
              if (nn > ultimoDiaSem || nn > fim || !idxDia.has(dstr(nn))) continue;
              usados.add(nn);
              set.push(idxDia.get(dstr(nn)));
            }
          }
          opts.push(set.sort((a, b) => a - b));
        }
        const optsNE = opts.filter(o => o.length);
        if (!optsNE.length) continue;
        // opção do plano anterior: a que mais coincide
        let prevOpt = -1, init = null;
        if (prev.length) {
          const sc = optsNE.map(o => o.filter(d => prev.some(x => x.d === d)).length);
          let bi = 0; sc.forEach((s, i) => { if (s > sc[bi]) bi = i; });
          if (sc[bi] > 0) {
            prevOpt = bi;
            init = {
              opt: bi,
              v: optsNE[bi].map(d => { const x = prev.find(y => y.d === d); return x ? x.v : -1; }),
              ord: optsNE[bi].map(d => { const x = prev.find(y => y.d === d); return x ? x.ord : 0; }),
            };
          }
        }
        tasks.push({ loc, dem: c.kg, svc: servicoDe(c, p), options: optsNE, allowedV, prevOpt, changePen: p.penMudancaProx * 3,
          chainPrev: -1, chainNext: -1, gapMin: 0, gapMax: 1e9, targetOpt: 0, init });
        meta.push({ clienteId: c.id, tipo: '2x' });
        continue;
      }
      if (!f.intervalo) continue; // conforme necessidade: só via coleta avulsa
      const I = f.intervalo, tol = (c.tol !== null && c.tol !== undefined && c.tol !== '') ? Number(c.tol) : f.tol;
      // âncora
      let alvos = [];
      if (c.ultimaColeta) {
        let anc = dnum(c.ultimaColeta);
        if (anc + I + tol < ini) anc = ini - I; // atrasado: primeira coleta já no 1º dia
        for (let k = 1; anc + k * I <= fim; k++) alvos.push({ alvo: anc + k * I, tol: k === 1 && anc === ini - I ? Math.max(2, tol) : tol, atrasado: k === 1 && anc === ini - I });
      } else if (c.inicio) {
        const anc = dnum(c.inicio);
        for (let k = 0; anc + k * I <= fim; k++) alvos.push({ alvo: anc + k * I, tol: k === 0 ? 0 : tol });
      } else {
        // sem histórico: primeira coleta nos próximos dias, livre dentro de um intervalo
        for (let k = 0; ini + k * I <= fim; k++) alvos.push({ alvo: ini + Math.min(I, 10) / 2 + k * I, tol: k === 0 ? Math.ceil(Math.min(I, 10) / 2) : tol });
      }
      let prevTask = -1;
      const usadosPrev = new Set();
      for (const a of alvos) {
        const alvo = Math.round(a.alvo);
        let lo = Math.max(alvo - a.tol, ini), hi = Math.min(alvo + a.tol, fim);
        let ds = [];
        const coletar = () => { ds = []; for (let x = lo; x <= hi; x++) { const s = dstr(x); if (okDia(s) && idxDia.has(s)) ds.push(idxDia.get(s)); } };
        coletar();
        for (let ext = 0; !ds.length && ext < 4; ext++) { hi = Math.min(hi + 1, fim); if (ext >= 1) lo = Math.max(lo - 1, ini); coletar(); }
        if (!ds.length) continue;
        // opções de atraso (só usadas se necessário, ex.: veículo parado), com penalidade por dia útil
        const optPen = ds.map(() => 0);
        let extra = 0;
        for (let x = hi + 1; x <= fim && extra < (p.atrasoMax || 0); x++) {
          const s = dstr(x);
          if (okDia(s) && idxDia.has(s)) { extra++; ds.push(idxDia.get(s)); optPen.push(extra * p.Patraso); }
        }
        let targetOpt = 0, bd = 1e9;
        ds.forEach((d, i) => { const dd = Math.abs(dayNum[d] - alvo); if (dd < bd) { bd = dd; targetOpt = i; } });
        // plano anterior
        let prevOpt = -1, init = null;
        let bp = null, bpd = 1e9;
        for (const x of prev) {
          if (usadosPrev.has(x)) continue;
          const i = ds.indexOf(x.d);
          if (i < 0) continue;
          const dd = Math.abs(dayNum[x.d] - alvo);
          if (dd < bpd) { bpd = dd; bp = x; }
        }
        if (bp) { usadosPrev.add(bp); prevOpt = ds.indexOf(bp.d); init = { opt: prevOpt, v: [bp.v], ord: [bp.ord] }; }
        const ti = tasks.length;
        tasks.push({ loc, dem: c.kg, svc: servicoDe(c, p), options: ds.map(d => [d]), allowedV, prevOpt,
          changePen: prevOpt >= 0 ? mudPen(ds[prevOpt]) : 0, chainPrev: prevTask, chainNext: -1,
          gapMin: I - tol, gapMax: I + tol, targetOpt, init, optPen: extra ? optPen : null });
        if (prevTask >= 0) tasks[prevTask].chainNext = ti;
        prevTask = ti;
        meta.push({ clienteId: c.id, tipo: 'periodica', alvo: dstr(alvo), atrasado: !!a.atrasado });
      }
    }

    // coletas avulsas (conforme necessidade / extras)
    for (const av of st.avulsas || []) {
      if (av.status === 'feita') continue;
      const c = st.clientes.find(x => x.id === av.clienteId);
      if (!c || !locOf.has(c.id)) continue;
      const ds = [];
      for (let x = Math.max(dnum(av.de), ini); x <= Math.min(dnum(av.ate), fim); x++) { const s = dstr(x); if (cal.diaUtilCliente(s, c.cidade) && idxDia.has(s)) ds.push(idxDia.get(s)); }
      if (!ds.length) ds.push(0);
      const prev = (prevIdx.get(c.id) || []).find(x => ds.includes(x.d));
      const prevOpt = prev ? ds.indexOf(prev.d) : -1;
      tasks.push({ loc: locOf.get(c.id), dem: Number(av.kg || c.kg), svc: servicoDe(c, p), options: ds.map(d => [d]), allowedV: st.veiculos.map(v => (v.tipos || []).includes(c.tipo) ? 1 : 0),
        prevOpt, changePen: prevOpt >= 0 ? mudPen(ds[prevOpt]) : 0, chainPrev: -1, chainNext: -1, gapMin: 0, gapMax: 1e9, targetOpt: 0,
        init: prev ? { opt: prevOpt, v: [prev.v], ord: [prev.ord] } : null });
      meta.push({ clienteId: c.id, tipo: 'avulsa', avulsaId: av.id });
    }

    const P = {
      n, dist, time, D, V, vehicles, avail, tasks, dayNum, coords, depot: coords[0],
      params: { Pcap: p.Pcap, Ptime: p.Ptime, Pfolga: p.Pfolga, Pun: p.Pun, Pgap: p.Pgap, timeLimitMs: 1000 * p.tempoDiario, seed: p.seed },
    };
    return { P, dias, ids, meta, fonte, faltantes, clientes, locOf };
  }

  // Converte o resultado do otimizador em plano (por data e veículo)
  function aplicarResultado(st, prob, res) {
    const { dias, ids, meta, P } = prob;
    const planoDias = {};
    for (const r of res.routes) {
      const dia = dias[r.d];
      if (!planoDias[dia]) planoDias[dia] = st.veiculos.map(v => ({ veiculoId: v.id, clientes: [], km: 0, min: 0, kg: 0, combustivel: 0 }));
      planoDias[dia][r.v] = { veiculoId: st.veiculos[r.v].id, clientes: r.tasks.map(t => ids[P.tasks[t].loc]), km: r.km, min: r.min, kg: r.load, combustivel: r.fuel, extraMin: r.overMin, extraKg: r.overKg };
    }
    const naoAlocadas = res.unassigned.map(t => ({ clienteId: meta[t].clienteId, janela: [dias[P.tasks[t].options[0][0]], dias[P.tasks[t].options[P.tasks[t].options.length - 1][0]]], tipo: meta[t].tipo }));
    st.plano = {
      geradoEm: new Date().toISOString(), primeiroDia: dias[0], ultimoDia: dias[dias.length - 1], dias: planoDias, naoAlocadas,
      resumo: {
        km: res.km, combustivel: res.fuel, litros: res.routes.reduce((s, r) => s + r.km / st.veiculos[r.v].consumo, 0),
        extraMin: res.overMin, extraKg: res.overKg,
        rotasAcimaAlvo: res.routes.filter(r => r.acimaAlvo > 1).length, rotasUsadas: res.routes.filter(r => r.tasks.length).length, mudancas: res.changed.length, intervalosFora: res.gapIssues.length, atrasadas: (res.late || []).length,
        perdidas: res.lostVisits, visitas: res.routes.reduce((s, r) => s + r.tasks.length, 0), custo: res.cost,
        referencia: res.baseline || null, fonteDistancias: prob.fonte, nDias: dias.length,
      },
      stats: res.stats,
    };
    return st.plano;
  }

  function temCoord(c) { return c && c.lat !== null && c.lng !== null && c.lat !== '' && isFinite(c.lat) && isFinite(c.lng) && Math.abs(c.lat) > 0.01; }

  // Matriz garagem + lista de clientes (para o histórico de rotas reais)
  function matrizIds(st, matriz, idsCli) {
    const mapa = new Map(st.clientes.map(c => [c.id, c]));
    const ids = ['__garagem__'].concat(idsCli);
    const coords = [[st.garagem.lat, st.garagem.lng]].concat(idsCli.map(i => [mapa.get(i).lat, mapa.get(i).lng]));
    const n = ids.length, dist = new Float64Array(n * n), time = new Float64Array(n * n);
    const mIdx = matriz && matriz.ids ? new Map(matriz.ids.map((x, i) => [x, i])) : null;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (mIdx) {
        const a = mIdx.get(ids[i]), b = mIdx.get(ids[j]);
        if (a !== undefined && b !== undefined) { const k = a * matriz.ids.length + b; if (matriz.dist[k] >= 0) { dist[i * n + j] = matriz.dist[k]; time[i * n + j] = tempoDesloc(matriz.dist[k], st.params); continue; } }
      }
      const e = estimativa(coords[i], coords[j], st.params); dist[i * n + j] = e[0]; time[i * n + j] = e[1];
    }
    return { n, dist, time, coords };
  }

  const api = { PARAMS_PADRAO, migrar, tempoDesloc, precoComb, servicoDe, temCoord, matrizIds, dnum, dstr, wday, fmtCurto, fmtData, DIAS_SEM, FREQ, PADROES_2X, feriadosPadrao, haversine, estimativa, estadoInicial, calendario, montarProblema, aplicarResultado, ultimoConfirmado, GARAGEM };
  root.Modelo = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
